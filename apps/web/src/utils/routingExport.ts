import type { RoutingRoute } from "@config-manager/shared";

/** Export routing routes to an .xlsx workbook with three sheets:
 *  - "Routes": the flat route list
 *  - "Matrix": protocol × next-hop cross-tab, cells list networks
 *  - "Protocol Summary": count of routes per protocol
 *
 *  The `xlsx` library is loaded lazily so it does not bloat the initial bundle.
 */
export async function exportRoutingExcel(
  routes: RoutingRoute[],
  filename: string,
  meta?: { hostname?: string; generation?: number; vendor?: string },
): Promise<void> {
  const XLSX = await import("xlsx");
  const wb = XLSX.utils.book_new();

  // ---- Sheet 1: Routes ----
  const routeRows = routes.map((r, i) => ({
    "#": i + 1,
    Protocol: r.protocol,
    Network: r.network,
    "Next-Hop": r.nextHop,
    Interface: r.interface ?? "",
    AD: r.adminDistance ?? "",
    Metric: r.metric ?? "",
    Attributes: r.attributes ?? "",
    Line: r.line,
    Raw: r.raw,
  }));
  const wsRules = XLSX.utils.json_to_sheet(routeRows);
  wsRules["!cols"] = [
    { wch: 4 },
    { wch: 10 },
    { wch: 22 },
    { wch: 22 },
    { wch: 18 },
    { wch: 6 },
    { wch: 8 },
    { wch: 32 },
    { wch: 6 },
    { wch: 60 },
  ];
  XLSX.utils.book_append_sheet(wb, wsRules, "Routes");

  // ---- Sheet 2: Protocol × Next-Hop matrix ----
  const protos = dedupe(routes.map((r) => r.protocol));
  const hops = dedupe(
    routes
      .map((r) => r.nextHop)
      .filter((h) => h !== "" && h !== "directly-connected"),
  );
  const aoa: (string | number)[][] = [];
  if (meta) {
    aoa.push([
      `Host: ${meta.hostname ?? "-"}  Gen: #${meta.generation ?? "-"}  Vendor: ${meta.vendor ?? "-"}`,
    ]);
  }
  const header = ["Protocol \\ Next-Hop", ...hops, "(direct/no next-hop)"];
  aoa.push(header);
  for (const proto of protos) {
    const row: (string | number)[] = [proto];
    for (const hop of hops) {
      const cellRoutes = routes.filter(
        (r) => r.protocol === proto && r.nextHop === hop,
      );
      row.push(
        cellRoutes.length === 0
          ? ""
          : cellRoutes.map((r) => r.network).join("\n"),
      );
    }
    // Catch-all column for routes with no / direct next-hop.
    const directRoutes = routes.filter(
      (r) =>
        r.protocol === proto &&
        (r.nextHop === "" || r.nextHop === "directly-connected"),
    );
    row.push(
      directRoutes.length === 0
        ? ""
        : directRoutes
            .map((r) => r.network || r.interface || "(summary)")
            .join("\n"),
    );
    aoa.push(row);
  }
  const wsMatrix = XLSX.utils.aoa_to_sheet(aoa);
  wsMatrix["!cols"] = [{ wch: 20 }, ...hops.map(() => ({ wch: 24 })), { wch: 24 }];
  XLSX.utils.book_append_sheet(wb, wsMatrix, "Matrix");

  // ---- Sheet 3: Protocol summary ----
  const summaryRows = protos.map((p) => {
    const subset = routes.filter((r) => r.protocol === p);
    return {
      Protocol: p,
      Count: subset.length,
      Networks: dedupe(subset.map((r) => r.network).filter(Boolean)).join(", "),
      "Next-Hops": dedupe(subset.map((r) => r.nextHop).filter(Boolean)).join(", "),
    };
  });
  const wsSummary = XLSX.utils.json_to_sheet(summaryRows);
  wsSummary["!cols"] = [{ wch: 12 }, { wch: 8 }, { wch: 60 }, { wch: 40 }];
  XLSX.utils.book_append_sheet(wb, wsSummary, "Protocol Summary");

  XLSX.writeFile(wb, filename);
}

/** Export as plain CSV (Routes sheet only). */
export function exportRoutingCsv(routes: RoutingRoute[], filename: string): void {
  const cols = [
    "#",
    "Protocol",
    "Network",
    "Next-Hop",
    "Interface",
    "AD",
    "Metric",
    "Attributes",
    "Line",
    "Raw",
  ];
  const esc = (v: unknown) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [cols.join(",")];
  routes.forEach((r, i) => {
    lines.push(
      [
        i + 1,
        r.protocol,
        r.network,
        r.nextHop,
        r.interface ?? "",
        r.adminDistance ?? "",
        r.metric ?? "",
        r.attributes ?? "",
        r.line,
        r.raw,
      ]
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
