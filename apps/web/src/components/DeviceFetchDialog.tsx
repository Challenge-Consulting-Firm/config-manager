import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  detectDeviceInfo,
  HELPER_DEFAULT_PORTS,
  HELPER_DEFAULT_TIMEOUTS,
  HELPER_ERROR_LABELS,
  type DeviceIdentifiers,
  type DeviceDetection,
  type HelperFetchResponse,
  type HelperOsHint,
  type HelperProtocol,
  type Role,
} from "@config-manager/shared";
import { apiFetch, ApiError } from "../apiClient";
import {
  detectHelper,
  fetchConfigViaHelper,
  HELPER_DETECT_TIMEOUT_INTERACTIVE_MS,
  type HelperPort,
} from "../utils/helperClient";

/**
 * コンフィグ取得ダイアログ（Telnet / SSH）。
 *
 * ローカルヘルパー経由で NW 機器からコンフィグを取得し、
 * 取得した本文を既存の `/api/upload` フロー（same-origin + cookie セッション）
 * で世代登録する。パスワード類は BFF には送信されず、ヘルパーとの通信にのみ
 * 使われる（設計は Issue #43 最終コメント）。
 *
 * `note` に `source=local-helper` / プロトコル / 対象 IP / 使用コマンドを記録し、
 * 作業履歴で取得経路が追えるようにする。
 */
export function DeviceFetchDialog({
  identifiers,
  onClose,
  onCompleted,
}: {
  identifiers: DeviceIdentifiers;
  onClose: () => void;
  /** 世代登録完了（またはスキップ）時に呼ばれる。一覧再読込などに使う。 */
  onCompleted: () => void;
}) {
  // ヘルパー検出状態。
  const [helperPort, setHelperPort] = useState<HelperPort | null>(null);
  const [probing, setProbing] = useState(true);

  // 接続情報（都度入力）。ホストは既定で identifiers.ipAddress を補完。
  const [host, setHost] = useState(identifiers.ipAddress ?? "");
  // プロトコルは既存運用を変えないため Telnet を既定にする（SSH 対応機器では
  // SSH を選ぶよう UI で促す）。
  const [protocol, setProtocol] = useState<HelperProtocol>("telnet");
  const [port, setPort] = useState<number>(HELPER_DEFAULT_PORTS.telnet);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [enablePassword, setEnablePassword] = useState("");
  const [osHint, setOsHint] = useState<HelperOsHint>("cisco-ios");
  const [commandOverride, setCommandOverride] = useState("");

  // 実行状態。
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<
    "idle" | "fetching" | "uploading" | "done"
  >("idle");
  const [fetchResult, setFetchResult] = useState<HelperFetchResponse | null>(
    null,
  );
  const [detected, setDetected] = useState<DeviceDetection | null>(null);
  const [uploadMsg, setUploadMsg] = useState<{
    type: "ok" | "err" | "info";
    text: string;
    /** 補助情報（ヘルパーが返す英語の詳細メッセージなど）。 */
    detail?: string;
  } | null>(null);

  // 初回マウントでヘルパー検出。
  //
  // ダイアログを開く操作が起点なので長めのタイムアウトを使う。Local Network
  // Access の権限が未応答の場合、ここで権限プロンプトが出る。短く abort すると
  // プロンプトが閉じてしまい、いつまでも未検出のままになる。
  const probe = useCallback(async () => {
    setProbing(true);
    try {
      const found = await detectHelper(HELPER_DETECT_TIMEOUT_INTERACTIVE_MS);
      setHelperPort(found?.port ?? null);
    } finally {
      setProbing(false);
    }
  }, []);

  useEffect(() => {
    void probe();
  }, [probe]);

  /**
   * プロトコル切替。ポートが切替前プロトコルの既定値のままなら、新しい
   * プロトコルの既定値へ追従させる（ユーザーが手で変えた値は保持する）。
   */
  function changeProtocol(next: HelperProtocol) {
    setPort((prev) =>
      prev === HELPER_DEFAULT_PORTS[protocol] ? HELPER_DEFAULT_PORTS[next] : prev,
    );
    setProtocol(next);
  }

  async function runFetch() {
    if (!helperPort) return;
    if (!host.trim() || !username.trim() || !password) {
      setUploadMsg({ type: "err", text: "ホスト・ユーザー名・パスワードは必須です" });
      return;
    }
    // generic（その他）選択時はコンフィグ取得コマンドの上書きを必須とする
    // （ヘルパー側が既定コマンドを持たないため）。
    if (osHint === "generic" && !commandOverride.trim()) {
      setUploadMsg({
        type: "err",
        text: "「その他」機種の場合はコンフィグ取得コマンドの指定が必須です",
      });
      return;
    }
    setBusy(true);
    setPhase("fetching");
    setFetchResult(null);
    setDetected(null);
    setUploadMsg(null);
    try {
      const res = await fetchConfigViaHelper(helperPort, {
        host: host.trim(),
        port,
        protocol,
        username: username.trim(),
        password,
        enablePassword: enablePassword || undefined,
        osHint,
        commandOverride: commandOverride.trim() || null,
        timeouts: HELPER_DEFAULT_TIMEOUTS,
      });
      setFetchResult(res);
      if (res.ok) {
        // 本文からメタ情報を補完（既存 upload フローと同等のクライアント側検出）。
        const d = detectDeviceInfo(res.body);
        setDetected(d.confidence > 0 ? d : null);
        setPhase("idle");
      } else {
        // 失敗コードに応じた日本語メッセージを主に表示し、機器やヘルパーが
        // 返した生の文言（"% Invalid input detected…"、ホスト鍵の指紋、
        // known_hosts のパスなど）は詳細として併記する。生の文言だけでは
        // 何を直せばよいか分からないため、ラベルを主にする。
        const label =
          HELPER_ERROR_LABELS[res.code] ?? "コンフィグの取得に失敗しました";
        setUploadMsg({
          type: "err",
          text: label,
          detail: res.message?.trim() || undefined,
        });
        setPhase("idle");
      }
    } finally {
      setBusy(false);
      // 【セキュリティ】パスワード類は取得要求の完了（成功・失敗問わず）直後に
      // state から消去する（設計要件: 取得後にメモリ破棄）。フェーズ1は都度入力
      // のため、再取得時は再入力が必要。
      setPassword("");
      setEnablePassword("");
    }
  }

  /** 取得した本文を既存 `/api/upload` で世代登録する。 */
  async function uploadFetched(body: string, command: string) {
    setBusy(true);
    setPhase("uploading");
    setUploadMsg(null);
    try {
      // note に取得経路・対象・コマンドを残す（作業履歴で追跡可能にする）。
      const noteParts = [
        "source=local-helper",
        `protocol=${protocol}`,
        `host=${host.trim()}`,
        `command=${command}`,
      ];
      const note = noteParts.join(" / ");
      const res = await apiFetch<{
        created?: { id: string; generation: number; hash: string };
        skipped?: boolean;
        reason?: string;
        strippedLines?: number;
      }>("/api/upload", {
        method: "POST",
        body: JSON.stringify({
          customer: identifiers.customer,
          hostname: identifiers.hostname,
          ipAddress: identifiers.ipAddress,
          purpose: identifiers.purpose,
          serialNumber: identifiers.serialNumber,
          role: (identifiers.role ?? "production") as Role,
          note,
          body,
        }),
      });
      if (res.skipped) {
        setUploadMsg({
          type: "info",
          text: `変更なし — 最新世代と同一のコンフィグです。新世代は作成されませんでした。${
            res.reason ? `（${res.reason}）` : ""
          }`,
        });
      } else {
        setUploadMsg({
          type: "ok",
          text: `世代 #${res.created?.generation} を登録しました（${
            res.strippedLines ?? 0
          } 行のコメント/空白行を除去）。`,
        });
      }
      setPhase("done");
      onCompleted();
    } catch (e) {
      setUploadMsg({
        type: "err",
        text: e instanceof ApiError ? e.message : String(e),
      });
      setPhase("idle");
    } finally {
      setBusy(false);
    }
  }

  const inputCls =
    "w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="max-h-[90vh] w-full max-w-2xl overflow-auto rounded-lg bg-white p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-slate-900">
            コンフィグを取得（Telnet / SSH）
          </h2>
          <button
            onClick={onClose}
            className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
            aria-label="閉じる"
          >
            ✕
          </button>
        </div>

        <p className="mb-3 text-xs text-slate-500">
          対象機器: {identifiers.customer} / {identifiers.hostname}（
          <span className="mono">{identifiers.ipAddress}</span>）
        </p>

        {/* ヘルパー検出状態 */}
        <div className="mb-4 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm">
          {probing ? (
            <span className="text-slate-600">ヘルパーを検出中…</span>
          ) : helperPort ? (
            <span className="text-emerald-700">
              ✓ ヘルパー稼働中（ポート {helperPort}）
            </span>
          ) : (
            <span className="flex flex-wrap items-center gap-2 text-amber-700">
              ⚠ ヘルパーが起動していません。
              <Link
                to="/helper"
                onClick={onClose}
                className="rounded border border-amber-300 bg-white px-2 py-0.5 text-xs hover:bg-amber-50"
              >
                セットアップ画面へ
              </Link>
              <button
                onClick={() => void probe()}
                className="rounded border border-slate-300 bg-white px-2 py-0.5 text-xs hover:bg-slate-50"
              >
                再検出
              </button>
            </span>
          )}
        </div>

        {/* 接続情報入力（都度入力） */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase text-slate-500">
              ホスト *
            </span>
            <input
              value={host}
              onChange={(e) => setHost(e.target.value)}
              placeholder="192.168.1.1"
              className={inputCls}
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase text-slate-500">
              プロトコル
            </span>
            <select
              value={protocol}
              onChange={(e) => changeProtocol(e.target.value as HelperProtocol)}
              className={inputCls}
            >
              <option value="telnet">Telnet（平文）</option>
              <option value="ssh">SSH（暗号化）</option>
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase text-slate-500">
              ポート
            </span>
            <input
              type="number"
              value={port}
              onChange={(e) =>
                setPort(Number(e.target.value) || HELPER_DEFAULT_PORTS[protocol])
              }
              min={1}
              max={65535}
              className={inputCls}
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase text-slate-500">
              ユーザー名 *
            </span>
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="off"
              className={inputCls}
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase text-slate-500">
              パスワード *
            </span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="off"
              className={inputCls}
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase text-slate-500">
              enable パスワード（任意）
            </span>
            <input
              type="password"
              value={enablePassword}
              onChange={(e) => setEnablePassword(e.target.value)}
              autoComplete="off"
              placeholder="Cisco 特権モード用"
              className={inputCls}
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase text-slate-500">
              機種（osHint）
            </span>
            <select
              value={osHint}
              onChange={(e) => setOsHint(e.target.value as HelperOsHint)}
              className={inputCls}
            >
              <option value="cisco-ios">Cisco IOS / IOS-XE</option>
              <option value="yamaha-rt">YAMAHA RT（ルーター・show config）</option>
              {/* SWX は RT と CLI 体系が違う。RT を選ぶと機器が
                  "% Invalid input detected" を返して取得に失敗する。 */}
              <option value="yamaha-swx">
                YAMAHA SWX（スイッチ・show running-config）
              </option>
              {/* generic は Issue #43 のコマンド上書き（決定事項）のために残すが、
                  フェーズ 1 の正式サポート対象外。コマンド上書き必須。 */}
              <option value="generic">その他（フェーズ1対象外・コマンド指定必須）</option>
            </select>
            {osHint === "yamaha-rt" && (
              <span className="mt-1 block text-[11px] text-slate-500">
                SWX2100/2200/2300/3100/3200 などのスイッチは「YAMAHA SWX」を
                選んでください。
              </span>
            )}
          </label>
          <label className="block sm:col-span-2">
            <span className="mb-1 block text-xs font-medium uppercase text-slate-500">
              コンフィグ取得コマンドの上書き（任意）
              {osHint === "generic" && (
                <span className="ml-1 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium normal-case text-amber-700">
                  「その他」選択時は必須
                </span>
              )}
            </span>
            <input
              value={commandOverride}
              onChange={(e) => setCommandOverride(e.target.value)}
              placeholder="例: show running-config（空欄で osHint 既定値）"
              className={inputCls}
            />
          </label>
        </div>

        {/* プロトコル別の注意書き */}
        {protocol === "telnet" ? (
          <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            <span className="font-semibold">【Telnet は平文です】</span>
            ユーザー名・パスワードが LAN 上を暗号化されずに流れます。機器が SSH に
            対応している場合は SSH を選んでください。
          </div>
        ) : (
          <div className="mt-3 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
            <span className="font-semibold">【SSH のホスト鍵】</span>
            初回接続時のホスト鍵をヘルパーの known_hosts に記録し、以降は一致を
            検証します。機器の交換・初期化で鍵が変わった場合は取得が
            「ホスト鍵不一致」で失敗するため、該当行を削除してから再取得してください。
          </div>
        )}

        {/* 取得ボタン */}
        <div className="mt-4 flex items-center justify-between">
          <p className="text-xs text-slate-500">
            パスワード類はヘルパーとの通信にのみ使われ、BFF には送信されません。
          </p>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="rounded-md border border-slate-300 px-3 py-2 text-sm hover:bg-slate-50"
            >
              閉じる
            </button>
            <button
              onClick={() => void runFetch()}
              disabled={
                busy || !helperPort || phase === "fetching" || phase === "uploading"
              }
              className="rounded-md bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {phase === "fetching"
                ? "取得中…"
                : protocol === "ssh"
                  ? "SSH で取得"
                  : "Telnet で取得"}
            </button>
          </div>
        </div>

        {/* 取得結果 */}
        {fetchResult?.ok && (
          <div className="mt-4 rounded-md border border-blue-200 bg-blue-50 p-3 text-sm">
            <div className="font-medium text-blue-900">
              コンフィグを取得しました（{fetchResult.meta.elapsedMs}ms ·{" "}
              {fetchResult.body.length}文字 · {fetchResult.meta.sourceEncoding}）
            </div>
            {detected && (detected.vendor || detected.os) && (
              <p className="mt-1 text-xs text-blue-800">
                自動識別: {detected.vendor} / {detected.os}
                {detected.osVersion && ` v${detected.osVersion}`}
                {detected.model && ` · 機種 ${detected.model}`}
              </p>
            )}
            <p className="mt-1 text-xs text-blue-700">
              プロンプト: <code className="mono">{fetchResult.meta.prompt}</code> ·
              コマンド: <code className="mono">{fetchResult.meta.command}</code>
            </p>
            <div className="mt-2 flex items-center justify-between">
              <span className="text-xs text-blue-700">
                この本文を新世代として登録しますか？（同一 hash の場合はスキップされます）
              </span>
              <button
                onClick={() =>
                  void uploadFetched(fetchResult.body, fetchResult.meta.command)
                }
                disabled={busy || phase === "uploading" || phase === "done"}
                className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs text-white hover:bg-emerald-700 disabled:opacity-50"
              >
                {phase === "uploading"
                  ? "登録中…"
                  : phase === "done"
                    ? "登録済み"
                    : "新世代として登録"}
              </button>
            </div>
          </div>
        )}

        {/* メッセージ（取得失敗・登録結果） */}
        {uploadMsg && (
          <div
            className={`mt-3 rounded-md border px-3 py-2 text-sm ${
              uploadMsg.type === "ok"
                ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                : uploadMsg.type === "err"
                  ? "border-red-200 bg-red-50 text-red-800"
                  : "border-slate-200 bg-slate-50 text-slate-700"
            }`}
          >
            {uploadMsg.text}
            {uploadMsg.detail && (
              <p className="mt-1 break-words text-xs opacity-80">
                詳細: {uploadMsg.detail}
              </p>
            )}
          </div>
        )}

        {/* 取得本文プレビュー（先頭のみ） */}
        {fetchResult?.ok && (
          <details className="mt-3">
            <summary className="cursor-pointer text-xs text-slate-500">
              取得本文のプレビュー（先頭 2000 文字）
            </summary>
            <pre className="mt-2 max-h-60 overflow-auto rounded bg-slate-900 p-3 text-xs text-slate-100">
              {fetchResult.body.slice(0, 2000)}
              {fetchResult.body.length > 2000 ? "\n…（省略）" : ""}
            </pre>
          </details>
        )}
      </div>
    </div>
  );
}
