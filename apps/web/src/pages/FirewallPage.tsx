import { useEffect, useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import type {
  ConfigVersion,
  DeviceIdentifiers,
  FirewallRule,
} from "@config-manager/shared";
import { apiFetch, ApiError } from "../apiClient";
import {
  exportFirewallCsv,
  exportFirewallExcel,
} from "../utils/firewallExport";

type View = "rules" | "matrix";

export function FirewallPage() {
  const { id } = useParams<{ id: string }>();
  const [params] = useSearchParams();
  const returnKey = params.get("from") || "/";

  const [version, setVersion] = useState<ConfigVersion | null>(null);
  const [ids, setIds] = useState<DeviceIdentifiers | null>(null);
  const [rules, setRules] = useState<FirewallRule[]>([]);
  const [fromCache, setFromCache] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>("rules");
  const [filter, setFilter] = useState("");
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    if (!id) return;
    (async () => {
      try {
        // Fetch version metadata + cached firewall rules in parallel. The
        // BFF recomputes and persists on cache miss, so this stays fast even
        // for large configs / many policies.
        const [verRes, fwRes] = await Promise.all([
          apiFetch<{ version: ConfigVersion; identifiers: DeviceIdentifiers }>(
            `/api/versions/${id}`,
          ),
          apiFetch<{ rules: FirewallRule[]; fromCache: boolean }>(
            `/api/versions/${id}/firewall`,
          ),
        ]);
        setVersion(verRes.version);
        setIds(verRes.identifiers);
        setRules(fwRes.rules);
        setFromCache(fwRes.fromCache);
      } catch (e) {
        setError(e instanceof ApiError ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    })();
  }, [id]);

  const filtered = useMemo(() => {
    const terms = filter.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return rules;
    return rules.filter((r) => {
      const hay =
        `${r.name} ${r.action} ${r.protocol} ${r.source} ${r.destination} ${r.port}`.toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
  }, [rules, filter]);

  const detection = version?.detected;
  const filenameBase = `firewall-${ids?.hostname ?? "device"}-gen${version?.generation ?? "?"}`;

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <div>
          <Link to={returnKey} className="text-sm text-blue-700 hover:underline">
            ← 戻る
          </Link>
          <h1 className="mt-1 text-xl font-semibold text-slate-900">
            FWポリシー / ACL マトリクス
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
                  ({fromCache ? "キャッシュ使用" : "新規計算"} · {rules.length}ルール)
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
                await exportFirewallExcel(filtered, `${filenameBase}.xlsx`, {
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
            onClick={() => exportFirewallCsv(filtered, `${filenameBase}.csv`)}
            disabled={filtered.length === 0}
            className="rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            CSV出力
          </button>
        </div>
      </div>

      <div className="mb-4 flex items-center gap-2">
        <div className="flex items-center gap-1 rounded-md border border-slate-300 bg-white p-0.5 text-sm">
          {(["rules", "matrix"] as const).map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={`rounded px-3 py-1 ${
                view === v
                  ? "bg-slate-800 text-white"
                  : "text-slate-600 hover:bg-slate-100"
              }`}
            >
              {v === "rules" ? "ルール一覧" : "マトリクス"}
            </button>
          ))}
        </div>
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="スペース区切りAND検索（ACL名/送信元/宛先/ポート等）"
          className="flex-1 rounded-md border border-slate-300 px-3 py-2 text-sm"
        />
        <span className="text-xs text-slate-500">{filtered.length} 件</span>
      </div>

      {loading && <p className="text-slate-500">読み込み中…</p>}
      {error && <p className="text-red-600">エラー: {error}</p>}

      {!loading && !error && filtered.length === 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-6 text-sm text-amber-800">
          {rules.length === 0
            ? "このコンフィグからFWポリシー/ACLを抽出できませんでした。対応形式（Cisco ACL/ASA、Juniperフィルタ、Fortinetポリシー、YAMAHA ip filter）のコンフィグか確認してください。"
            : "条件に一致するルールがありません。"}
        </div>
      )}

      {!loading && !error && filtered.length > 0 && view === "rules" && (
        <RulesTable rules={filtered} />
      )}

      {!loading && !error && filtered.length > 0 && view === "matrix" && (
        <MatrixView rules={filtered} />
      )}
    </div>
  );
}

function RulesTable({ rules }: { rules: FirewallRule[] }) {
  return (
    <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
      <table className="w-full text-sm">
        <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
          <tr>
            <th className="px-3 py-2">ACL</th>
            <th className="px-3 py-2">Action</th>
            <th className="px-3 py-2">Proto</th>
            <th className="px-3 py-2">送信元</th>
            <th className="px-3 py-2">宛先</th>
            <th className="px-3 py-2">ポート</th>
            <th className="px-3 py-2 text-right">行</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rules.map((r, i) => (
            <tr key={i} className="hover:bg-slate-50">
              <td className="px-3 py-1.5 mono text-xs">{r.name}</td>
              <td className="px-3 py-1.5">
                <span
                  className={
                    r.action === "deny"
                      ? "rounded bg-red-100 px-1.5 py-0.5 text-xs text-red-700"
                      : "rounded bg-emerald-100 px-1.5 py-0.5 text-xs text-emerald-700"
                  }
                >
                  {r.action}
                </span>
              </td>
              <td className="px-3 py-1.5 mono text-xs">{r.protocol}</td>
              <td className="px-3 py-1.5 mono text-xs">{r.source}</td>
              <td className="px-3 py-1.5 mono text-xs">{r.destination}</td>
              <td className="px-3 py-1.5 mono text-xs">{r.port}</td>
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

function MatrixView({ rules }: { rules: FirewallRule[] }) {
  const sources = useMemo(() => dedupe(rules.map((r) => r.source)), [rules]);
  const dests = useMemo(() => dedupe(rules.map((r) => r.destination)), [rules]);

  if (sources.length > 30 || dests.length > 30) {
    return (
      <p className="text-sm text-amber-700">
        マトリクス表示は送信元/宛先が30件以下の場合のみ表示します（現在:
        送信元{sources.length}件 / 宛先{dests.length}件）。
        ルール一覧タブまたは Excel出力でご確認ください。
      </p>
    );
  }

  return (
    <div className="overflow-auto rounded-lg border border-slate-200 bg-white">
      <table className="w-full border-collapse text-xs">
        <thead>
          <tr>
            <th className="sticky left-0 bg-slate-100 px-2 py-1.5 text-left">
              送信元 ＼ 宛先
            </th>
            {dests.map((d) => (
              <th key={d} className="px-2 py-1.5 text-left mono">
                {d}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {sources.map((src) => (
            <tr key={src}>
              <td className="sticky left-0 bg-white px-2 py-1 mono font-medium">
                {src}
              </td>
              {dests.map((dst) => {
                const cell = rules.filter(
                  (r) => r.source === src && r.destination === dst,
                );
                return (
                  <td
                    key={dst}
                    className="border-l border-slate-100 px-2 py-1 align-top"
                  >
                    {cell.length === 0 ? (
                      <span className="text-slate-300">—</span>
                    ) : (
                      <div className="flex flex-col gap-0.5">
                        {cell.map((r, i) => (
                          <span
                            key={i}
                            className={
                              r.action === "deny"
                                ? "rounded bg-red-50 px-1 py-0.5 text-red-700"
                                : "rounded bg-emerald-50 px-1 py-0.5 text-emerald-700"
                            }
                          >
                            {r.protocol}/{r.port}
                          </span>
                        ))}
                      </div>
                    )}
                  </td>
                );
              })}
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
