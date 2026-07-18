import { useEffect, useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import {
  expandFirewallRule,
  firewallCategoryLabel,
  type ConfigVersion,
  type DeviceIdentifiers,
  type FirewallRule,
  type FirewallRuleCategory,
} from "@config-manager/shared";
import { apiFetch, ApiError } from "../apiClient";
import {
  exportFirewallCsv,
  exportFirewallExcel,
} from "../utils/firewallExport";

type View = "rules" | "matrix" | "expand";
type CategoryFilter = "all" | "policy" | "nat" | "dos";

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
  const [category, setCategory] = useState<CategoryFilter>("all");
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

  const categoryCounts = useMemo(() => {
    const counts: Record<CategoryFilter, number> = {
      all: rules.length,
      policy: 0,
      nat: 0,
      dos: 0,
    };
    for (const r of rules) {
      const c = r.category ?? "policy";
      if (c === "nat" || c === "dos") counts[c]++;
      else counts.policy++;
    }
    return counts;
  }, [rules]);

  const categoryFiltered = useMemo(() => {
    if (category === "all") return rules;
    return rules.filter((r) => (r.category ?? "policy") === category);
  }, [rules, category]);

  const filtered = useMemo(() => {
    const terms = filter.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return categoryFiltered;
    return categoryFiltered.filter((r) => {
      const hay =
        `${r.name} ${r.displayName ?? ""} ${r.category ?? "policy"} ${r.action} ${r.enabled === false ? "disable disabled 無効" : "enable enabled 有効"} ${r.protocol} ${r.source} ${r.destination} ${r.port} ${r.nat?.poolName ?? ""} ${r.comments ?? ""} ${r.attributes ?? ""}`.toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
  }, [categoryFiltered, filter]);

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

      <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
        {(["all", "policy", "nat", "dos"] as const).map((c) => (
          <button
            key={c}
            onClick={() => setCategory(c)}
            className={`rounded-full border px-3 py-1 ${
              category === c
                ? "border-blue-500 bg-blue-50 text-blue-700"
                : "border-slate-300 bg-white text-slate-600 hover:bg-slate-50"
            }`}
          >
            {categoryLabel(c)}
            <span className="ml-1 text-xs text-slate-500">
              {categoryCounts[c]}
            </span>
          </button>
        ))}
      </div>

      <div className="mb-4 flex items-center gap-2">
        <div className="flex items-center gap-1 rounded-md border border-slate-300 bg-white p-0.5 text-sm">
          {(["rules", "matrix", "expand"] as const).map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={`rounded px-3 py-1 ${
                view === v
                  ? "bg-slate-800 text-white"
                  : "text-slate-600 hover:bg-slate-100"
              }`}
            >
              {viewLabel(v)}
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
            : categoryFiltered.length === 0
              ? `${categoryLabel(category)} はありません。`
              : "条件に一致するルールがありません。"}
        </div>
      )}

      {!loading && !error && filtered.length > 0 && view === "rules" && (
        <RulesTable rules={filtered} />
      )}

      {!loading && !error && filtered.length > 0 && view === "matrix" && (
        <MatrixView rules={filtered} />
      )}

      {!loading && !error && filtered.length > 0 && view === "expand" && (
        <ExpandTable rules={filtered} />
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
            <th className="px-3 py-2">種別</th>
            <th className="px-3 py-2">Policy</th>
            <th className="px-3 py-2">Status</th>
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
              <td className="px-3 py-1.5">
                <CategoryBadge category={r.category ?? "policy"} />
              </td>
              <td className="px-3 py-1.5 text-xs">
                <div className="mono font-medium">{r.name}</div>
                {r.displayName && (
                  <div className="mt-0.5 text-slate-500">{r.displayName}</div>
                )}
                {r.comments && (
                  <div className="mt-0.5 line-clamp-2 text-slate-400">{r.comments}</div>
                )}
              </td>
              <td className="px-3 py-1.5">
                <StatusBadge enabled={r.enabled} />
              </td>
              <td className="px-3 py-1.5">
                <ActionBadge action={r.action} />
              </td>
              <td className="px-3 py-1.5 mono text-xs">{r.protocol}</td>
              <td className="px-3 py-1.5 mono text-xs">{r.source}</td>
              <td className="px-3 py-1.5 mono text-xs">{r.destination}</td>
              <td className="px-3 py-1.5 mono text-xs">
                <div>{r.port}</div>
                {r.nat?.enabled && (
                  <div className="mt-0.5 text-[11px] text-orange-700">
                    NAT{r.nat.ippool ? " / IP pool" : ""}
                    {r.nat.poolName ? `: ${r.nat.poolName}` : ""}
                  </div>
                )}
                {r.attributes && (
                  <div className="mt-0.5 max-w-xs truncate text-[11px] text-slate-400">
                    {r.attributes}
                  </div>
                )}
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
                            {r.enabled === false && "[無効] "}
                            {(r.category ?? "policy") !== "policy" &&
                              `[${categoryLabel(r.category ?? "policy")}] `}
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

function viewLabel(v: View): string {
  switch (v) {
    case "rules":
      return "ルール一覧";
    case "matrix":
      return "マトリクス";
    case "expand":
      return "組み合わせ展開";
  }
}

function ExpandTable({ rules }: { rules: FirewallRule[] }) {
  const rows = useMemo(() => rules.flatMap(expandFirewallRule), [rules]);
  return (
    <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
      <p className="border-b border-slate-100 bg-slate-50 px-3 py-2 text-xs text-slate-500">
        各ポリシーを 送信元 × 宛先 × サービス の組み合わせ単位に展開（{rows.length} 行）
      </p>
      <table className="w-full text-sm">
        <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
          <tr>
            <th className="px-3 py-2">種別</th>
            <th className="px-3 py-2">Policy</th>
            <th className="px-3 py-2">Status</th>
            <th className="px-3 py-2">Action</th>
            <th className="px-3 py-2">送信元</th>
            <th className="px-3 py-2">宛先</th>
            <th className="px-3 py-2">サービス</th>
            <th className="px-3 py-2 text-right">行</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((row, i) => {
            const r = row.rule;
            return (
              <tr key={i} className="hover:bg-slate-50">
                <td className="px-3 py-1.5">
                  <CategoryBadge category={r.category ?? "policy"} />
                </td>
                <td className="px-3 py-1.5 text-xs">
                  <div className="mono font-medium">{r.name}</div>
                  {r.displayName && (
                    <div className="mt-0.5 text-slate-500">{r.displayName}</div>
                  )}
                </td>
                <td className="px-3 py-1.5">
                  <StatusBadge enabled={r.enabled} />
                </td>
                <td className="px-3 py-1.5">
                  <ActionBadge action={r.action} />
                </td>
                <td className="px-3 py-1.5 mono text-xs">{row.source}</td>
                <td className="px-3 py-1.5 mono text-xs">{row.destination}</td>
                <td className="px-3 py-1.5 mono text-xs">{row.service}</td>
                <td className="px-3 py-1.5 text-right text-xs text-slate-400">
                  {r.line}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ----- 共通バッジ・ヘルパー -----

function CategoryBadge({ category }: { category: FirewallRuleCategory }) {
  return (
    <span
      className={`rounded px-1.5 py-0.5 text-xs ${categoryColorClass(category)}`}
    >
      {firewallCategoryLabel(category)}
    </span>
  );
}

function StatusBadge({ enabled }: { enabled?: boolean }) {
  return enabled === false ? (
    <span className="rounded bg-slate-200 px-1.5 py-0.5 text-xs text-slate-700">
      無効
    </span>
  ) : (
    <span className="rounded bg-blue-50 px-1.5 py-0.5 text-xs text-blue-700">
      有効
    </span>
  );
}

function ActionBadge({ action }: { action: FirewallRule["action"] }) {
  return (
    <span
      className={
        action === "deny"
          ? "rounded bg-red-100 px-1.5 py-0.5 text-xs text-red-700"
          : "rounded bg-emerald-100 px-1.5 py-0.5 text-xs text-emerald-700"
      }
    >
      {action}
    </span>
  );
}

function categoryColorClass(category: FirewallRuleCategory): string {
  switch (category) {
    case "nat":
      return "bg-orange-100 text-orange-700";
    case "dos":
      return "bg-purple-100 text-purple-700";
    case "policy":
      return "bg-slate-100 text-slate-700";
  }
}

function categoryLabel(category: CategoryFilter): string {
  return category === "all" ? "すべて" : firewallCategoryLabel(category);
}

function dedupe<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}
