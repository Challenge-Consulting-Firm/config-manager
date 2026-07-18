import type { FirewallRule } from "@config-manager/shared";

/** Export firewall rules to an .xlsx workbook with two sheets:
 *  - "Rules": the flat rule list
 *  - "Matrix": source × destination cross-tab, cells list proto/port (action)
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
  const ruleRows = rules.map((r, i) => ({
    "#": i + 1,
    ACL: r.name,
    Action: r.action,
    Protocol: r.protocol,
    Source: r.source,
    Destination: r.destination,
    Port: r.port,
    Line: r.line,
    Raw: r.raw,
  }));
  const wsRules = XLSX.utils.json_to_sheet(ruleRows);
  wsRules["!cols"] = [
    { wch: 4 },
    { wch: 20 },
    { wch: 8 },
    { wch: 8 },
    { wch: 24 },
    { wch: 24 },
    { wch: 14 },
    { wch: 6 },
    { wch: 60 },
  ];
  XLSX.utils.book_append_sheet(wb, wsRules, "Rules");

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
              .map((r) =>
                r.action === "deny"
                  ? `[DENY] ${r.protocol}/${r.port}`
                  : `${r.protocol}/${r.port}`,
              )
              .join("\n"),
      );
    }
    aoa.push(row);
  }
  const wsMatrix = XLSX.utils.aoa_to_sheet(aoa);
  wsMatrix["!cols"] = [{ wch: 22 }, ...dests.map(() => ({ wch: 18 }))];
  XLSX.utils.book_append_sheet(wb, wsMatrix, "Matrix");

  XLSX.writeFile(wb, filename);
}

/** Export as plain CSV (Rules sheet only). */
export function exportFirewallCsv(rules: FirewallRule[], filename: string): void {
  const cols = ["#", "ACL", "Action", "Protocol", "Source", "Destination", "Port", "Line", "Raw"];
  const esc = (v: unknown) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [cols.join(",")];
  rules.forEach((r, i) => {
    lines.push(
      [i + 1, r.name, r.action, r.protocol, r.source, r.destination, r.port, r.line, r.raw]
        .map(esc)
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

function dedupe<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}
