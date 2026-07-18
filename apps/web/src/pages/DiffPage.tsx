import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import type { ConfigDiff } from "@config-manager/shared";
import { apiFetch, ApiError } from "../apiClient";
import { DiffViewer } from "../components/DiffViewer";

export function DiffPage() {
  const [params] = useSearchParams();
  const before = params.get("before") ?? "";
  const after = params.get("after") ?? "";
  const [diff, setDiff] = useState<ConfigDiff | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!before || !after) {
      setError("before と after の世代を指定してください");
      setLoading(false);
      return;
    }
    (async () => {
      try {
        const res = await apiFetch<{ diff: ConfigDiff }>(
          `/api/diff?before=${encodeURIComponent(before)}&after=${encodeURIComponent(after)}`,
        );
        setDiff(res.diff);
      } catch (e) {
        setError(e instanceof ApiError ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    })();
  }, [before, after]);

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <div>
          <Link to="/" className="text-sm text-blue-700 hover:underline">
            ← 機器一覧へ
          </Link>
          <h1 className="mt-1 text-xl font-semibold text-slate-900">
            コンフィグ Diff
          </h1>
        </div>
        {diff && (
          <div className="flex items-center gap-2">
            <span className="mono rounded bg-slate-100 px-2 py-1 text-xs">
              世代 {diff.before.generation} → {diff.after.generation}
            </span>
            <button
              onClick={() => downloadPatch(diff)}
              className="rounded border border-slate-300 px-2 py-1 text-xs hover:bg-slate-50"
            >
              パッチ(.patch)をダウンロード
            </button>
          </div>
        )}
      </div>

      {loading && <p className="text-slate-500">差分を計算中…</p>}
      {error && <p className="text-red-600">エラー: {error}</p>}
      {diff && <DiffViewer lines={diff.lines} stats={diff.stats} />}
    </div>
  );
}

function downloadPatch(diff: ConfigDiff) {
  const blob = new Blob([diff.patch], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `config-${diff.before.generation}-to-${diff.after.generation}.patch`;
  a.click();
  URL.revokeObjectURL(url);
}
