import { useCallback, useEffect, useRef, useState } from "react";
import {
  detectHelper,
  fetchHelperManifest,
  detectHelperAssetKey,
  resolveHelperAsset,
  shutdownHelper,
  HELPER_DETECT_TIMEOUT_INTERACTIVE_MS,
  type HelperLatestManifest,
  type HelperAssetKey,
} from "../utils/helperClient";

/** 自動ポーリングの最大回数（4 秒間隔）。以降は手動の「接続テスト」に委ねる。 */
const MAX_AUTO_POLLS = 5;

/**
 * 「ローカル取得のセットアップ」画面。
 *
 * ヘルパー（Go 製ポータブルアプリ）のダウンロード・起動手順・接続テスト・
 * 停止・撤去手順をまとめる。ヘルパーが検出されると機器詳細画面の
 * 「Telnet 取得」ボタンが活性化する。
 *
 * 設計の詳細は Issue #43 の最終コメント（確定設計）を参照。
 */
export function HelperSetupPage() {
  const [manifest, setManifest] = useState<HelperLatestManifest | null>(null);
  const [preferredKey, setPreferredKey] = useState<HelperAssetKey | null>(null);
  const [resolvedAsset, setResolvedAsset] = useState<
    { url: string; sha256?: string } | null
  >(null);
  const [detectedPort, setDetectedPort] = useState<number | null>(null);
  const [helperVersion, setHelperVersion] = useState<string | null>(null);
  const [probing, setProbing] = useState(false);
  const [shuttingDown, setShuttingDown] = useState(false);
  const [msg, setMsg] = useState<{ type: "ok" | "err" | "info"; text: string } | null>(
    null,
  );
  const pollTimer = useRef<number | null>(null);
  // 検出処理が pending 中かどうか。権限プロンプト表示中に次の検出が重ならない
  // ようにする（setProbing は非同期反映のため setInterval からは参照できない）。
  const probingRef = useRef(false);

  // 初回マウントでマニフェスト取得と OS 判定。
  useEffect(() => {
    void fetchHelperManifest().then((m) => {
      setManifest(m);
      const key = detectHelperAssetKey();
      setPreferredKey(key);
      setResolvedAsset(resolveHelperAsset(m, key));
    });
    // 同時にヘルパー検出を 1 回試す。
    void probeOnce();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stopPolling = useCallback(() => {
    if (pollTimer.current) {
      clearInterval(pollTimer.current);
      pollTimer.current = null;
    }
  }, []);

  // 検出されていない場合は定期ポーリング（セットアップ直後の検出用）。
  //
  // ただし無期限には回さない。ユーザーが Local Network Access の権限を
  // 「ブロック」した場合、以後の検出は即座に失敗し続けるため、回し続けても
  // 意味がない。数回で打ち切り、以降は「接続テスト」ボタンに委ねる。
  useEffect(() => {
    if (detectedPort) {
      stopPolling();
      return;
    }
    let remaining = MAX_AUTO_POLLS;
    pollTimer.current = window.setInterval(() => {
      if (remaining <= 0) {
        stopPolling();
        return;
      }
      remaining -= 1;
      void probeOnce();
    }, 4000);
    return stopPolling;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detectedPort]);

  // 検出は常に長いタイムアウトで待つ。
  //
  // 「長い＝遅い」ではない。ヘルパーが起動していなければ 127.0.0.1 への接続は
  // 即 ECONNREFUSED で返るため、実際に待たされるのは Local Network Access の
  // 権限プロンプトが表示されている間だけ、つまり待つべきときだけである。
  // 逆に短いタイムアウトで abort すると、そのプロンプトを自分で閉じてしまい
  // 永久に未検出のままになる。
  //
  // pending 中の多重実行は probingRef で抑止する（ポーリングが重なると
  // プロンプトが並んで出るため）。
  const probeOnce = useCallback(async (
    timeoutMs = HELPER_DETECT_TIMEOUT_INTERACTIVE_MS,
  ): Promise<number | null> => {
    if (probingRef.current) return null;
    probingRef.current = true;
    setProbing(true);
    try {
      const found = await detectHelper(timeoutMs);
      if (found) {
        setDetectedPort(found.port);
        setHelperVersion(found.status.version);
        return found.port;
      } else {
        setDetectedPort(null);
        setHelperVersion(null);
        return null;
      }
    } finally {
      probingRef.current = false;
      setProbing(false);
    }
  }, []);

  async function retest() {
    setMsg(null);
    // 背景ポーリングを止めてから実行する。ポーリングの abort が
    // Local Network Access の権限プロンプトを閉じてしまうため。
    stopPolling();
    // probeOnce の戻り値（最新の検出結果）を直接使う。React state は非同期更新で
    // 同じ関数内では古い値になるため、闭包の detectedPort を参照すると成败メッセージが
    // 反転する。
    // ユーザー操作起点なので長いタイムアウトを使い、権限プロンプトへ
    // 応答する時間を確保する。
    const port = await probeOnce(HELPER_DETECT_TIMEOUT_INTERACTIVE_MS);
    setMsg(
      port
        ? { type: "ok", text: "ヘルパーを検出しました。" }
        : {
            type: "info",
            text:
              "ヘルパーは検出されませんでした。起動手順に従ってヘルパーを起動してください。" +
              "起動済みの場合は、ブラウザの「ローカルネットワークへのアクセス」が" +
              "ブロックされていないかご確認ください（手順 2 の注記を参照）。",
          },
    );
  }

  async function stopHelper() {
    if (!detectedPort) return;
    const portToStop = detectedPort;
    setShuttingDown(true);
    try {
      await shutdownHelper(portToStop);
      // シャットダウン要求後、少し待ってから検出が消えるか確認。
      await new Promise((r) => setTimeout(r, 800));
      // probeOnce の戻り値で停止成否を判定（state は遅延反映のため闭包値は古い）。
      const stillAlive = await probeOnce();
      setMsg({
        type: stillAlive ? "err" : "ok",
        text: stillAlive
          ? "ヘルパーの停止を確認できませんでした。コンソールウィンドウを閉じるか Ctrl+C で終了してください。"
          : "ヘルパーを停止しました。不要になったバイナリはゴミ箱へ移動してください。",
      });
    } finally {
      setShuttingDown(false);
    }
  }

  // OS を手動で切り替えたときの再解決。
  function pickAsset(key: HelperAssetKey) {
    setPreferredKey(key);
    setResolvedAsset(resolveHelperAsset(manifest, key));
  }

  const osLabel: Record<HelperAssetKey, string> = {
    "windows-x64": "Windows (64-bit)",
    "darwin-universal": "macOS (Universal)",
    "darwin-arm64": "macOS (Apple Silicon)",
    "darwin-amd64": "macOS (Intel)",
    "linux-x64": "Linux (64-bit)",
  };

  const manifestAssetKeys = manifest
    ? (Object.keys(manifest.assets) as HelperAssetKey[])
    : [];

  // macOS はブラウザ経由のダウンロードで実行権限（+x）が落ち、隔離属性が付く。
  // そのままダブルクリックするとテキストエディットで開いてしまうため、
  // ターミナルで実行してもらうコマンドを提示する。
  const isMac = preferredKey?.startsWith("darwin") ?? false;
  const macBinaryName =
    resolvedAsset?.url.split("/").pop() || "config-manager-helper";
  const macSetupCommands = [
    "cd ~/Downloads",
    `chmod +x ${macBinaryName}`,
    `xattr -d com.apple.quarantine ${macBinaryName}`,
    `./${macBinaryName}`,
  ].join("\n");

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="mb-2 text-xl font-semibold text-slate-900">
        ローカル取得のセットアップ
      </h1>
      <p className="mb-4 text-sm text-slate-600">
        社内 LAN 上の NW 機器から Telnet でコンフィグを自動取得するには、
        ローカルヘルパーアプリ（ポータブル型）が必要です。ブラウザ単体では
        生 TCP（Telnet/SSH）を開けないため、このヘルパーが 127.0.0.1 で待ち受け、
        SPA からの指示で取得を実行します。
      </p>

      {/* セキュリティ注意（Telnet 平文） */}
      <div className="mb-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
        <span className="font-semibold">【セキュリティ注意】</span>
        Telnet は平文プロトコルです。機器との通信は暗号化されず、LAN 上で
        パスワードが平文で流れます。社内ポリシー上 Telnet が許可されていることを
       確認のうえご利用ください。取得したパスワード類は BFF には送信されず、
        ヘルパー内でのみ使用されます（取得後にメモリから破棄）。
      </div>

      {/* ヘルパー検出状態 */}
      <section className="mb-6 rounded-lg border border-slate-200 bg-white p-4">
        <h2 className="mb-2 text-sm font-semibold uppercase text-slate-500">
          ヘルパーの状態
        </h2>
        {detectedPort ? (
          <div className="flex flex-wrap items-center gap-3">
            <span className="inline-flex items-center gap-2 rounded-md bg-emerald-50 px-3 py-1.5 text-sm text-emerald-800">
              <span className="h-2 w-2 rounded-full bg-emerald-500" />
              稼働中（ポート {detectedPort} ・ v{helperVersion ?? "?"}）
            </span>
            <button
              onClick={retest}
              disabled={probing}
              className="rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50 disabled:opacity-50"
            >
              {probing ? "確認中…" : "再確認"}
            </button>
            <button
              onClick={stopHelper}
              disabled={shuttingDown}
              className="rounded-md border border-red-300 bg-white px-3 py-1.5 text-sm text-red-700 hover:bg-red-50 disabled:opacity-50"
            >
              {shuttingDown ? "停止中…" : "ヘルパーを停止"}
            </button>
            <p className="w-full text-xs text-slate-500">
              ヘルパーが検出されました。機器詳細画面の「Telnet 取得」ボタンが
              使えるようになります。
            </p>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <span className="inline-flex items-center gap-2 rounded-md bg-slate-50 px-3 py-1.5 text-sm text-slate-600">
              <span className="h-2 w-2 rounded-full bg-slate-400" />
              未検出（起動していません）
            </span>
            <button
              onClick={retest}
              disabled={probing}
              className="rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50 disabled:opacity-50"
            >
              {probing ? "検出中…" : "接続テスト"}
            </button>
          </div>
        )}
        {msg && (
          <p
            className={`mt-2 text-sm ${
              msg.type === "ok"
                ? "text-emerald-700"
                : msg.type === "err"
                  ? "text-red-700"
                  : "text-slate-600"
            }`}
          >
            {msg.text}
          </p>
        )}
      </section>

      {/* ステップ 1: ダウンロード */}
      <section className="mb-6 rounded-lg border border-slate-200 bg-white p-4">
        <h2 className="mb-2 text-sm font-semibold uppercase text-slate-500">
          手順 1. ヘルパーをダウンロード
        </h2>
        {resolvedAsset ? (
          <div className="flex flex-col gap-3">
            <a
              href={resolvedAsset.url}
              className="inline-flex w-fit items-center gap-2 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
            >
              {preferredKey ? osLabel[preferredKey] : "バイナリ"} をダウンロード
            </a>
            {resolvedAsset.sha256 && (
              <p className="break-all text-xs text-slate-500">
                SHA-256: <code className="mono">{resolvedAsset.sha256}</code>
              </p>
            )}
            {manifest?.version && (
              <p className="text-xs text-slate-500">
                バージョン: {manifest.version}
                {manifest.releasedAt && ` · 公開日: ${manifest.releasedAt}`}
              </p>
            )}
            {/* 誤判定・別 PC 用に全アセットを併記 */}
            {manifestAssetKeys.length > 0 && (
              <div className="mt-1">
                <p className="mb-1 text-xs text-slate-500">
                  別の OS 用（手動選択）:
                </p>
                <div className="flex flex-wrap gap-2">
                  {manifestAssetKeys.map((k) => {
                    const a = manifest!.assets[k]!;
                    return (
                      <a
                        key={k}
                        href={a.url}
                        className={`rounded border px-2 py-1 text-xs ${
                          preferredKey === k
                            ? "border-blue-300 bg-blue-50 text-blue-700"
                            : "border-slate-300 bg-white text-slate-600 hover:bg-slate-50"
                        }`}
                        onClick={() => pickAsset(k)}
                      >
                        {osLabel[k]}
                      </a>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        ) : (
          <p className="text-sm text-slate-500">
            配布物がまだ配置されていません（latest.json が未配信、または OS を判定できませんでした）。
            管理者に配布状況をご確認ください。
          </p>
        )}
      </section>

      {/* ステップ 2: 起動 */}
      <section className="mb-6 rounded-lg border border-slate-200 bg-white p-4">
        <h2 className="mb-2 text-sm font-semibold uppercase text-slate-500">
          手順 2. ヘルパーを起動
        </h2>
        {isMac ? (
          <>
            <ol className="list-decimal space-y-1 pl-5 text-sm text-slate-700">
              <li>
                ダウンロードしたファイルには実行権限が付いていないため、
                そのままダブルクリックするとテキストエディットで開いてしまいます。
                ターミナル（アプリケーション &gt; ユーティリティ）で下記を実行してください。
              </li>
              <li>
                「待ち受けポート: 53712」と表示されたら準備完了です。
                上記「ヘルパーの状態」が自動的に「稼働中」に切り替わります。
              </li>
            </ol>
            <div className="mt-3">
              <div className="mb-1 flex items-center justify-between">
                <span className="text-xs font-medium text-slate-600">
                  ターミナルに貼り付けて実行:
                </span>
                <button
                  type="button"
                  className="rounded border border-slate-300 bg-white px-2 py-0.5 text-xs text-slate-600 hover:bg-slate-50"
                  onClick={() => {
                    void navigator.clipboard
                      .writeText(macSetupCommands)
                      .then(() =>
                        setMsg({ type: "ok", text: "コマンドをコピーしました。" }),
                      );
                  }}
                >
                  コピー
                </button>
              </div>
              <pre className="overflow-x-auto rounded-md bg-slate-800 px-3 py-2 text-xs leading-relaxed text-slate-100">
                {macSetupCommands}
              </pre>
              <ul className="mt-2 list-disc space-y-0.5 pl-5 text-xs text-slate-600">
                <li>
                  <code className="rounded bg-slate-100 px-1">chmod +x</code> は実行権限の付与です。
                </li>
                <li>
                  <code className="rounded bg-slate-100 px-1">xattr -d</code> は
                  ダウンロード時に付く隔離属性の解除です（未署名バイナリのため
                  Gatekeeper にブロックされます）。
                </li>
                <li>
                  2 回目以降は
                  <code className="rounded bg-slate-100 px-1">
                    ~/Downloads/config-manager-helper
                  </code>
                  を実行するだけで起動できます。
                </li>
              </ul>
            </div>
          </>
        ) : (
          <ol className="list-decimal space-y-1 pl-5 text-sm text-slate-700">
            <li>ダウンロードしたバイナリをダブルクリックして起動してください。</li>
            <li>
              コンソールウィンドウが開き「待ち受けポート: 53712」と表示されたら
              準備完了です。上記「ヘルパーの状態」が自動的に「稼働中」に切り替わります。
            </li>
          </ol>
        )}
        <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          <p className="font-semibold">未署名バイナリの警告が出る場合:</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5">
            <li>
              <span className="font-medium">Windows:</span> SmartScreen の
              「Windows によって PC が保護されました」が出たら「詳細情報」→
              「実行」を選んでください。
            </li>
            <li>
              <span className="font-medium">macOS:</span> 上記の
              <code className="rounded bg-amber-100 px-1">xattr -d</code>
              を実行せずに開いた場合は Gatekeeper にブロックされます。
              その場合は Finder でバイナリを右クリック →「開く」を選んでください。
            </li>
          </ul>
        </div>
        <div className="mt-3 rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-800">
          <p className="font-semibold">
            「ローカルネットワークへのアクセス」の確認が出た場合:
          </p>
          <p className="mt-1">
            ヘルパーは PC 内（127.0.0.1）で待ち受けるため、Chrome 138 以降では
            本サイトからの接続にユーザーの許可が必要です。確認ダイアログが出たら
            「許可」を選んでください。誤って「ブロック」した場合は、アドレスバー左の
            アイコン → サイトの設定から「ローカルネットワークへのアクセス」を
            「許可」に変更してください。
          </p>
        </div>
      </section>

      {/* ステップ 3: 利用・停止・撤去 */}
      <section className="mb-6 rounded-lg border border-slate-200 bg-white p-4">
        <h2 className="mb-2 text-sm font-semibold uppercase text-slate-500">
          手順 3. 利用・停止・撤去
        </h2>
        <ol className="list-decimal space-y-1 pl-5 text-sm text-slate-700">
          <li>
            機器一覧から対象機器を開き、「Telnet 取得」ボタンでコンフィグを
            取得します（接続情報は都度入力します）。
          </li>
          <li>
            取得が終わったら、この画面の「ヘルパーを停止」ボタン、または
            コンソールウィンドウを閉じる / Ctrl+C で終了してください。
          </li>
          <li>
            <span className="font-medium">削除は「停止してから」</span>行ってください。
            Windows では実行中の exe は削除できません。停止後にバイナリを
            ゴミ箱へ移動してください（ポータブル型のため、レジストリ・設定ファイル等の残骸は一切ありません）。
          </li>
        </ol>
      </section>
    </div>
  );
}
