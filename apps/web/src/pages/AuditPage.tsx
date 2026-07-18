import { useEffect, useState } from "react";
import type { AuditLogEntry } from "@config-manager/shared";
import { apiFetch, ApiError } from "../apiClient";

const ACTION_LABEL: Record<string, string> = {
  upload: "アップロード",
  view: "参照",
  diff: "差分表示",
  download: "ダウンロード",
  delete: "削除",
};

export function AuditPage() {
  const [entries, setEntries] = useState<AuditLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await apiFetch<{ entries: AuditLogEntry[] }>("/api/audit");
        setEntries(res.entries);
      } catch (e) {
        setError(e instanceof ApiError ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  return (
    <div>
      <h1 className="mb-4 text-xl font-semibold text-slate-900">作業履歴</h1>
      <p className="mb-4 text-sm text-slate-600">
        Kintone の監査アプリに記録された操作履歴（最新 {entries.length} 件）。
        作業者は Entra ID のログイン情報から自動取得されます。
      </p>

      {loading && <p className="text-slate-500">読み込み中…</p>}
      {error && <p className="text-red-600">エラー: {error}</p>}

      {!loading && entries.length > 0 && (
        <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
              <tr>
                <th className="px-4 py-2">日時</th>
                <th className="px-4 py-2">作業者</th>
                <th className="px-4 py-2">操作</th>
                <th className="px-4 py-2">顧客</th>
                <th className="px-4 py-2">ホスト名</th>
                <th className="px-4 py-2">世代</th>
                <th className="px-4 py-2">詳細</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {entries.map((e) => (
                <tr key={e.id} className="hover:bg-slate-50">
                  <td className="px-4 py-2 text-slate-600">
                    {new Date(e.createdAt).toLocaleString("ja-JP")}
                  </td>
                  <td className="px-4 py-2">
                    <div className="font-medium text-slate-800">{e.operator}</div>
                    <div className="text-xs text-slate-500">{e.operatorEmail}</div>
                  </td>
                  <td className="px-4 py-2">
                    <span className={actionBadge(e.action)}>
                      {ACTION_LABEL[e.action] ?? e.action}
                    </span>
                  </td>
                  <td className="px-4 py-2">{e.customer ?? "—"}</td>
                  <td className="px-4 py-2 mono">{e.hostname ?? "—"}</td>
                  <td className="px-4 py-2 mono">
                    {e.generation ? `#${e.generation}` : "—"}
                  </td>
                  <td className="px-4 py-2 text-slate-600">{e.detail ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {!loading && entries.length === 0 && (
        <p className="text-slate-500">履歴がありません。</p>
      )}
    </div>
  );
}

function actionBadge(action: string): string {
  const base = "inline-block rounded px-2 py-0.5 text-xs";
  switch (action) {
    case "upload":
      return `${base} bg-emerald-100 text-emerald-700`;
    case "delete":
      return `${base} bg-red-100 text-red-700`;
    case "diff":
      return `${base} bg-blue-100 text-blue-700`;
    default:
      return `${base} bg-slate-100 text-slate-700`;
  }
}
