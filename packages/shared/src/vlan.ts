/**
 * VLAN configuration extraction.
 *
 * Switch VLAN configuration is largely vendor-neutral: Cisco IOS, YAMAHA SWX
 * and ELECOM EHB all use `vlan <id>` declarations plus Cisco-style
 * `interface <port>` blocks with `switchport ...` membership lines. This
 * module parses both into two flat, listable shapes:
 *   - {@link VlanDefinition}: one per declared VLAN, with the ports assigned to
 *     it (access / tagged / native) derived from the port blocks.
 *   - {@link VlanPort}: one per physical port, with its mode and VLAN membership.
 *
 * Unlike FW / routing / wireless, VLAN extraction is NOT cached to Kintone: the
 * data is small and cheap to recompute on each view, so the page recomputes
 * from the stored body every time (no schema/field changes required).
 *
 * Extraction is structural (keyed off `switchport` / `vlan` syntax) so it works
 * for any switch config that follows this common grammar, regardless of the
 * detected vendor.
 */

import type { VlanDefinition, VlanExtraction, VlanPort } from "./types.js";

/** Expand a VLAN list token like "200-202,210,254" into [200,201,202,210,254].
 *  Ignores non-numeric junk defensively. */
function expandVlanList(spec: string): number[] {
  const out: number[] = [];
  for (const part of spec.split(",")) {
    const range = part.trim().match(/^(\d+)\s*-\s*(\d+)$/);
    if (range) {
      const lo = Number.parseInt(range[1], 10);
      const hi = Number.parseInt(range[2], 10);
      if (lo <= hi && hi - lo < 4096) {
        for (let v = lo; v <= hi; v++) out.push(v);
      }
      continue;
    }
    const single = part.trim().match(/^(\d+)$/);
    if (single) out.push(Number.parseInt(single[1], 10));
  }
  return out;
}

/** Parse `vlan` declarations. Two forms coexist:
 *   - Standalone `vlan 201-202` / `vlan 100` (ELECOM, IOS global): IDs only.
 *   - `vlan database` block with `vlan <id> name <name>` (YAMAHA SWX) or IOS
 *     `vlan <id>` followed by an indented `name <name>` line.
 *  Returns a map of id -> name so port assignments can be merged in later. */
function parseVlanDefinitions(lines: string[]): Map<number, string> {
  const defs = new Map<number, string>();
  let lastId = -1; // for IOS `vlan N` \n ` name X` two-line form

  for (const raw of lines) {
    const line = raw.trim();

    // `vlan 100 name VLAN100` (YAMAHA SWX, single line).
    const named = line.match(/^vlan\s+(\d+)\s+name\s+(.+)$/i);
    if (named) {
      const id = Number.parseInt(named[1], 10);
      defs.set(id, named[2].trim());
      lastId = id;
      continue;
    }

    // `vlan 201-202` / `vlan 100,200` / `vlan 100` (IDs, possibly a range/list).
    const decl = line.match(/^vlan\s+([\d,\s-]+)$/i);
    if (decl) {
      const ids = expandVlanList(decl[1]);
      for (const id of ids) if (!defs.has(id)) defs.set(id, "");
      lastId = ids.length === 1 ? ids[0] : -1;
      continue;
    }

    // IOS indented `name <name>` immediately after a `vlan <id>` line.
    const nameOnly = raw.match(/^\s+name\s+(.+)$/i);
    if (nameOnly && lastId >= 0) {
      defs.set(lastId, nameOnly[1].trim());
      continue;
    }

    // Any other non-blank, non-name line ends the pending IOS `vlan N` context.
    if (line && !/^vlan\s+database$/i.test(line)) lastId = -1;
  }

  return defs;
}

/** Interface names we treat as switch ports across vendors:
 *   - YAMAHA SWX:  port1.1, port1.10
 *   - ELECOM EHB:  xgi1, gi1, fa1
 *   - Cisco IOS:   GigabitEthernet0/1, FastEthernet0/1, TenGigabitEthernet1/0/1,
 *                  Ethernet1, Te1/0/1, Gi0/1
 *  SVIs (`interface vlanN`) are intentionally excluded — they are L3, not ports. */
const PORT_IF_RE =
  /^(port\d+(?:\.\d+)?|xgi\d+(?:\/\d+)*|(?:Gigabit|FastE|TenGigabit|FortyGigabit|HundredGig|TwentyFiveGig)?Ethernet[\d/]+|(?:Gi|Fa|Te|Fo|Hu|Eth)[\d/]+)$/i;

function isPortInterface(name: string): boolean {
  if (/^vlan\d+$/i.test(name)) return false;
  return PORT_IF_RE.test(name);
}

/** Parse `interface <port>` blocks into {@link VlanPort} entries. Recognizes
 *  the common `switchport` grammar shared by Cisco / YAMAHA / ELECOM. */
function parsePorts(lines: string[]): VlanPort[] {
  const ports: VlanPort[] = [];
  let current: VlanPort | null = null;

  const flush = () => {
    if (current) ports.push(current);
    current = null;
  };

  lines.forEach((raw, idx) => {
    const ifM = raw.match(/^\s*interface\s+(\S+)/i);
    if (ifM) {
      flush();
      const name = ifM[1];
      if (isPortInterface(name)) {
        current = {
          vendor: "",
          name,
          mode: "",
          allowedVlans: [],
          description: "",
          line: idx + 1,
        };
      }
      return;
    }
    if (!current) return;
    const line = raw.trim();

    const descM = line.match(/^description\s+(.+)$/i);
    if (descM) {
      current.description = descM[1].trim();
      return;
    }
    const modeM = line.match(/^switchport\s+mode\s+(access|trunk)/i);
    if (modeM) {
      current.mode = modeM[1].toLowerCase();
      return;
    }
    const accessM = line.match(/^switchport\s+access\s+vlan\s+(\d+)/i);
    if (accessM) {
      current.accessVlan = Number.parseInt(accessM[1], 10);
      if (!current.mode) current.mode = "access";
      return;
    }
    const nativeM = line.match(/^switchport\s+trunk\s+native\s+vlan\s+(\d+)/i);
    if (nativeM) {
      current.nativeVlan = Number.parseInt(nativeM[1], 10);
      if (!current.mode) current.mode = "trunk";
      return;
    }
    // `switchport trunk allowed vlan [add] 200-202,210` (Cisco/YAMAHA) — the
    // `add` keyword is optional; multiple lines accumulate.
    const allowedM = line.match(
      /^switchport\s+trunk\s+allowed\s+vlan\s+(?:add\s+)?([\d,\s-]+)/i,
    );
    if (allowedM) {
      for (const v of expandVlanList(allowedM[1])) {
        if (!current.allowedVlans.includes(v)) current.allowedVlans.push(v);
      }
      if (!current.mode) current.mode = "trunk";
    }
  });
  flush();

  for (const p of ports) p.allowedVlans.sort((a, b) => a - b);
  return ports;
}

// ----- Buffalo BS-GS grammar -----

/** Buffalo switches describe VLANs differently from the `switchport` family:
 *  an `interface vlanN` block lists the participating physical ports by number
 *  (`member 1-36`) and which of those are untagged (`untagged 17-19`), while
 *  each physical `interface GigabitEthernet0/N` block carries `PVID <id>`
 *  (its native/untagged VLAN) and a quoted `name`. We map port numbers to
 *  their interface names and reconstruct the common shapes. */
function isBuffaloVlanConfig(lines: string[]): boolean {
  let inVlanIf = false;
  for (const raw of lines) {
    if (/^\s*interface\s+vlan\d+/i.test(raw)) {
      inVlanIf = true;
      continue;
    }
    if (/^\s*interface\s+\S+/i.test(raw)) inVlanIf = false;
    if (inVlanIf && /^\s*member\s+[\d,\s-]+$/i.test(raw)) return true;
    if (/^\s*PVID\s+\d+/i.test(raw)) return true;
  }
  return false;
}

function extractBuffalo(lines: string[], vendor: string): VlanExtraction {
  // Physical ports keyed by port number (GigabitEthernet0/N -> N).
  interface Phys {
    name: string;
    num: number;
    pvid?: number;
    description: string;
    line: number;
  }
  const physByNum = new Map<number, Phys>();
  interface VlanBlock {
    id: number;
    name: string;
    members: Set<number>;
    untagged: Set<number>;
  }
  const vlanBlocks: VlanBlock[] = [];

  let curPhys: Phys | null = null;
  let curVlan: VlanBlock | null = null;

  lines.forEach((raw, idx) => {
    const vlanIfM = raw.match(/^\s*interface\s+vlan(\d+)/i);
    if (vlanIfM) {
      curPhys = null;
      curVlan = {
        id: Number.parseInt(vlanIfM[1], 10),
        name: "",
        members: new Set(),
        untagged: new Set(),
      };
      vlanBlocks.push(curVlan);
      return;
    }
    const physIfM = raw.match(/^\s*interface\s+(\S+)/i);
    if (physIfM) {
      curVlan = null;
      const name = physIfM[1];
      const num = Number.parseInt(name.split("/").pop() ?? "", 10);
      if (Number.isFinite(num)) {
        curPhys = { name, num, description: "", line: idx + 1 };
        physByNum.set(num, curPhys);
      } else {
        curPhys = null;
      }
      return;
    }

    const line = raw.trim();
    if (curVlan) {
      const memberM = line.match(/^member\s+([\d,\s-]+)$/i);
      if (memberM) {
        for (const n of expandVlanList(memberM[1])) curVlan.members.add(n);
        return;
      }
      const untagM = line.match(/^untagged\s+([\d,\s-]+)$/i);
      if (untagM) {
        for (const n of expandVlanList(untagM[1])) curVlan.untagged.add(n);
        return;
      }
      const nameM = line.match(/^name\s+(.+)$/i);
      if (nameM) curVlan.name = nameM[1].trim().replace(/^["']|["']$/g, "");
      return;
    }
    if (curPhys) {
      const pvidM = line.match(/^PVID\s+(\d+)/i);
      if (pvidM) {
        curPhys.pvid = Number.parseInt(pvidM[1], 10);
        return;
      }
      const nameM = line.match(/^name\s+(.+)$/i);
      if (nameM) curPhys.description = nameM[1].trim().replace(/^["']|["']$/g, "");
    }
  });

  const nameOf = (num: number) =>
    physByNum.get(num)?.name ?? `port${num}`;

  // Build ports: tagged = member-not-untagged of each VLAN; untagged drives
  // the access/native VLAN; PVID (when set) is the authoritative native VLAN.
  const ports: VlanPort[] = [...physByNum.values()]
    .sort((a, b) => a.num - b.num)
    .map((p) => {
      const tagged: number[] = [];
      const untaggedIn: number[] = [];
      for (const vb of vlanBlocks) {
        if (!vb.members.has(p.num)) continue;
        if (vb.untagged.has(p.num)) untaggedIn.push(vb.id);
        else tagged.push(vb.id);
      }
      tagged.sort((a, b) => a - b);
      const nativeVlan =
        p.pvid ?? (untaggedIn.length === 1 ? untaggedIn[0] : undefined);
      const isTrunk = tagged.length > 0;
      return {
        vendor,
        name: p.name,
        mode: isTrunk ? "trunk" : untaggedIn.length ? "access" : "",
        accessVlan: !isTrunk && untaggedIn.length === 1 ? untaggedIn[0] : undefined,
        nativeVlan: isTrunk ? nativeVlan : undefined,
        allowedVlans: tagged,
        description: p.description,
        line: p.line,
      } satisfies VlanPort;
    });

  const vlans: VlanDefinition[] = vlanBlocks
    .map((vb) => {
      const tagged = [...vb.members].filter((n) => !vb.untagged.has(n));
      const nativePorts = [...physByNum.values()]
        .filter((p) => p.pvid === vb.id)
        .map((p) => p.name);
      return {
        vendor,
        id: vb.id,
        name: vb.name,
        accessPorts: [...vb.untagged].sort((a, b) => a - b).map(nameOf),
        taggedPorts: tagged.sort((a, b) => a - b).map(nameOf),
        nativePorts,
      } satisfies VlanDefinition;
    })
    .sort((a, b) => a.id - b.id);

  return { vlans, ports };
}

/** Extract VLAN definitions + port membership from a switch config body.
 *  Structural and vendor-neutral: works for the common `vlan` / `switchport`
 *  grammar (Cisco / YAMAHA / ELECOM) and for Buffalo's `member` / `untagged` /
 *  `PVID` grammar. `vendor` is stamped onto results for display. Configs
 *  without any VLAN or switchport statements yield empty lists. */
export function extractVlans(body: string, vendor: string): VlanExtraction {
  if (!body) return { vlans: [], ports: [] };
  const lines = body.replace(/\r\n?/g, "\n").split("\n");
  const v = vendor || "";

  // Buffalo uses a distinct member/untagged/PVID grammar; dispatch to it when
  // detected (either by vendor or structurally).
  if (v === "Buffalo" || isBuffaloVlanConfig(lines)) {
    return extractBuffalo(lines, v || "Buffalo");
  }

  const defMap = parseVlanDefinitions(lines);
  const ports = parsePorts(lines);
  for (const p of ports) p.vendor = v;

  // Ensure VLANs referenced only by ports (never declared) still appear.
  const ensureVlan = (id: number) => {
    if (!defMap.has(id)) defMap.set(id, "");
  };
  for (const p of ports) {
    if (p.accessVlan !== undefined) ensureVlan(p.accessVlan);
    if (p.nativeVlan !== undefined) ensureVlan(p.nativeVlan);
    for (const a of p.allowedVlans) ensureVlan(a);
  }

  const vlans: VlanDefinition[] = [...defMap.entries()]
    .map(([id, name]) => {
      const accessPorts: string[] = [];
      const taggedPorts: string[] = [];
      const nativePorts: string[] = [];
      for (const p of ports) {
        if (p.accessVlan === id) accessPorts.push(p.name);
        if (p.nativeVlan === id) nativePorts.push(p.name);
        if (p.allowedVlans.includes(id)) taggedPorts.push(p.name);
      }
      return {
        vendor: v,
        id,
        name,
        accessPorts,
        taggedPorts,
        nativePorts,
      };
    })
    .sort((a, b) => a.id - b.id);

  return { vlans, ports };
}
