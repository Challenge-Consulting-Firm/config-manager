/**
 * ローカル取得ヘルパー（Go 製ポータブルアプリ）と SPA 間で共有される型。
 *
 * 設計の経緯は Issue #43 を参照。Chrome 拡張機能 + Native Messaging 方式は
 * 廃止され、最終的に「拡張機能なしの単体ローカルアプリ（127.0.0.1 に HTTP
 * サーバを開き、SPA が直接呼ぶ）」方式に確定した。
 *
 * 重要: コンフィグ本文は「ヘルパー → SPA → BFF（既存 /api/upload）」の順に
 * 流れる。ヘルパーは BFF に直接 POST しないため、拡張トークンや CSRF バイパス
 * は一切不要で、BFF 側の変更は配布物（latest.json）の配信のみに縮小される。
 */

/**
 * 機器への接続プロトコル。
 *
 * `telnet` は平文で認証情報が流れるため、機器が SSH に対応している場合は
 * `ssh` を選ぶこと。SSH ではホスト鍵を初回接続時にヘルパーの known_hosts へ
 * 記録し、以降は一致を検証する（不一致時は `host_key_mismatch`）。
 */
export type HelperProtocol = "telnet" | "ssh";

/**
 * 接続先の機種を大まかに指定するヒント値。
 * ヘルパーはこの値に基づきページング抑制コマンドとコンフィグ取得コマンドを
 * 選ぶ（`commandOverride` があればそちらが優先）。
 *
 * IOS-XE は IOS とコマンド体系が同じため `cisco-ios` に含める。`generic` は
 * 取得コマンドをユーザーが `commandOverride` で指定する前提。
 *
 * YAMAHA は 2 系統ある点に注意。ルーター（RTX 等）は独自 CLI の `show config`
 * だが、スイッチ（SWX2100/2200/2300/3100/3200 等）は Cisco 風 CLI で
 * `show running-config` を使う。`yamaha-rt` を SWX に対して使うと機器が
 * `% Invalid input detected at '^' marker.` を返すため、別値に分けている。
 */
export type HelperOsHint =
  | "cisco-ios"
  | "yamaha-rt"
  | "yamaha-swx"
  | "generic";

/**
 * 取得処理の段階別タイムアウト（ミリ秒）。全項目省略可能で、省略時は
 * ヘルパーの既定値が使われる。単一の全体タイムアウトにすると大容量
 * running-config の取得が途中で切れるため、段階的に設定する。
 */
export interface HelperFetchTimeouts {
  /** TCP 接続の確立まで。推奨 5,000〜10,000。 */
  connectMs?: number;
  /** ログイン完了（プロンプト検出）まで。推奨 15,000。 */
  loginMs?: number;
  /** コンフィグ取得コマンド 1 本の完了まで。推奨 60,000〜120,000。 */
  commandMs?: number;
  /** ジョブ全体の上限。推奨 180,000。 */
  totalMs?: number;
}

/** SPA → ヘルパー `POST /api/fetch` の要求本体。 */
export interface HelperFetchRequest {
  /** 接続先ホスト（IP またはホスト名）。 */
  host: string;
  /** 接続ポート。省略時はプロトコル既定値（{@link HELPER_DEFAULT_PORTS}）。 */
  port?: number;
  /** プロトコル（`"telnet"` または `"ssh"`）。 */
  protocol: HelperProtocol;
  /**
   * ログインユーザー名。`credentialToken` を使う場合は省略できる
   * （redeem で得た値が優先される）。
   */
  username?: string;
  /**
   * ログインパスワード。`credentialToken` を使う場合は省略する。
   * どちらも無い場合はヘルパーが 400 を返す。
   */
  password?: string;
  /** Cisco 機器の特権モード（enable）パスワード（任意）。 */
  enablePassword?: string;
  /**
   * 認証情報トークン（Issue #53）。指定するとヘルパーは、要求元の検証済み
   * Origin に対して `POST /helper/credentials/redeem` を行い、ユーザー名と
   * パスワードを受け取ってから機器へログインする。
   *
   * これにより平文パスワードがブラウザの JS ヒープ・DevTools・拡張機能に
   * 一切載らない。トークンは一回限り・短命で、redeem 先は要求元 Origin に
   * 固定される（SPA が任意の URL を指定することはできない）。
   */
  credentialToken?: string;
  /** 認証情報トークンを利用する正規ヘルパーの永続 ID。 */
  helperId?: string;
  /** 発行時に指定した対象ホスト。ヘルパー側で接続先と照合する。 */
  credentialTargetHost?: string;
  /** helper private key による token + targetHost の Ed25519 署名。 */
  credentialSignature?: string;
  /** 機種ヒント。コマンド選択に使う。 */
  osHint: HelperOsHint;
  /**
   * コンフィグ取得コマンドの上書き（任意）。指定時は osHint 由来の
   * 既定コマンドより優先される。ページング抑制コマンドは osHint に基づき
   * 引き続き送信される。
   */
  commandOverride?: string | null;
  /** 段階別タイムアウト（任意）。 */
  timeouts?: HelperFetchTimeouts;
}

/** ヘルパーからの応答に付与される取得メタ情報。 */
export interface HelperFetchMeta {
  /** 取得にかかった時間（ミリ秒）。 */
  elapsedMs: number;
  /** 学習したプロンプト文字列（デバッグ用）。 */
  prompt: string;
  /** 実行したコンフィグ取得コマンド。 */
  command: string;
  /** 入力の文字コード。UTF-8 変換前のエンコーディング（例: "shift_jis"）。 */
  sourceEncoding: string;
}

/**
 * `POST /api/fetch` の成功時レスポンス。失敗時は {@link HelperFetchErrorResponse}。
 * `ok` の真偽で成功・失敗を分岐する（Discriminated Union）。
 */
export interface HelperFetchOkResponse {
  ok: true;
  /** 取得したコンフィグ本文（UTF-8）。 */
  body: string;
  meta: HelperFetchMeta;
}

/**
 * 失敗時のエラーコード。UI で原因を区別して表示するために使う。
 * レビュー指摘 5 を反映し、現場で頻発する失敗モードを明示的に区別する。
 *
 * `handshake_failed` / `host_key_mismatch` は SSH 固有。
 */
export type HelperFetchErrorCode =
  | "connect_failed"
  | "auth_failed"
  | "prompt_not_found"
  | "timeout"
  | "pager_detected"
  | "empty_body"
  /** 機器が取得コマンドを拒否した（コマンド体系の不一致・権限不足など）。 */
  | "command_rejected"
  /**
   * 送信前の検証でヘルパーが取得コマンドを拒否した（制御文字の混入など）。
   * 機器へは接続・送信していない（Issue #76）。
   */
  | "command_invalid"
  | "handshake_failed"
  | "host_key_mismatch"
  /** 認証情報トークンの引き換えに失敗した（期限切れ・使用済み・BFF 到達不可）。 */
  | "credential_redeem_failed";

/** `POST /api/fetch` の失敗時レスポンス。 */
export interface HelperFetchErrorResponse {
  ok: false;
  /** 機械可読なエラーコード。 */
  code: HelperFetchErrorCode;
  /** ユーザー向けメッセージ。 */
  message: string;
}

/** `POST /api/fetch` のレスポンス。 */
export type HelperFetchResponse =
  | HelperFetchOkResponse
  | HelperFetchErrorResponse;

/** `GET /api/status` のレスポンス。SPA の「接続テスト」と取得ボタン活性化に使う。 */
export interface HelperStatusResponse {
  ok: true;
  /** ヘルパーのバージョン（Semantic Versioning）。 */
  version: string;
  /** ヘルパー 1 インストールを表す公開鍵由来の永続 ID。 */
  helperId: string;
  /** Ed25519 公開鍵（DER/SPKI の Base64URL）。 */
  publicKey: string;
  /** pairing nonce に対する HMAC proof。nonce 未指定の status では省略。 */
  pairingProof?: string;
}

/** `POST /api/shutdown` のレスポンス。200 を返してからプロセスを終了する。 */
export interface HelperShutdownResponse {
  ok: true;
}

/**
 * ヘルパーの待ち受けポートを順に探すための候補リスト。
 * 既定ポート 53712 が使用中の場合は 53713〜53716 を順に試行し、最初に開いた
 * ヘルパーを SPA 側で採用する。
 */
export const HELPER_PORT_CANDIDATES = [
  53712, 53713, 53714, 53715, 53716,
] as const;

/** プロトコル別の既定ポート。`port` 未指定時にヘルパーが適用する値。 */
export const HELPER_DEFAULT_PORTS: Record<HelperProtocol, number> = {
  telnet: 23,
  ssh: 22,
};

/** ヘルパーの既定タイムアウト（ミリ秒）。レビュー指摘の推奨値。 */
export const HELPER_DEFAULT_TIMEOUTS: Required<HelperFetchTimeouts> = {
  connectMs: 10_000,
  loginMs: 15_000,
  commandMs: 120_000,
  totalMs: 180_000,
};

/**
 * エラーコード → 日本語メッセージの対応。SPA 側で表示する際の既定値。
 * `message` フィールドがあればそちらを優先するが、フォールバック表示用。
 */
export const HELPER_ERROR_LABELS: Record<HelperFetchErrorCode, string> = {
  connect_failed: "接続に失敗しました（ホスト・ポート・ファイアウォールを確認してください）",
  auth_failed: "認証に失敗しました（ユーザー名・パスワード・enable パスワードを確認してください）",
  prompt_not_found: "プロンプトを検出できませんでした（機種設定や banner の影響の可能性があります）",
  timeout: "タイムアウトしました（機器の応答が遅いか、コマンドが長時間かかる可能性があります）",
  pager_detected: "ページャ（--More--）が残留しています（ページング抑制が効いていない可能性があります）",
  empty_body: "コンフィグ本文を取得できませんでした（空または極端に短い応答です）",
  command_rejected:
    "機器が取得コマンドを受け付けませんでした（機種の選択、または特権モードへの昇格を確認してください）",
  command_invalid:
    "取得コマンドが安全でないため送信しませんでした（改行や記号を含まない、単一の読み取りコマンドを指定してください）",
  handshake_failed:
    "SSH の暗号方式が一致しませんでした（機器が対応する鍵交換方式・暗号を確認してください）",
  host_key_mismatch:
    "SSH のホスト鍵が記録済みの鍵と一致しません（中間者攻撃の可能性、または機器の交換・初期化が原因です）",
  credential_redeem_failed:
    "認証情報の取得に失敗しました（トークンの期限切れ・使用済み、またはサーバへ到達できません）。候補を選び直してください",
};

/**
 * ヘルパーが認証情報トークンを引き換える BFF 側のパス。
 * ヘルパーは要求元の検証済み Origin にこのパスを連結して POST する。
 */
export const HELPER_CREDENTIAL_REDEEM_PATH = "/helper/credentials/redeem";

/** 認証情報トークンの有効期限（ミリ秒）。発行から redeem までの猶予。 */
export const NODE_CREDENTIAL_TOKEN_TTL_MS = 60_000;

/**
 * `commandOverride` の最大長（前後空白除去・連続空白畳み込み後）。
 * ヘルパー側 `apps/helper/internal/commands/override.go` の MaxOverrideLen と一致させる。
 */
export const HELPER_MAX_COMMAND_OVERRIDE_LEN = 100;

/**
 * 自由入力を許可する取得コマンドの先頭語。いずれも表示系で機器の設定を変更しない。
 * ヘルパー側 readOnlyVerbs と一致させる。
 */
export const HELPER_READONLY_COMMAND_VERBS = [
  "show",
  "display",
  "get",
  "dir",
  "more",
] as const;

/**
 * osHint ごとの定義済み読み取り専用コマンド。保存済み認証情報を使う場合は、
 * この一覧に一致するコマンドしかヘルパーが受け付けない（Issue #76）。
 * ヘルパー側 allowedOverrides と一致させる。
 */
export const HELPER_ALLOWED_COMMAND_OVERRIDES: Record<
  HelperOsHint,
  readonly string[]
> = {
  "cisco-ios": ["show running-config", "show startup-config", "show version"],
  "yamaha-rt": ["show config", "show config list", "show environment"],
  "yamaha-swx": ["show running-config", "show startup-config", "show version"],
  generic: [
    "show config",
    "show config list",
    "show environment",
    "show running-config",
    "show startup-config",
    "show version",
  ],
};

/** {@link validateHelperCommandOverride} の結果。 */
export type HelperCommandOverrideValidation =
  | { ok: true; command: string }
  | { ok: false; message: string };

/**
 * `commandOverride` を SPA 側で検証する。
 *
 * 【重要】これは入力ミスを早く知らせるための UX 補助であり、セキュリティ境界は
 * ヘルパー側の検証（`apps/helper/internal/commands/override.go`）にある。SPA を
 * 経由しない要求でも同じ規則が適用される。
 *
 * @param osHint 機種ヒント
 * @param raw 入力値
 * @param usingStoredCredential 保存済み認証情報（一回限りトークン）を使うか。
 *   true の場合は定義済み読み取り専用コマンドのみ許可する。
 */
export function validateHelperCommandOverride(
  osHint: HelperOsHint,
  raw: string,
  usingStoredCredential: boolean,
): HelperCommandOverrideValidation {
  // 制御文字は対話シェルのコマンド境界を破るため、正規化より先に弾く。
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(raw)) {
    return {
      ok: false,
      message:
        "取得コマンドに改行・タブ・制御文字は使えません（コマンドは 1 行で指定してください）",
    };
  }
  const command = raw.trim().replace(/\s+/g, " ");
  if (command === "") {
    return { ok: false, message: "取得コマンドを入力してください" };
  }
  if (command.length > HELPER_MAX_COMMAND_OVERRIDE_LEN) {
    return {
      ok: false,
      message: `取得コマンドが長すぎます（${HELPER_MAX_COMMAND_OVERRIDE_LEN} 文字以内）`,
    };
  }
  const allowed = HELPER_ALLOWED_COMMAND_OVERRIDES[osHint];
  if (allowed.includes(command.toLowerCase())) {
    return { ok: true, command };
  }
  if (usingStoredCredential) {
    return {
      ok: false,
      message: `保存済みの認証情報を使う場合、取得コマンドは次のいずれかだけを指定できます: ${allowed.join(" / ")}`,
    };
  }
  if (!/^[A-Za-z0-9 \-_./:]+$/.test(command)) {
    return {
      ok: false,
      message:
        "取得コマンドに使える文字は英数字と - _ . / : のみです（; | & $ などは使えません）",
    };
  }
  const verb = command.split(" ")[0]?.toLowerCase() ?? "";
  if (!HELPER_READONLY_COMMAND_VERBS.some((v) => v === verb)) {
    return {
      ok: false,
      message: `取得コマンドは読み取り専用（${HELPER_READONLY_COMMAND_VERBS.join(" / ")} で始まるもの）だけを指定できます`,
    };
  }
  return { ok: true, command };
}
