import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type {
  ConfigVersion,
  Device,
  DeviceIdentifiers,
} from "@config-manager/shared";
import { ROLE_LABELS } from "@config-manager/shared";
import { apiFetch, ApiError } from "../apiClient";
import { RoleBadge } from "../components/RoleBadge";

interface PromoteResult {
  created?: { id: string; generation: number };
  skipped?: boolean;
  reason?: string;
}

export function DeviceDetailPage() {
  const { key } = useParams<{ key: string }>();
  const decodedKey = key ? decodeURIComponent(key) : "";
  const [versions, setVersions] = useState<ConfigVersion[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [body, setBody] = useState<ConfigVersion | null>(null);
  const [identifiers, setIdentifiers] = useState<DeviceIdentifiers | null>(null);
  const [peers, setPeers] = useState<Device[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Promote-to-production form state (spare devices only).
  const [promoteIp, setPromoteIp] = useState("");
  const [promoting, setPromoting] = useState(false);
  const [promoteMsg, setPromoteMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!decodedKey) return;
    (async () => {
      try {
        const res = await apiFetch<{ versions: ConfigVersion[] }>(
          `/api/devices/${encodeURIComponent(decodedKey)}/versions`,
        );
        setVersions(res.versions);
      } catch (e) {
        setError(e instanceof ApiError ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    })();
  }, [decodedKey]);

  // Load the latest version's body by default for preview.
  useEffect(() => {
    if (versions.length === 0) return;
    const latest = versions[0];
    void loadVersion(latest.id);
  }, [versions]);

  // Once identifiers are known, fetch peer devices (same customer+hostname,
  // opposite role) to offer a 本番↔予備 comparison.
  useEffect(() => {
    if (!identifiers) return;
    const oppositeRole = identifiers.role === "production" ? "spare" : "production";
    (async () => {
      try {
        const res = await apiFetch<{ devices: Device[] }>(
          `/api/devices?customer=${encodeURIComponent(
            identifiers.customer,
          )}&hostname=${encodeURIComponent(identifiers.hostname)}&role=${oppositeRole}`,
        );
        setPeers(res.devices);
      } catch {
        /* best-effort */
      }
    })();
  }, [identifiers]);

  async function loadVersion(id: string) {
    try {
      const res = await apiFetch<{
        version: ConfigVersion;
        identifiers: DeviceIdentifiers;
      }>(`/api/versions/${id}`);
      setBody(res.version);
      setIdentifiers(res.identifiers);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    }
  }

  async function reloadVersions() {
    if (!decodedKey) return;
    try {
      const res = await apiFetch<{ versions: ConfigVersion[] }>(
        `/api/devices/${encodeURIComponent(decodedKey)}/versions`,
      );
      setVersions(res.versions);
    } catch {
      /* ignore */
    }
  }

  async function doPromote() {
    if (!body || !promoteIp.trim()) return;
    setPromoting(true);
    setPromoteMsg(null);
    try {
      const res = await apiFetch<PromoteResult>("/api/promote", {
        method: "POST",
        body: JSON.stringify({
          sourceVersionId: body.id,
          ipAddress: promoteIp.trim(),
        }),
      });
      if (res.skipped) {
        setPromoteMsg(`スキップ: ${res.reason ?? "本番はすでに同一コンフィグ"}`);
      } else {
        setPromoteMsg(
          `本番として登録しました（世代 #${res.created?.generation}）。一覧に戻って確認してください。`,
        );
        setPromoteIp("");
      }
      await reloadVersions();
    } catch (e) {
      setPromoteMsg(e instanceof ApiError ? e.message : String(e));
    } finally {
      setPromoting(false);
    }
  }

  function toggleSelect(id: string) {
    setSelected((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      if (prev.length >= 2) return [prev[1], id];
      return [...prev, id];
    });
  }

  const latestVersionId = versions[0]?.id;
  const diffHref =
    selected.length === 2
      ? `/diff?before=${selected[0]}&after=${selected[1]}`
      : null;

  const peerVerb =
    identifiers?.role === "production" ? "予備機" : "本番機";

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <div>
          <Link to="/" className="text-sm text-blue-700 hover:underline">
            ← 機器一覧へ
          </Link>
          <h1 className="mt-1 flex items-center gap-2 text-xl font-semibold text-slate-900">
            {identifiers
              ? `${identifiers.customer} / ${identifiers.hostname}`
              : decodedKey}
            {identifiers && <RoleBadge role={identifiers.role} />}
          </h1>
          {identifiers && (
            <p className="mt-1 text-sm text-slate-600">
              IP: <span className="mono">{identifiers.ipAddress}</span> · 用途:{" "}
              {identifiers.purpose}
              {identifiers.serialNumber && (
                <>
                  {" · "}シリアル:{" "}
                  <span className="mono">{identifiers.serialNumber}</span>
                </>
              )}
            </p>
          )}
        </div>
        {diffHref && (
          <Link
            to={diffHref}
            className="rounded-md bg-blue-600 px-3 py-2 text-sm text-white hover:bg-blue-700"
          >
            選択した2世代をDiff表示
          </Link>
        )}
      </div>

      {/* 本番↔予備 comparison panel */}
      {identifiers && latestVersionId && peers.length > 0 && (
        <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm">
          <div className="font-medium text-amber-900">
            {peerVerb}との比較（同じ顧客・ホスト名の{ROLE_LABELS[
              identifiers.role === "production" ? "spare" : "production"
            ]}機）
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            {peers.map((p) => (
              <Link
                key={p.id}
                to={`/diff?before=${latestVersionId}&after=${p.latestVersionId}`}
                className="flex items-center gap-2 rounded-md border border-amber-300 bg-white px-2.5 py-1.5 text-xs hover:bg-amber-100"
              >
                <RoleBadge role={p.identifiers.role} size="xs" />
                <span className="mono">{p.identifiers.ipAddress}</span>
                <span className="text-slate-500">
                  #{p.latestGeneration}
                </span>
                <span className="text-blue-700 underline">比較</span>
              </Link>
            ))}
          </div>
          <p className="mt-2 text-xs text-amber-700">
            ※ 最新世代同士を比較します。個別世代を選択する場合は各機器の詳細画面から選んでください。
          </p>
        </div>
      )}

      {/* 予備→本番 昇格パネル（予備機のときのみ表示） */}
      {identifiers?.role === "spare" && body && (
        <div className="mb-4 rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm">
          <div className="font-medium text-blue-900">
            本番機へ昇格（この予備機の最新コンフィグを本番として登録）
          </div>
          <p className="mt-1 text-xs text-blue-700">
            故障時の差し替えなどで予備機を本番運用に移す際、現在の世代 #{body.generation}{" "}
            のコンフィグを本番機として新世代登録します。シリアル番号は引き継がれます。
          </p>
          <div className="mt-2 flex flex-wrap items-end gap-2">
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-blue-800">
                本番 IPアドレス *
              </span>
              <input
                value={promoteIp}
                onChange={(e) => setPromoteIp(e.target.value)}
                placeholder="例: 192.168.1.1"
                className="w-56 rounded-md border border-blue-300 px-2 py-1 text-sm"
              />
            </label>
            <button
              onClick={doPromote}
              disabled={promoting || !promoteIp.trim()}
              className="rounded-md bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {promoting ? "登録中…" : "本番として登録"}
            </button>
          </div>
          {promoteMsg && (
            <p className="mt-2 text-xs text-blue-800">{promoteMsg}</p>
          )}
        </div>
      )}

      {loading && <p className="text-slate-500">読み込み中…</p>}
      {error && <p className="text-red-600">エラー: {error}</p>}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="lg:col-span-1">
          <h2 className="mb-2 text-sm font-semibold uppercase text-slate-500">
            世代（最新順）
          </h2>
          <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200 bg-white">
            {versions.map((v) => {
              const isSel = selected.includes(v.id);
              return (
                <li key={v.id}>
                  <button
                    onClick={() => toggleSelect(v.id)}
                    className={`flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-slate-50 ${
                      isSel ? "bg-blue-50" : ""
                    }`}
                  >
                    <span className="flex items-center gap-2">
                      <span
                        className={`h-3 w-3 rounded-full border ${
                          isSel
                            ? "border-blue-600 bg-blue-600"
                            : "border-slate-300"
                        }`}
                      />
                      <span className="mono font-medium">#{v.generation}</span>
                    </span>
                    <span className="text-xs text-slate-500">
                      {new Date(v.createdAt).toLocaleString("ja-JP")} · {v.lines}行
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          <p className="mt-2 text-xs text-slate-500">
            2つ選択するとDiffボタンが有効になります。
          </p>
        </div>

        <div className="lg:col-span-2">
          <h2 className="mb-2 text-sm font-semibold uppercase text-slate-500">
            {body ? `世代 #${body.generation} プレビュー` : "プレビュー"}
          </h2>
          {body ? (
            <div className="rounded-lg border border-slate-200 bg-white">
              {body.detected && (body.detected.vendor || body.detected.os) && (
                <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 bg-slate-50 px-3 py-2 text-xs">
                  <span className="font-semibold uppercase text-slate-500">自動検出</span>
                  <DetectedBadge label="ベンダー" value={body.detected.vendor} />
                  <DetectedBadge label="OS" value={body.detected.os} />
                  <DetectedBadge label="Ver" value={body.detected.osVersion} />
                  <DetectedBadge label="機種" value={body.detected.model} />
                  <span className="ml-auto text-slate-400">
                    信頼度 {(body.detected.confidence * 100).toFixed(0)}%
                  </span>
                </div>
              )}
              <div className="flex items-center justify-between border-b border-slate-100 px-3 py-2 text-xs text-slate-500">
                <span>
                  {body.lines}行 · {body.size}バイト · hash{" "}
                  <span className="mono">{body.hash.slice(0, 12)}…</span>
                </span>
                <div className="flex items-center gap-2">
                  <Link
                    to={`/versions/${body.id}/firewall?from=${encodeURIComponent(`/devices/${encodeURIComponent(decodedKey)}`)}`}
                    className="rounded border border-blue-300 bg-blue-50 px-2 py-0.5 text-blue-700 hover:bg-blue-100"
                  >
                    FW/ACLマトリクス
                  </Link>
                  <button
                    onClick={() => download(body)}
                    className="rounded border border-slate-300 px-2 py-0.5 hover:bg-slate-50"
                  >
                    ダウンロード
                  </button>
                  <button
                    onClick={() => loadVersion(body.id)}
                    className="rounded border border-slate-300 px-2 py-0.5 hover:bg-slate-50"
                  >
                    再読込
                  </button>
                </div>
              </div>
              <pre className="mono max-h-[70vh] overflow-auto px-3 py-2 text-xs leading-5">
                {body.body}
              </pre>
            </div>
          ) : (
            <p className="text-slate-500">世代を選択してください。</p>
          )}
        </div>
      </div>
    </div>
  );
}

function download(v: ConfigVersion) {
  const blob = new Blob([v.body], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `config-gen${v.generation}.txt`;
  a.click();
  URL.revokeObjectURL(url);
}

function DetectedBadge({ label, value }: { label: string; value: string }) {
  if (!value) return null;
  return (
    <span className="inline-flex items-center gap-1 rounded bg-white px-2 py-0.5 ring-1 ring-slate-200">
      <span className="text-slate-400">{label}</span>
      <span className="font-medium text-slate-800">{value}</span>
    </span>
  );
}
