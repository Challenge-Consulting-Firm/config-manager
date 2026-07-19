import { useState } from "react";
import { Link, useLocation } from "react-router-dom";
import type { Device, Role } from "@config-manager/shared";
import { apiFetch } from "../apiClient";
import { useStaleWhileRevalidate } from "../hooks/useStaleWhileRevalidate";
import { RoleBadge } from "../components/RoleBadge";

type RoleFilter = "all" | Role;

type DevicesResponse = { devices: Device[] };

export function DevicesPage() {
  // localStorage キャッシュを即時描画しつつ、裏側で最新データを再取得する。
  // フェッチ成功時にキャッシュも更新されるため、次回訪問時の体感速度が上がる。
  const { data, loading, error, stale } = useStaleWhileRevalidate<DevicesResponse>(
    "devices",
    () => apiFetch<DevicesResponse>("/api/devices"),
  );
  const devices = data?.devices ?? [];
  const [q, setQ] = useState("");
  const [roleFilter, setRoleFilter] = useState<RoleFilter>("all");
  // 機器削除後などに遷移元から渡されるフラッシュメッセージ。一度表示したら
  // 閉じられるよう state に取り込む（履歴の state はリロードで消える）。
  const location = useLocation();
  const [flash, setFlash] = useState<string | null>(
    (location.state as { flash?: string } | null)?.flash ?? null,
  );

  const filtered = devices.filter((d) => {
    if (roleFilter !== "all" && d.identifiers.role !== roleFilter) return false;
    const terms = q.trim().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return true;
    const hay =
      `${d.identifiers.customer} ${d.identifiers.hostname} ${d.identifiers.ipAddress} ${d.identifiers.purpose} ${d.identifiers.serialNumber}`.toLowerCase();
    // AND search: every whitespace-separated term must match.
    return terms.every((t) => hay.includes(t.toLowerCase()));
  });

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold text-slate-900">機器一覧</h1>
        <div className="flex gap-2">
          <Link
            to="/upload"
            className="rounded-md bg-blue-600 px-3 py-2 text-sm text-white hover:bg-blue-700"
          >
            + コンフィグ登録
          </Link>
          <Link
            to="/meraki"
            className="rounded-md border border-blue-300 bg-white px-3 py-2 text-sm text-blue-700 hover:bg-blue-50"
          >
            Meraki 取得
          </Link>
        </div>
      </div>

      {flash && (
        <div className="mb-4 flex items-center justify-between rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          <span>{flash}</span>
          <button
            onClick={() => setFlash(null)}
            className="text-emerald-600 hover:text-emerald-900"
          >
            ✕
          </button>
        </div>
      )}

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="顧客・ホスト名・IP・用途・シリアル で検索（スペース区切りでAND）"
          className="flex-1 rounded-md border border-slate-300 px-3 py-2 text-sm"
        />
        <div className="flex items-center gap-1 rounded-md border border-slate-300 bg-white p-0.5 text-sm">
          {(["all", "production", "spare"] as const).map((r) => (
            <button
              key={r}
              onClick={() => setRoleFilter(r)}
              className={`rounded px-2.5 py-1 ${
                roleFilter === r
                  ? "bg-slate-800 text-white"
                  : "text-slate-600 hover:bg-slate-100"
              }`}
            >
              {r === "all" ? "すべて" : r === "production" ? "本番" : "予備"}
            </button>
          ))}
        </div>
      </div>

      {/*
       * stale はキャッシュ表示中（裏で再取得中）の状態。loading はキャッシュも
       * データも無く初回取得を待っている状態。それぞれメッセージを出し分ける。
       */}
      {stale && (
        <p className="mb-3 text-xs text-slate-400">キャッシュを表示中・最新データを取得しています…</p>
      )}
      {loading && <p className="text-slate-500">読み込み中…</p>}
      {error && <p className="text-red-600">エラー: {error}</p>}

      {!loading && filtered.length === 0 && (
        <p className="text-slate-500">該当する機器がありません。</p>
      )}

      {!loading && filtered.length > 0 && (
        <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
              <tr>
                <th className="px-4 py-2">区分</th>
                <th className="px-4 py-2">顧客</th>
                <th className="px-4 py-2">ホスト名</th>
                <th className="px-4 py-2">IPアドレス</th>
                <th className="px-4 py-2">シリアル</th>
                <th className="px-4 py-2">用途</th>
                <th className="px-4 py-2 text-right">世代</th>
                <th className="px-4 py-2">最終更新</th>
                <th className="px-4 py-2">作業者</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filtered.map((d) => (
                <tr key={d.id} className="hover:bg-slate-50">
                  <td className="px-4 py-2">
                    <RoleBadge role={d.identifiers.role} />
                  </td>
                  <td className="px-4 py-2">
                    <Link
                      to={`/devices/${encodeURIComponent(d.id)}`}
                      className="font-medium text-blue-700 hover:underline"
                    >
                      {d.identifiers.customer}
                    </Link>
                  </td>
                  <td className="px-4 py-2 mono">{d.identifiers.hostname}</td>
                  <td className="px-4 py-2 mono">{d.identifiers.ipAddress}</td>
                  <td className="px-4 py-2 mono text-xs text-slate-600">{d.identifiers.serialNumber || "—"}</td>
                  <td className="px-4 py-2">{d.identifiers.purpose}</td>
                  <td className="px-4 py-2 text-right mono">#{d.latestGeneration}</td>
                  <td className="px-4 py-2 text-slate-600">
                    {new Date(d.lastUpdatedAt).toLocaleString("ja-JP")}
                  </td>
                  <td className="px-4 py-2 text-slate-600">{d.lastOperator}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
