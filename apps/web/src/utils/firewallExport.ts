import {
  expandFirewallRule,
  firewallCategoryLabel,
  type FirewallRule,
} from "@config-manager/shared";
import { csvEscape } from "./csvEscape";

/** Export firewall rules to an .xlsx workbook with multiple sheets:
 *  - "Rules": the flat rule list
 *  - "Expanded": one row per srcaddr × dstaddr × service combination
 *  - "Matrix": source × destination cross-tab, cells list proto/port (action)
 *  - "NAT Policies": FortiGate NAT policies, when present
 *  - "DoS Policies": FortiGate DoS policies, when present
 *
 *  The `xlsx` library is loaded lazily so it does not bloat the initial bundle.
 */
export async function exportFirewallExcel(
  rules: FirewallRule[],
  filename: string,
  meta?: { hostname?: string; generation?: number; vendor?: string },
): Promise<void> {
  const XLSX = await import("xlsx");
  const wb = XLSX.utils.book_new();

  // ---- Sheet 1: Rules ----
  const wsRules = XLSX.utils.json_to_sheet(rules.map(ruleToRow));
  wsRules["!cols"] = ruleColumns();
  XLSX.utils.book_append_sheet(wb, wsRules, "Rules");

  // ---- Sheet: Expanded (srcaddr × dstaddr × service) ----
  const expanded = rules.flatMap(expandRuleRows);
  const wsExpanded = XLSX.utils.json_to_sheet(expanded);
  wsExpanded["!cols"] = [
    { wch: 4 },
    { wch: 14 },
    { wch: 12 },
    { wch: 28 },
    { wch: 10 },
    { wch: 8 },
    { wch: 28 },
    { wch: 34 },
    { wch: 28 },
    { wch: 6 },
  ];
  XLSX.utils.book_append_sheet(wb, wsExpanded, "Expanded");

  // ---- Sheet 2: Matrix (source × destination) ----
  const sources = dedupe(rules.map((r) => r.source));
  const dests = dedupe(rules.map((r) => r.destination));
  const aoa: (string | number)[][] = [];
  if (meta) {
    aoa.push([
      `Host: ${meta.hostname ?? "-"}  Gen: #${meta.generation ?? "-"}  Vendor: ${meta.vendor ?? "-"}`,
    ]);
  }
  const header = ["Source \\ Destination", ...dests];
  aoa.push(header);
  for (const src of sources) {
    const row: (string | number)[] = [src];
    for (const dst of dests) {
      const cellRules = rules.filter(
        (r) => r.source === src && r.destination === dst,
      );
      row.push(
        cellRules.length === 0
          ? ""
          : cellRules
              .map((r) => {
                const status = r.enabled === false ? "[DISABLED] " : "";
                const category = (r.category ?? "policy") === "policy"
                  ? ""
                  : `[${firewallCategoryLabel(r.category ?? "policy")}] `;
                const action = r.action === "deny" ? "[DENY] " : "";
                return `${status}${category}${action}${r.protocol}/${r.port}`;
              })
              .join("\n"),
      );
    }
    aoa.push(row);
  }
  const wsMatrix = XLSX.utils.aoa_to_sheet(aoa);
  wsMatrix["!cols"] = [{ wch: 22 }, ...dests.map(() => ({ wch: 18 }))];
  XLSX.utils.book_append_sheet(wb, wsMatrix, "Matrix");

  const natRules = rules.filter((r) => (r.category ?? "policy") === "nat");
  if (natRules.length > 0) {
    const wsNat = XLSX.utils.json_to_sheet(natRules.map(ruleToRow));
    wsNat["!cols"] = ruleColumns();
    XLSX.utils.book_append_sheet(wb, wsNat, "NAT Policies");
  }

  const dosRules = rules.filter((r) => (r.category ?? "policy") === "dos");
  if (dosRules.length > 0) {
    const wsDos = XLSX.utils.json_to_sheet(dosRules.map(ruleToRow));
    wsDos["!cols"] = ruleColumns();
    XLSX.utils.book_append_sheet(wb, wsDos, "DoS Policies");
  }

  XLSX.writeFile(wb, filename);
}

/** Export as plain CSV (Rules sheet only). */
export function exportFirewallCsv(rules: FirewallRule[], filename: string): void {
  const cols = [
    "#",
    "Category",
    "Policy ID",
    "Policy Name",
    "Status",
    "Action",
    "Protocol",
    "Source",
    "Destination",
    "Port/Service",
    "NAT",
    "IP Pool",
    "Pool Name",
    "Comments",
    "Attributes",
    "Line",
    "Raw",
  ];
  const lines = [cols.join(",")];
  rules.forEach((r, i) => {
    lines.push(
      [
        i + 1,
        firewallCategoryLabel(r.category ?? "policy"),
        r.name,
        r.displayName ?? "",
        r.enabled === false ? "disabled" : "enabled",
        r.action,
        r.protocol,
        r.source,
        r.destination,
        r.port,
        r.nat?.enabled ? "enabled" : "",
        r.nat?.ippool ? "enabled" : "",
        r.nat?.poolName ?? "",
        r.comments ?? "",
        r.attributes ?? "",
        r.line,
        r.raw,
      ]
        .map(csvEscape)
        .join(","),
    );
  });
  const blob = new Blob(["\uFEFF" + lines.join("\n")], {
    type: "text/csv;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** Expand a rule into one row per srcaddr × dstaddr × service combination. */
function expandRuleRows(r: FirewallRule, ruleIndex: number) {
  return expandFirewallRule(r).map((row) => ({
    "#": ruleIndex + 1,
    Category: firewallCategoryLabel(r.category ?? "policy"),
    "Policy ID": r.name,
    "Policy Name": r.displayName ?? "",
    Status: r.enabled === false ? "disabled" : "enabled",
    Action: r.action,
    Source: row.source,
    Destination: row.destination,
    Service: row.service,
    Line: r.line,
  }));
}

function ruleToRow(r: FirewallRule, i: number) {
  return {
    "#": i + 1,
    Category: firewallCategoryLabel(r.category ?? "policy"),
    "Policy ID": r.name,
    "Policy Name": r.displayName ?? "",
    Status: r.enabled === false ? "disabled" : "enabled",
    Action: r.action,
    Protocol: r.protocol,
    Source: r.source,
    Destination: r.destination,
    "Port/Service": r.port,
    NAT: r.nat?.enabled ? "enabled" : "",
    "IP Pool": r.nat?.ippool ? "enabled" : "",
    "Pool Name": r.nat?.poolName ?? "",
    Comments: r.comments ?? "",
    Attributes: r.attributes ?? "",
    Line: r.line,
    Raw: r.raw,
  };
}

function ruleColumns() {
  return [
    { wch: 4 },
    { wch: 14 },
    { wch: 12 },
    { wch: 28 },
    { wch: 10 },
    { wch: 8 },
    { wch: 16 },
    { wch: 28 },
    { wch: 34 },
    { wch: 28 },
    { wch: 8 },
    { wch: 8 },
    { wch: 20 },
    { wch: 40 },
    { wch: 60 },
    { wch: 6 },
    { wch: 60 },
  ];
}

function dedupe<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}
