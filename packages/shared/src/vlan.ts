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

/** 有効な VLAN ID の範囲（0 と 4095 は予約）。 */
const VLAN_ID_MIN = 1;
const VLAN_ID_MAX = 4094;

// 範囲外の値を弾かないと、2^53 以上の値で `v++` が値を進めずループが終わらない
// （登録されたコンフィグを閲覧するだけで BFF が停止する DoS になる）。
function isValidVlanId(n: number): boolean {
  return Number.isSafeInteger(n) && n >= VLAN_ID_MIN && n <= VLAN_ID_MAX;
}

/**
 * 1 回の抽出で範囲指定を走査する総回数の上限。`member 1-4094` のような短い
 * 行を大量に並べると、入力の千倍以上の処理が生まれる（増幅型の DoS）。
 * 重複して捨てる ID の走査も数えるので、CPU 時間の上限として効く。
 */
export const MAX_VLAN_EXPANSION = 2_000_000;

/**
 * 抽出結果（JSON 応答）のバイト数の上限。所属件数だけでは、長いポート名を
 * 全 VLAN に複製する入力などで応答が膨らむため、JSON に書き出した際の UTF-8
 * バイト数（エスケープ込み）で見積もる。
 */
export const MAX_VLAN_OUTPUT_BYTES = 16 * 1024 * 1024;

/** VLAN 定義・ポート 1 件あたりのキー名・区切り記号の上界。 */
const RECORD_OVERHEAD_BYTES = 160;
/** 数値 1 つを JSON に書く際の上界（安全な整数の最大桁数 + 区切り）。 */
const NUMBER_BYTES = 24;
/** 検証済み VLAN ID（1〜4094）を配列に書く際のバイト数（"4094,"）。 */
const VLAN_ID_BYTES = 5;

/** 抽出の残り予算。どちらかが尽きたら truncated を立て、以降は追加しない。 */
interface ExpansionBudget {
  work: number;
  outputBytes: number;
  truncated: boolean;
  /** 文字列を JSON に書いた際の UTF-8 バイト数（引用符・区切り込み）。 */
  stringBytes: (s: string) => number;
}

function newExpansionBudget(): ExpansionBudget {
  // 同じポート名が VLAN の数だけ参照されるため、文字列ごとに一度だけ数える。
  const cache = new Map<string, number>();
  return {
    work: MAX_VLAN_EXPANSION,
    outputBytes: MAX_VLAN_OUTPUT_BYTES,
    truncated: false,
    stringBytes: (str) => {
      let bytes = cache.get(str);
      if (bytes === undefined) {
        bytes = jsonStringUtf8Bytes(str) + 1;
        cache.set(str, bytes);
      }
      return bytes;
    },
  };
}

/**
 * JSON.stringify(str) の UTF-8 バイト数。文字数で数えると、制御文字の
 * エスケープ（最大 6 倍）や日本語（3 倍）で実際の応答サイズを過小評価する。
 */
function jsonStringUtf8Bytes(str: string): number {
  let bytes = 2; // 前後の引用符
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c === 0x22 || c === 0x5c) bytes += 2;
    else if (c < 0x20) bytes += 6;
    else if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    // 単独サロゲートは \uXXXX（6 バイト）にエスケープされる。ペアかどうかを
    // 判定せず、サロゲートは常に 6 バイトとして上界を取る。
    else if (c >= 0xd800 && c <= 0xdfff) bytes += 6;
    else bytes += 3;
  }
  return bytes;
}

/** 出力予算から bytes を差し引く。足りなければ truncated を立てて false。 */
function chargeOutput(budget: ExpansionBudget, bytes: number): boolean {
  if (budget.outputBytes < bytes) {
    budget.truncated = true;
    return false;
  }
  budget.outputBytes -= bytes;
  return true;
}

/** 予算内に収まる先頭部分だけを返す。 */
function takeWithinBudget<T>(
  items: Iterable<T>,
  cost: (item: T) => number,
  budget: ExpansionBudget,
): T[] {
  const out: T[] = [];
  for (const item of items) {
    if (!chargeOutput(budget, cost(item))) break;
    out.push(item);
  }
  return out;
}

const idCost = () => VLAN_ID_BYTES;

/** VLAN 定義 1 件（所属一覧を除く）の出力バイト数の上界。 */
function vlanRecordBytes(
  budget: ExpansionBudget,
  vendor: string,
  name: string,
): number {
  return (
    RECORD_OVERHEAD_BYTES +
    NUMBER_BYTES +
    budget.stringBytes(vendor) +
    budget.stringBytes(name)
  );
}

/** ポート 1 件（allowedVlans を除く）の出力バイト数の上界。 */
function portRecordBytes(budget: ExpansionBudget, p: VlanPort): number {
  return (
    RECORD_OVERHEAD_BYTES +
    NUMBER_BYTES * 3 +
    budget.stringBytes(p.vendor) +
    budget.stringBytes(p.name) +
    budget.stringBytes(p.mode) +
    budget.stringBytes(p.description)
  );
}

/** Expand a VLAN list token like "200-202,210,254" into [200,201,202,210,254].
 *  Ignores non-numeric junk and out-of-range IDs defensively. Duplicates are
 *  dropped so one call never yields more than VLAN_ID_MAX entries. */
function expandVlanList(spec: string, budget: ExpansionBudget): number[] {
  const out: number[] = [];
  const seen = new Uint8Array(VLAN_ID_MAX + 1);
  const add = (id: number): boolean => {
    // 重複で捨てる ID の走査も予算に数える（`1-4093` の反復のように、全 ID が
    // 出揃わず早期終了しない入力で CPU を占有させないため）。
    if (budget.work <= 0) {
      budget.truncated = true;
      return false;
    }
    budget.work--;
    if (seen[id]) return true;
    seen[id] = 1;
    out.push(id);
    return true;
  };
  for (const part of spec.split(",")) {
    // 全 ID が出揃ったら残りの指定は何も増やさないので打ち切る。
    if (out.length >= VLAN_ID_MAX) break;
    const range = part.trim().match(/^(\d+)\s*-\s*(\d+)$/);
    if (range) {
      const lo = Number.parseInt(range[1], 10);
      const hi = Number.parseInt(range[2], 10);
      if (isValidVlanId(lo) && isValidVlanId(hi) && lo <= hi) {
        for (let v = lo; v <= hi; v++) if (!add(v)) return out;
      }
      continue;
    }
    const single = part.trim().match(/^(\d+)$/);
    if (single) {
      const id = Number.parseInt(single[1], 10);
      if (isValidVlanId(id) && !add(id)) return out;
    }
  }
  return out;
}

/** Parse `vlan` declarations. Two forms coexist:
 *   - Standalone `vlan 201-202` / `vlan 100` (ELECOM, IOS global): IDs only.
 *   - `vlan database` block with `vlan <id> name <name>` (YAMAHA SWX) or IOS
 *     `vlan <id>` followed by an indented `name <name>` line.
 *  Returns a map of id -> name so port assignments can be merged in later. */
function parseVlanDefinitions(
  lines: string[],
  budget: ExpansionBudget,
): Map<number, string> {
  const defs = new Map<number, string>();
  let lastId = -1; // for IOS `vlan N` \n ` name X` two-line form

  for (const raw of lines) {
    const line = raw.trim();

    // `vlan 100 name VLAN100` (YAMAHA SWX, single line).
    const named = line.match(/^vlan\s+(\d+)\s+name\s+(.+)$/is);
    if (named) {
      const id = Number.parseInt(named[1], 10);
      defs.set(id, named[2].trim());
      lastId = id;
      continue;
    }

    // `vlan 201-202` / `vlan 100,200` / `vlan 100` (IDs, possibly a range/list).
    // 引数を数字始まりにして、`\s+` と一覧の文字クラスが空白を奪い合う
    // 二乗のバックトラッキング（`vlan` + 大量の空白 + 記号）を防ぐ。
    const decl = line.match(/^vlan\s+(\d[\d,\s-]*)$/i);
    if (decl) {
      const ids = expandVlanList(decl[1], budget);
      for (const id of ids) if (!defs.has(id)) defs.set(id, "");
      lastId = ids.length === 1 ? ids[0] : -1;
      continue;
    }

    // IOS indented `name <name>` immediately after a `vlan <id>` line.
    const nameOnly = raw.match(/^\s+name\s+(.+)$/is);
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
function parsePorts(lines: string[], budget: ExpansionBudget): VlanPort[] {
  const ports: VlanPort[] = [];
  let current: VlanPort | null = null;
  // allowedVlans の重複判定用。配列の includes だと 1 行ごとに最大
  // 4094×4094 回の比較になり、`allowed vlan add` の多い行で CPU を占有する。
  let currentAllowed = new Set<number>();

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
        currentAllowed = new Set();
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

    const descM = line.match(/^description\s+(.+)$/is);
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
      /^switchport\s+trunk\s+allowed\s+vlan\s+(?:add\s+)?(\d[\d,\s-]*)/i,
    );
    if (allowedM) {
      for (const v of expandVlanList(allowedM[1], budget)) {
        if (!currentAllowed.has(v)) {
          currentAllowed.add(v);
          current.allowedVlans.push(v);
        }
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
    if (inVlanIf && /^\s*member\s+\d[\d,\s-]*$/i.test(raw)) return true;
    if (/^\s*PVID\s+\d+/i.test(raw)) return true;
  }
  return false;
}

function extractBuffalo(
  lines: string[],
  vendor: string,
  budget: ExpansionBudget,
): VlanExtraction {
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
      const memberM = line.match(/^member\s+(\d[\d,\s-]*)$/i);
      if (memberM) {
        for (const n of expandVlanList(memberM[1], budget)) curVlan.members.add(n);
        return;
      }
      const untagM = line.match(/^untagged\s+(\d[\d,\s-]*)$/i);
      if (untagM) {
        for (const n of expandVlanList(untagM[1], budget)) curVlan.untagged.add(n);
        return;
      }
      const nameM = line.match(/^name\s+(.+)$/is);
      if (nameM) curVlan.name = nameM[1].trim().replace(/^["']|["']$/g, "");
      return;
    }
    if (curPhys) {
      const pvidM = line.match(/^PVID\s+(\d+)/i);
      if (pvidM) {
        curPhys.pvid = Number.parseInt(pvidM[1], 10);
        return;
      }
      const nameM = line.match(/^name\s+(.+)$/is);
      if (nameM) curPhys.description = nameM[1].trim().replace(/^["']|["']$/g, "");
    }
  });

  const nameOf = (num: number) =>
    physByNum.get(num)?.name ?? `port${num}`;

  // VLAN ブロック × 物理ポートの総当たりは両者が多いと二乗で膨らむため、
  // メンバー集合を 1 回だけ走査してポート番号ごとに振り分けておく。
  // 予算が尽きた場合も VLAN 定義そのものは残るよう、所属より先に確保する。
  const keptBlocks = takeWithinBudget(
    vlanBlocks,
    (vb) => vlanRecordBytes(budget, vendor, vb.name),
    budget,
  );
  // ポート本体（名前・description）も、所属より先に予算を確保する。
  const keptPhys = takeWithinBudget(
    [...physByNum.values()].sort((a, b) => a.num - b.num),
    (p) =>
      RECORD_OVERHEAD_BYTES +
      NUMBER_BYTES * 3 +
      budget.stringBytes(vendor) +
      budget.stringBytes(p.name) +
      budget.stringBytes(p.description) +
      budget.stringBytes("access"),
    budget,
  );
  const keptNums = new Set(keptPhys.map((p) => p.num));

  const taggedByNum = new Map<number, number[]>();
  const untaggedByNum = new Map<number, number[]>();
  for (const vb of keptBlocks) {
    for (const n of vb.members) {
      if (!keptNums.has(n)) continue;
      // Buffalo の vb.id は範囲検証していない（`interface vlanN` の N をそのまま
      // 使う）ため、検証済み ID 用の 5 バイトではなく数値の上界で数える。
      if (!chargeOutput(budget, NUMBER_BYTES)) break;
      pushTo(vb.untagged.has(n) ? untaggedByNum : taggedByNum, n, vb.id);
    }
  }
  const nativeByPvid = new Map<number, string[]>();
  for (const p of physByNum.values()) {
    if (p.pvid !== undefined) pushTo(nativeByPvid, p.pvid, p.name);
  }

  // Build ports: tagged = member-not-untagged of each VLAN; untagged drives
  // the access/native VLAN; PVID (when set) is the authoritative native VLAN.
  const ports: VlanPort[] = keptPhys.map((p) => {
    const tagged = taggedByNum.get(p.num) ?? [];
    const untaggedIn = untaggedByNum.get(p.num) ?? [];
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

  // 同じ `interface vlanN` が繰り返されると、ブロックごとに PVID ポート等が
  // 複製されて出力が増幅するため、名前の複製も出力予算に数える。
  const vlans: VlanDefinition[] = keptBlocks
    .map((vb) => {
      const tagged = [...vb.members].filter((n) => !vb.untagged.has(n));
      return {
        vendor,
        id: vb.id,
        name: vb.name,
        accessPorts: takeWithinBudget(
          [...vb.untagged].sort((a, b) => a - b).map(nameOf),
          budget.stringBytes,
          budget,
        ),
        taggedPorts: takeWithinBudget(
          tagged.sort((a, b) => a - b).map(nameOf),
          budget.stringBytes,
          budget,
        ),
        nativePorts: takeWithinBudget(
          nativeByPvid.get(vb.id) ?? [],
          budget.stringBytes,
          budget,
        ),
      } satisfies VlanDefinition;
    })
    .sort((a, b) => a.id - b.id);

  return withTruncation({ vlans, ports }, budget);
}

function pushTo<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function withTruncation(
  extraction: VlanExtraction,
  budget: ExpansionBudget,
): VlanExtraction {
  return budget.truncated ? { ...extraction, truncated: true } : extraction;
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
  const budget = newExpansionBudget();
  if (v === "Buffalo" || isBuffaloVlanConfig(lines)) {
    return extractBuffalo(lines, v || "Buffalo", budget);
  }

  const defMap = parseVlanDefinitions(lines, budget);
  const parsedPorts = parsePorts(lines, budget);
  for (const p of parsedPorts) p.vendor = v;

  // Ensure VLANs referenced only by ports (never declared) still appear.
  const ensureVlan = (id: number) => {
    if (!defMap.has(id)) defMap.set(id, "");
  };
  for (const p of parsedPorts) {
    if (p.accessVlan !== undefined) ensureVlan(p.accessVlan);
    if (p.nativeVlan !== undefined) ensureVlan(p.nativeVlan);
    for (const a of p.allowedVlans) ensureVlan(a);
  }

  // VLAN × ポートの総当たり（さらに allowedVlans.includes）は二乗以上で
  // 膨らむため、ポート側から 1 回だけ走査して VLAN ごとに振り分ける。
  const accessById = new Map<number, string[]>();
  const nativeById = new Map<number, string[]>();
  const taggedById = new Map<number, string[]>();
  // 予算が尽きた場合も VLAN 定義そのものは残るよう、所属より先に確保する。
  const keptDefs = takeWithinBudget(
    defMap.entries(),
    ([, name]) => vlanRecordBytes(budget, v, name),
    budget,
  );
  // ポート本体（名前・description）も、所属より先に予算を確保する。
  const ports = takeWithinBudget(
    parsedPorts,
    (p) => portRecordBytes(budget, p),
    budget,
  );
  for (const p of ports) {
    p.allowedVlans = takeWithinBudget(p.allowedVlans, idCost, budget);
  }

  // ポート名は VLAN ごとに複製されるので、長い名前 × 全 VLAN で応答が
  // 膨らまないよう出力予算に数える。
  const pushName = (map: Map<number, string[]>, id: number, name: string) => {
    if (chargeOutput(budget, budget.stringBytes(name))) pushTo(map, id, name);
  };
  for (const p of ports) {
    if (p.accessVlan !== undefined) pushName(accessById, p.accessVlan, p.name);
    if (p.nativeVlan !== undefined) pushName(nativeById, p.nativeVlan, p.name);
    for (const a of p.allowedVlans) pushName(taggedById, a, p.name);
  }

  const vlans: VlanDefinition[] = keptDefs
    .map(([id, name]) => ({
      vendor: v,
      id,
      name,
      accessPorts: accessById.get(id) ?? [],
      taggedPorts: taggedById.get(id) ?? [],
      nativePorts: nativeById.get(id) ?? [],
    }))
    .sort((a, b) => a.id - b.id);

  return withTruncation({ vlans, ports }, budget);
}
