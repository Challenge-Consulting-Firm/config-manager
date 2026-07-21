import { useEffect, useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import type {
  ConfigVersion,
  DeviceIdentifiers,
  RoutingRoute,
} from "@config-manager/shared";
import { apiFetch, ApiError } from "../apiClient";
import { safeReturnPath } from "../utils/safeReturnPath";
import {
  exportRoutingCsv,
  exportRoutingExcel,
} from "../utils/routingExport";

type View = "routes" | "matrix";

const PROTOCOL_COLORS: Record<string, string> = {
  static: "bg-slate-100 text-slate-700",
  connected: "bg-blue-100 text-blue-700",
  ospf: "bg-emerald-100 text-emerald-700",
  bgp: "bg-purple-100 text-purple-700",
  rip: "bg-amber-100 text-amber-700",
  eigrp: "bg-cyan-100 text-cyan-700",
  vpn: "bg-indigo-100 text-indigo-700",
};

function protoColor(p: string): string {
  return PROTOCOL_COLORS[p] ?? "bg-slate-100 text-slate-700";
}

export function RoutingPage() {
  const { id } = useParams<{ id: string }>();
  const [params] = useSearchParams();
  const returnKey = safeReturnPath(params.get("from"));

  const [version, setVersion] = useState<ConfigVersion | null>(null);
  const [ids, setIds] = useState<DeviceIdentifiers | null>(null);
  const [routes, setRoutes] = useState<RoutingRoute[]>([]);
  const [fromCache, setFromCache] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>("routes");
  const [filter, setFilter] = useState("");
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    if (!id) return;
    (async () => {
      try {
        const [verRes, rtRes] = await Promise.all([
          apiFetch<{ version: ConfigVersion; identifiers: DeviceIdentifiers }>(
            `/api/versions/${id}`,
          ),
          apiFetch<{ routes: RoutingRoute[]; fromCache: boolean }>(
            `/api/versions/${id}/routing`,
          ),
        ]);
        setVersion(verRes.version);
        setIds(verRes.identifiers);
        setRoutes(rtRes.routes);
        setFromCache(rtRes.fromCache);
      } catch (e) {
        setError(e instanceof ApiError ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    })();
  }, [id]);

  const filtered = useMemo(() => {
    const terms = filter.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return routes;
    return routes.filter((r) => {
      const hay =
        `${r.protocol} ${r.network} ${r.nextHop} ${r.interface ?? ""} ${r.attributes ?? ""}`.toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
  }, [routes, filter]);

  const detection = version?.detected;
  const filenameBase = `routing-${ids?.hostname ?? "device"}-gen${version?.generation ?? "?"}`;

  const protocolCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of routes) m.set(r.protocol, (m.get(r.protocol) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [routes]);

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <div>
          <Link to={returnKey} className="text-sm text-blue-700 hover:underline">
            ← 戻る
          </Link>
          <h1 className="mt-1 text-xl font-semibold text-slate-900">
            ルーティングテーブル
            {ids && (
              <span className="ml-2 text-base font-normal text-slate-600">
                {ids.hostname} · 世代 #{version?.generation}
              </span>
            )}
          </h1>
          {detection && (detection.vendor || detection.os) && (
            <p className="mt-1 text-sm text-slate-500">
              自動識別: {detection.vendor} / {detection.os}
              {detection.osVersion && ` v${detection.osVersion}`}
              {!loading && (
                <span className="ml-2 text-xs text-slate-400">
                  ({fromCache ? "キャッシュ使用" : "新規計算"} · {routes.length}ルート)
                </span>
              )}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={async () => {
              setExporting(true);
              try {
                await exportRoutingExcel(filtered, `${filenameBase}.xlsx`, {
                  hostname: ids?.hostname,
                  generation: version?.generation,
                  vendor: detection?.vendor,
                });
              } finally {
                setExporting(false);
              }
            }}
            disabled={filtered.length === 0 || exporting}
            className="rounded-md bg-emerald-600 px-3 py-2 text-sm text-white hover:bg-emerald-700 disabled:opacity-50"
          >
            {exporting ? "出力中…" : "Excel出力"}
          </button>
          <button
            onClick={() => exportRoutingCsv(filtered, `${filenameBase}.csv`)}
            disabled={filtered.length === 0}
            className="rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            CSV出力
          </button>
        </div>
      </div>

      {/* Protocol summary chips */}
      {!loading && !error && routes.length > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs">
          <span className="font-semibold uppercase text-slate-500">プロトコル別</span>
          {protocolCounts.map(([proto, count]) => (
            <span
              key={proto}
              className={`rounded-full px-2 py-0.5 ${protoColor(proto)}`}
            >
              {proto} <span className="font-semibold">{count}</span>
            </span>
          ))}
        </div>
      )}

      <div className="mb-4 flex items-center gap-2">
        <div className="flex items-center gap-1 rounded-md border border-slate-300 bg-white p-0.5 text-sm">
          {(["routes", "matrix"] as const).map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={`rounded px-3 py-1 ${
                view === v
                  ? "bg-slate-800 text-white"
                  : "text-slate-600 hover:bg-slate-100"
              }`}
            >
              {v === "routes" ? "ルート一覧" : "マトリクス"}
            </button>
          ))}
        </div>
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="スペース区切りAND検索（プロトコル/ネットワーク/NH/属性等）"
          className="flex-1 rounded-md border border-slate-300 px-3 py-2 text-sm"
        />
        <span className="text-xs text-slate-500">{filtered.length} 件</span>
      </div>

      {loading && <p className="text-slate-500">読み込み中…</p>}
      {error && <p className="text-red-600">エラー: {error}</p>}

      {!loading && !error && filtered.length === 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-6 text-sm text-amber-800">
          {routes.length === 0
            ? "このコンフィグからルーティング情報を抽出できませんでした。対応形式（Cisco IOS/IOS-XE/NX-OS/ASA、Juniper Junos、Fortinet FortiOS、YAMAHA、ELECOM、Buffalo）のコンフィグか確認してください。"
            : "条件に一致するルートがありません。"}
        </div>
      )}

      {!loading && !error && filtered.length > 0 && view === "routes" && (
        <RoutesTable routes={filtered} />
      )}

      {!loading && !error && filtered.length > 0 && view === "matrix" && (
        <MatrixView routes={filtered} />
      )}
    </div>
  );
}

function RoutesTable({ routes }: { routes: RoutingRoute[] }) {
  return (
    <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
      <table className="w-full text-sm">
        <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
          <tr>
            <th className="px-3 py-2">Proto</th>
            <th className="px-3 py-2">Network</th>
            <th className="px-3 py-2">Next-Hop</th>
            <th className="px-3 py-2">Interface</th>
            <th className="px-3 py-2 text-right">AD</th>
            <th className="px-3 py-2">Attributes</th>
            <th className="px-3 py-2 text-right">行</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {routes.map((r, i) => (
            <tr key={i} className="hover:bg-slate-50">
              <td className="px-3 py-1.5">
                <span
                  className={`rounded px-1.5 py-0.5 text-xs ${protoColor(r.protocol)}`}
                >
                  {r.protocol}
                </span>
              </td>
              <td className="px-3 py-1.5 mono text-xs">{r.network || "—"}</td>
              <td className="px-3 py-1.5 mono text-xs">{r.nextHop || "—"}</td>
              <td className="px-3 py-1.5 mono text-xs">{r.interface || "—"}</td>
              <td className="px-3 py-1.5 text-right text-xs text-slate-500">
                {r.adminDistance ?? ""}
              </td>
              <td className="px-3 py-1.5 text-xs text-slate-500">
                {r.attributes ?? ""}
              </td>
              <td className="px-3 py-1.5 text-right text-xs text-slate-400">
                {r.line}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MatrixView({ routes }: { routes: RoutingRoute[] }) {
  const protos = useMemo(() => dedupe(routes.map((r) => r.protocol)), [routes]);
  const hops = useMemo(
    () =>
      dedupe(
        routes
          .map((r) => r.nextHop)
          .filter((h) => h !== "" && h !== "directly-connected"),
      ),
    [routes],
  );

  if (protos.length > 20 || hops.length > 30) {
    return (
      <p className="text-sm text-amber-700">
        マトリクス表示はプロトコル20件以下・ネクストホップ30件以下の場合のみ表示します（現在:
        プロトコル{protos.length}件 / ネクストホップ{hops.length}件）。
        ルート一覧タブまたは Excel出力でご確認ください。
      </p>
    );
  }

  return (
    <div className="overflow-auto rounded-lg border border-slate-200 bg-white">
      <table className="w-full border-collapse text-xs">
        <thead>
          <tr>
            <th className="sticky left-0 bg-slate-100 px-2 py-1.5 text-left">
              プロトコル ＼ ネクストホップ
            </th>
            {hops.map((h) => (
              <th key={h} className="px-2 py-1.5 text-left mono">
                {h}
              </th>
            ))}
            <th className="px-2 py-1.5 text-left">(direct / なし)</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {protos.map((proto) => (
            <tr key={proto}>
              <td className="sticky left-0 bg-white px-2 py-1 font-medium">
                <span
                  className={`rounded px-1.5 py-0.5 ${protoColor(proto)}`}
                >
                  {proto}
                </span>
              </td>
              {hops.map((hop) => {
                const cell = routes.filter(
                  (r) => r.protocol === proto && r.nextHop === hop,
                );
                return (
                  <td
                    key={hop}
                    className="border-l border-slate-100 px-2 py-1 align-top"
                  >
                    {cell.length === 0 ? (
                      <span className="text-slate-300">—</span>
                    ) : (
                      <div className="flex flex-col gap-0.5">
                        {cell.map((r, i) => (
                          <span
                            key={i}
                            className="rounded bg-slate-50 px-1 py-0.5 text-slate-700"
                          >
                            {r.network || r.interface || "(summary)"}
                          </span>
                        ))}
                      </div>
                    )}
                  </td>
                );
              })}
              <td className="border-l border-slate-100 px-2 py-1 align-top">
                {routes.filter(
                  (r) =>
                    r.protocol === proto &&
                    (r.nextHop === "" || r.nextHop === "directly-connected"),
                ).length === 0 ? (
                  <span className="text-slate-300">—</span>
                ) : (
                  <div className="flex flex-col gap-0.5">
                    {routes
                      .filter(
                        (r) =>
                          r.protocol === proto &&
                          (r.nextHop === "" ||
                            r.nextHop === "directly-connected"),
                      )
                      .map((r, i) => (
                        <span
                          key={i}
                          className="rounded bg-slate-50 px-1 py-0.5 text-slate-700"
                        >
                          {r.network || r.interface || "(summary)"}
                        </span>
                      ))}
                  </div>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function dedupe<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}
