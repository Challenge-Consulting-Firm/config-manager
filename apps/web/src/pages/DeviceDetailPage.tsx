import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import type {
  ConfigVersion,
  Device,
  DeviceIdentifiers,
} from "@config-manager/shared";
import {
  hasMinRole,
  MERAKI_DUMP_HEADER,
  ROLE_LABELS,
} from "@config-manager/shared";
import { apiFetch, ApiError } from "../apiClient";
import { useAuth } from "../auth";
import { RoleBadge } from "../components/RoleBadge";
import { DeviceFetchDialog } from "../components/DeviceFetchDialog";

interface PromoteResult {
  created?: { id: string; generation: number };
  skipped?: boolean;
  reason?: string;
}

/** 編集モーダルの対象バージョン。null で閉じる。 */
interface EditTarget {
  id: string;
  generation: number;
  ids: DeviceIdentifiers;
}

/** 削除確認の対象バージョン。null で閉じる。 */
interface DeleteTarget {
  id: string;
  generation: number;
  ids: DeviceIdentifiers;
}

export function DeviceDetailPage() {
  const { key } = useParams<{ key: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();
  const canOperate = hasMinRole(user?.role ?? "viewer", "operator");
  const canAdmin = hasMinRole(user?.role ?? "viewer", "admin");
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
  // 編集・削除 UI の状態。
  const [editTarget, setEditTarget] = useState<EditTarget | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  // 機器（全世代）一括削除ダイアログの表示状態。
  const [deleteDeviceOpen, setDeleteDeviceOpen] = useState(false);
  const [deletingDevice, setDeletingDevice] = useState(false);
  const [metaMsg, setMetaMsg] = useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);
  const [metaSubmitting, setMetaSubmitting] = useState(false);
  // コンフィグ取得ダイアログ（Telnet / SSH）の表示状態。
  const [fetchDialogOpen, setFetchDialogOpen] = useState(false);

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

  // 現在表示中のバージョンが Meraki 取得由来かを判定。
  // 保存済み本文は normalize でコメント行（`!` 始まり）が除去されるため、
  // ヘッダ行での判定は保存済み世代には効かない。アップロード時に生本文で
  // 計算・保存された detected.vendor を第一判定に使い、ヘッダ判定は
  // 後方互換（normalize 前の本文を扱うケース）として残す。
  const isMerakiDevice =
    body?.detected?.vendor === "Cisco Meraki" ||
    !!body?.body?.startsWith(MERAKI_DUMP_HEADER);

  // Meraki の network ID を抽出。再取得ボタンの遷移先で networkId の
  // ヒントとして使う（空でも /meraki 側で手入力・接続情報選択が可能）。
  const merakiNetworkId = (() => {
    // 本文の `! Network: name (N_xxx)` 行（normalize 前の本文がある場合のみ）。
    const fromBody = body?.body?.match(
      /^!\s*Network:\s+.+?\s+\(([LNQ]_[0-9a-zA-Z]+)\)/m,
    )?.[1];
    if (fromBody) return fromBody;
    // 保存済み世代ではヘッダ行が消えているため、取り込み時に purpose へ
    // 埋め込まれる `Meraki network <name> (L_xxx)` から拾うフォールバック。
    const fromPurpose = identifiers?.purpose?.match(
      /\(([LNQ]_[0-9a-zA-Z]+)\)/,
    )?.[1];
    return fromPurpose ?? "";
  })();

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
        {identifiers && (
          <div className="flex flex-wrap gap-2">
            {/* ローカルヘルパー経由の取得（Telnet / SSH・Issue #43）。ヘルパー
                起動中のみ有効。ダイアログ内で未検出時はセットアップ画面へ誘導する。 */}
            {canOperate && (
              <button
                onClick={() => {
                  setFetchDialogOpen(true);
                  setMetaMsg(null);
                }}
                className="rounded-md bg-indigo-600 px-3 py-2 text-sm text-white hover:bg-indigo-700"
              >
                Telnet / SSH で取得
              </button>
            )}
            {isMerakiDevice ? (
              <Link
                to={merakiRefetchHrefFor(
                  decodedKey,
                  identifiers,
                  merakiNetworkId,
                )}
                className="rounded-md bg-emerald-600 px-3 py-2 text-sm text-white hover:bg-emerald-700"
              >
                Meraki で再取得
              </Link>
            ) : (
              <Link
                to={uploadHrefFor(decodedKey, identifiers)}
                className="rounded-md bg-emerald-600 px-3 py-2 text-sm text-white hover:bg-emerald-700"
              >
                この機器に新世代をアップロード
              </Link>
            )}
            {/* 補助ボタン: Meraki 機器でも手動アップロードは可能 (ファイルを持ち込む場合等) */}
            {isMerakiDevice && (
              <Link
                to={uploadHrefFor(decodedKey, identifiers)}
                className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700 hover:bg-slate-50"
              >
                ファイルでアップロード
              </Link>
            )}
            {/* 本番機からその予備機（差し替え用）を登録する導線。顧客・ホスト名を
                引き継ぐことで、登録後に本番↔予備の比較（Diff）が自動で有効になる。 */}
            {identifiers.role === "production" && (
              <Link
                to={spareUploadHrefFor(decodedKey, identifiers)}
                className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800 hover:bg-amber-100"
              >
                予備機を登録
              </Link>
            )}
            {/* 機器自体を全世代まとめて削除する（admin のみ）。 */}
            {canAdmin && (
              <button
                onClick={() => {
                  setDeleteDeviceOpen(true);
                  setMetaMsg(null);
                }}
                className="rounded-md border border-red-300 bg-white px-3 py-2 text-sm text-red-700 hover:bg-red-50"
              >
                機器を削除
              </button>
            )}
          </div>
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

      {/* 予備→本番 昇格パネル（予備機 + operator 以上） */}
      {canOperate && identifiers?.role === "spare" && body && (
        <div className="mb-4 rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm">
          <div className="font-medium text-blue-900">
            本番機へ昇格（この予備機の最新コンフィグを本番として登録）
          </div>
          <p className="mt-1 text-xs text-blue-700">
            故障時の差し替えなどで予備機を本番運用に移す際、現在の世代 #{body.generation}{" "}
            のコンフィグを本番機として新世代登録します。シリアル番号は引き継がれます。
          </p>
          {body.lines === 0 && (
            <p className="mt-2 text-xs text-amber-700">
              ※ この予備機はまだコンフィグが登録されていません。「新世代をアップロード」で
              投入済みコンフィグを登録すると昇格できます。
            </p>
          )}
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
              disabled={promoting || !promoteIp.trim() || body.lines === 0}
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

      {metaMsg && (
        <div
          className={`mb-4 rounded-md border px-3 py-2 text-sm ${
            metaMsg.type === "success"
              ? "border-emerald-200 bg-emerald-50 text-emerald-800"
              : "border-red-200 bg-red-50 text-red-800"
          }`}
        >
          {metaMsg.text}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="lg:col-span-1">
          <h2 className="mb-2 text-sm font-semibold uppercase text-slate-500">
            世代（最新順）
          </h2>
          <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200 bg-white">
            {versions.map((v) => {
              const isSel = selected.includes(v.id);
              const versionIds: DeviceIdentifiers = {
                customer: identifiers?.customer ?? "",
                hostname: identifiers?.hostname ?? "",
                ipAddress: identifiers?.ipAddress ?? "",
                purpose: identifiers?.purpose ?? "",
                serialNumber: identifiers?.serialNumber ?? "",
                role: identifiers?.role ?? "production",
              };
              return (
                <li key={v.id} className="group relative">
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
                  {/* ホバー時に右上にアクションボタンを表示 */}
                  <div className="pointer-events-none absolute right-2 top-1.5 flex gap-1 opacity-0 transition group-hover:opacity-100">
                    {canOperate && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setEditTarget({
                            id: v.id,
                            generation: v.generation,
                            ids: versionIds,
                          });
                          setMetaMsg(null);
                        }}
                        className="pointer-events-auto rounded border border-slate-300 bg-white px-1.5 py-0.5 text-xs text-slate-700 hover:bg-slate-100"
                      >
                        編集
                      </button>
                    )}
                    {canAdmin && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setDeleteTarget({
                            id: v.id,
                            generation: v.generation,
                            ids: versionIds,
                          });
                          setMetaMsg(null);
                        }}
                        className="pointer-events-auto rounded border border-red-300 bg-white px-1.5 py-0.5 text-xs text-red-700 hover:bg-red-50"
                      >
                        削除
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
          <p className="mt-2 text-xs text-slate-500">
            2つ選択するとDiffボタンが有効になります。世代右上に編集/削除ボタンがあります（ホバーで表示）。
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
                  <Link
                    to={`/versions/${body.id}/routing?from=${encodeURIComponent(`/devices/${encodeURIComponent(decodedKey)}`)}`}
                    className="rounded border border-blue-300 bg-blue-50 px-2 py-0.5 text-blue-700 hover:bg-blue-100"
                  >
                    ルーティング
                  </Link>
                  <Link
                    to={`/versions/${body.id}/wireless?from=${encodeURIComponent(`/devices/${encodeURIComponent(decodedKey)}`)}`}
                    className="rounded border border-blue-300 bg-blue-50 px-2 py-0.5 text-blue-700 hover:bg-blue-100"
                  >
                    無線SSID/AP
                  </Link>
                  <Link
                    to={`/versions/${body.id}/vlan?from=${encodeURIComponent(`/devices/${encodeURIComponent(decodedKey)}`)}`}
                    className="rounded border border-blue-300 bg-blue-50 px-2 py-0.5 text-blue-700 hover:bg-blue-100"
                  >
                    VLAN構成
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

      {/* 編集モーダル */}
      {editTarget && (
        <EditVersionModal
          target={editTarget}
          submitting={metaSubmitting}
          onClose={() => setEditTarget(null)}
          onSubmit={async (fields) => {
            setMetaSubmitting(true);
            setMetaMsg(null);
            try {
              await apiFetch(`/api/versions/${editTarget.id}`, {
                method: "PUT",
                body: JSON.stringify(fields),
              });
              setMetaMsg({
                type: "success",
                text: `世代 #${editTarget.generation} のメタ情報を更新しました。`,
              });
              setEditTarget(null);
              // 表示中のバージョンが更新された場合は再読み込み。
              if (body?.id === editTarget.id) {
                await loadVersion(editTarget.id);
              }
              await reloadVersions();
            } catch (e) {
              setMetaMsg({
                type: "error",
                text: e instanceof ApiError ? e.message : String(e),
              });
            } finally {
              setMetaSubmitting(false);
            }
          }}
        />
      )}

      {/* 削除確認ダイアログ */}
      {deleteTarget && (
        <DeleteVersionDialog
          target={deleteTarget}
          submitting={metaSubmitting}
          onClose={() => setDeleteTarget(null)}
          onConfirm={async () => {
            setMetaSubmitting(true);
            setMetaMsg(null);
            try {
              await apiFetch(`/api/versions/${deleteTarget.id}`, {
                method: "DELETE",
              });
              setMetaMsg({
                type: "success",
                text: `世代 #${deleteTarget.generation} を削除しました。`,
              });
              setDeleteTarget(null);
              // 表示中のバージョンが削除された場合は一覧へ戻る。
              if (body?.id === deleteTarget.id) {
                setBody(null);
              }
              await reloadVersions();
            } catch (e) {
              setMetaMsg({
                type: "error",
                text: e instanceof ApiError ? e.message : String(e),
              });
            } finally {
              setMetaSubmitting(false);
            }
          }}
        />
      )}

      {/* 機器（全世代）一括削除の確認ダイアログ */}
      {deleteDeviceOpen && identifiers && (
        <DeleteDeviceDialog
          identifiers={identifiers}
          versionCount={versions.length}
          submitting={deletingDevice}
          onClose={() => setDeleteDeviceOpen(false)}
          onConfirm={async () => {
            setDeletingDevice(true);
            setMetaMsg(null);
            try {
              const res = await apiFetch<{ ok: boolean; deletedCount: number }>(
                `/api/devices/${encodeURIComponent(decodedKey)}`,
                { method: "DELETE" },
              );
              // 削除完了後は機器一覧へ戻る（この機器はもう存在しない）。
              navigate("/", {
                replace: true,
                state: {
                  flash: `機器「${identifiers.hostname}」を削除しました（${res.deletedCount} 世代）。`,
                },
              });
            } catch (e) {
              setMetaMsg({
                type: "error",
                text: e instanceof ApiError ? e.message : String(e),
              });
              setDeleteDeviceOpen(false);
            } finally {
              setDeletingDevice(false);
            }
          }}
        />
      )}

      {/* コンフィグ取得ダイアログ（ローカルヘルパー経由・Issue #43） */}
      {fetchDialogOpen && identifiers && (
        <DeviceFetchDialog
          identifiers={identifiers}
          onClose={() => setFetchDialogOpen(false)}
          onCompleted={() => {
            // 世代登録（またはスキップ）後に一覧を再読込。
            void reloadVersions();
          }}
        />
      )}
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

/** Build the /upload URL with identifiers pre-filled, so the same device can
 *  receive a new config generation without re-typing its metadata. Includes
 *  a `from` param so the upload page can navigate back here. */
function uploadHrefFor(
  deviceKey: string,
  ids: DeviceIdentifiers,
): string {
  const from = `/devices/${encodeURIComponent(deviceKey)}`;
  const q = new URLSearchParams({
    customer: ids.customer,
    hostname: ids.hostname,
    ipAddress: ids.ipAddress,
    purpose: ids.purpose,
    serialNumber: ids.serialNumber,
    role: ids.role,
    from,
  });
  return `/upload?${q.toString()}`;
}

/** Build the /upload URL for registering a SPARE of this (production) device.
 *  Carries only customer + hostname so the spare is linked to the target for
 *  本番↔予備 comparison; IP・シリアル・コンフィグ は予備機側で新規入力するため
 *  引き継がない。role=spare でアップロード画面を予備機モードにする。 */
function spareUploadHrefFor(
  deviceKey: string,
  ids: DeviceIdentifiers,
): string {
  const from = `/devices/${encodeURIComponent(deviceKey)}`;
  const q = new URLSearchParams({
    customer: ids.customer,
    hostname: ids.hostname,
    role: "spare",
    from,
  });
  return `/upload?${q.toString()}`;
}

/** Build the /meraki URL with identifiers pre-filled, so the same Meraki
 *  device can be re-fetched without re-typing its metadata. The networkId is
 *  extracted from the previous config dump and passed so the user can pick it
 *  up at the credentials selector or paste into the manual input. */
function merakiRefetchHrefFor(
  deviceKey: string,
  ids: DeviceIdentifiers,
  networkId: string,
): string {
  const from = `/devices/${encodeURIComponent(deviceKey)}`;
  const q = new URLSearchParams({
    customer: ids.customer,
    hostname: ids.hostname,
    ipAddress: ids.ipAddress,
    purpose: ids.purpose,
    serialNumber: ids.serialNumber,
    role: ids.role,
    networkId,
    from,
  });
  return `/meraki?${q.toString()}`;
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

/** バージョンメタ情報編集モーダル。
 *  編集可能なのは用途 (purpose) / メモ (note) / シリアル番号 / IPアドレス / 顧客 / ホスト名。
 *  コンフィグ本文・hash・generation は変更不可。 */
function EditVersionModal({
  target,
  submitting,
  onClose,
  onSubmit,
}: {
  target: EditTarget;
  submitting: boolean;
  onClose: () => void;
  onSubmit: (fields: {
    purpose?: string;
    note?: string;
    serialNumber?: string;
    customer?: string;
    hostname?: string;
    ipAddress?: string;
  }) => Promise<void>;
}) {
  const [customer, setCustomer] = useState(target.ids.customer);
  const [hostname, setHostname] = useState(target.ids.hostname);
  const [ipAddress, setIpAddress] = useState(target.ids.ipAddress);
  const [purpose, setPurpose] = useState(target.ids.purpose);
  const [serialNumber, setSerialNumber] = useState(target.ids.serialNumber);
  const [note, setNote] = useState(""); // note は詳細 API から取得していないので空欄から開始
  const inputCls =
    "w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-hidden focus:ring-1 focus:ring-blue-500";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={onClose}
    >
      <div
        className="max-h-[90vh] w-full max-w-lg overflow-auto rounded-lg bg-white p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-1 text-lg font-semibold text-slate-900">
          世代 #{target.generation} のメタ情報を編集
        </h2>
        <p className="mb-4 text-xs text-slate-500">
          コンフィグ本文・世代番号は変更できません。空文字を送信するとそのフィールドはクリアされます。
        </p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase text-slate-500">顧客</span>
            <input value={customer} onChange={(e) => setCustomer(e.target.value)} className={inputCls} />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase text-slate-500">ホスト名</span>
            <input value={hostname} onChange={(e) => setHostname(e.target.value)} className={inputCls} />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase text-slate-500">IPアドレス *</span>
            <input value={ipAddress} onChange={(e) => setIpAddress(e.target.value)} className={inputCls} />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase text-slate-500">シリアル番号</span>
            <input value={serialNumber} onChange={(e) => setSerialNumber(e.target.value)} className={inputCls} />
          </label>
          <label className="block sm:col-span-2">
            <span className="mb-1 block text-xs font-medium uppercase text-slate-500">用途</span>
            <input value={purpose} onChange={(e) => setPurpose(e.target.value)} className={inputCls} />
          </label>
          <label className="block sm:col-span-2">
            <span className="mb-1 block text-xs font-medium uppercase text-slate-500">メモ</span>
            <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} className={inputCls} />
          </label>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50"
          >
            キャンセル
          </button>
          <button
            disabled={submitting || !ipAddress.trim()}
            onClick={() =>
              onSubmit({
                customer: customer.trim(),
                hostname: hostname.trim(),
                ipAddress: ipAddress.trim(),
                purpose: purpose.trim(),
                serialNumber: serialNumber.trim(),
                note,
              })
            }
            className="rounded-md bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {submitting ? "保存中…" : "保存"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** 機器（論理デバイス）を全世代まとめて削除する確認ダイアログ。
 *  バージョン単体削除より影響が大きいため、対象と件数を明示する。 */
function DeleteDeviceDialog({
  identifiers,
  versionCount,
  submitting,
  onClose,
  onConfirm,
}: {
  identifiers: DeviceIdentifiers;
  versionCount: number;
  submitting: boolean;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-lg bg-white p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-2 text-lg font-semibold text-red-700">
          機器を削除しますか？
        </h2>
        <p className="mb-1 text-sm text-slate-700">
          対象: {identifiers.customer} / {identifiers.hostname}
        </p>
        <p className="mb-4 text-sm text-slate-700">
          IP: <span className="mono">{identifiers.ipAddress}</span> ·{" "}
          {ROLE_LABELS[identifiers.role]}機
        </p>
        <div className="mb-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
          <span className="font-semibold">注意:</span>{" "}
          この機器に紐づく<strong>全 {versionCount} 世代</strong>のコンフィグをまとめて削除します。
          削除すると復元できません。バックアップが必要な場合は先にダウンロードしてください。
        </div>
        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50"
          >
            キャンセル
          </button>
          <button
            disabled={submitting}
            onClick={onConfirm}
            className="rounded-md bg-red-600 px-4 py-2 text-sm text-white hover:bg-red-700 disabled:opacity-50"
          >
            {submitting ? "削除中…" : "機器を削除する"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** バージョン削除の確認ダイアログ。 */
function DeleteVersionDialog({
  target,
  submitting,
  onClose,
  onConfirm,
}: {
  target: DeleteTarget;
  submitting: boolean;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-lg bg-white p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-2 text-lg font-semibold text-red-700">
          世代 #{target.generation} を削除しますか？
        </h2>
        <p className="mb-1 text-sm text-slate-700">
          対象: {target.ids.customer} / {target.ids.hostname}
        </p>
        <p className="mb-4 text-sm text-slate-700">
          IP: <span className="mono">{target.ids.ipAddress}</span>
        </p>
        <div className="mb-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          <span className="font-semibold">注意:</span> 削除すると世代の復元はできません。コンフィグ本文のバックアップが必要な場合は先にダウンロードしてください。
          世代の歯抜けが生じますが、次回アップロード時の世代番号は最大値+1になります。
        </div>
        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50"
          >
            キャンセル
          </button>
          <button
            disabled={submitting}
            onClick={onConfirm}
            className="rounded-md bg-red-600 px-4 py-2 text-sm text-white hover:bg-red-700 disabled:opacity-50"
          >
            {submitting ? "削除中…" : "削除する"}
          </button>
        </div>
      </div>
    </div>
  );
}
