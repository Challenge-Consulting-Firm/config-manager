import { useState } from "react";
import { Link } from "react-router-dom";
import type { ConfigSearchResult } from "@config-manager/shared";
import { apiFetch, ApiError } from "../apiClient";
import { RoleBadge } from "../components/RoleBadge";

type Scope = "latest" | "all";

export function SearchPage() {
  const [q, setQ] = useState("");
  const [scope, setScope] = useState<Scope>("latest");
  const [isRegex, setIsRegex] = useState(false);
  const [result, setResult] = useState<ConfigSearchResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function runSearch(e: React.FormEvent) {
    e.preventDefault();
    const query = q.trim();
    if (!query) return;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        q: query,
        scope,
        regex: isRegex ? "1" : "0",
      });
      const res = await apiFetch<ConfigSearchResult>(`/api/search?${params}`);
      setResult(res);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
      setResult(null);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <h1 className="mb-2 text-xl font-semibold text-slate-900">
        コンフィグ全文検索
      </h1>
      <p className="mb-4 text-sm text-slate-600">
        全機器のコンフィグ本文を対象に、指定した文字列／正規表現を含む行を検索します。
        スコープ「最新のみ」は各機器の最新世代のみ、「全世代」は履歴含めて全世代を走査します。
      </p>

      <form onSubmit={runSearch} className="mb-4 flex flex-wrap items-center gap-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={isRegex ? "正規表現（例: access-list\\s+101）" : "検索文字列（例: access-list 101）"}
          className="flex-1 rounded-md border border-slate-300 px-3 py-2 text-sm"
          autoFocus
        />
        <div className="flex items-center gap-1 rounded-md border border-slate-300 bg-white p-0.5 text-sm">
          {(["latest", "all"] as const).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setScope(s)}
              className={`rounded px-3 py-1 ${
                scope === s
                  ? "bg-slate-800 text-white"
                  : "text-slate-600 hover:bg-slate-100"
              }`}
            >
              {s === "latest" ? "最新のみ" : "全世代"}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-1 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={isRegex}
            onChange={(e) => setIsRegex(e.target.checked)}
          />
          正規表現
        </label>
        <button
          type="submit"
          disabled={loading || !q.trim()}
          className="rounded-md bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {loading ? "検索中…" : "検索"}
        </button>
      </form>

      {error && <p className="text-red-600">エラー: {error}</p>}

      {result && (
        <>
          <div className="mb-3 text-sm text-slate-600">
            <span className="mono">{result.query}</span>（
            {result.isRegex ? "正規表現" : "部分一致"} ·{" "}
            {result.scope === "latest" ? "最新のみ" : "全世代"}）:
            <span className="ml-1 font-semibold text-slate-900">
              {result.hits.length} 件
            </span>
            <span className="ml-2 text-xs text-slate-400">
              （{result.scannedDevices} 機器 · {result.scannedVersions} 世代を走査）
            </span>
          </div>

          {result.hits.length === 0 ? (
            <p className="text-slate-500">一致する行はありませんでした。</p>
          ) : (
            <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
                  <tr>
                    <th className="px-4 py-2">区分</th>
                    <th className="px-4 py-2">顧客</th>
                    <th className="px-4 py-2">ホスト名</th>
                    <th className="px-4 py-2">世代</th>
                    <th className="px-4 py-2 text-right">行</th>
                    <th className="px-4 py-2">マッチ行</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {result.hits.map((h) => (
                    <tr key={`${h.versionId}:${h.line}`} className="align-top hover:bg-slate-50">
                      <td className="px-4 py-2">
                        <RoleBadge role={h.role} size="xs" />
                      </td>
                      <td className="px-4 py-2">
                        <Link
                          to={`/devices/${encodeURIComponent(
                            `${h.customer}|${h.hostname}|${h.ipAddress}|${h.role}`,
                          )}`}
                          className="font-medium text-blue-700 hover:underline"
                        >
                          {h.customer}
                        </Link>
                      </td>
                      <td className="px-4 py-2 mono">
                        <div>{h.hostname}</div>
                        <div className="text-xs text-slate-500">{h.ipAddress}</div>
                      </td>
                      <td className="px-4 py-2 mono">
                        <Link
                          to={`/diff?before=${h.versionId}&after=${h.versionId}`}
                          className="text-blue-700 hover:underline"
                          title="この世代を Diff 画面で開く"
                        >
                          #{h.generation}
                        </Link>
                      </td>
                      <td className="px-4 py-2 text-right mono text-slate-600">
                        {h.line}
                      </td>
                      <td className="px-4 py-2">
                        <div className="mono whitespace-pre-wrap break-all text-xs leading-5">
                          {h.before && (
                            <div className="text-slate-400">{h.before}</div>
                          )}
                          <div className="bg-yellow-100 font-medium text-slate-900">
                            {h.text}
                          </div>
                          {h.after && (
                            <div className="text-slate-400">{h.after}</div>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="mt-2 text-xs text-slate-500">
            ※ 1世代あたり最大30行まで表示します。より多くのヒットを見たい場合は BFF
            の <code>maxPerVersion</code> クエリパラメータを調整してください。
          </p>
        </>
      )}
    </div>
  );
}
