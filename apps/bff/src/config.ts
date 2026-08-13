/**
 * Centralized, validated access to environment variables.
 * Throws on missing required values so the process fails fast on boot.
 */

import type { AppRole } from "@config-manager/shared";
import { parseEncryptionKey } from "./secretCrypto.js";

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (!value || value.length === 0) {
    throw new Error(
      `Missing required environment variable: ${name}. Copy .env.example to .env and fill it in.`,
    );
  }
  return value;
}

function optional(name: string, fallback = ""): string {
  return process.env[name] ?? fallback;
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`Environment variable ${name} must be an integer.`);
  }
  return parsed;
}

export type AuthMode = "oidc" | "disabled";

export interface AppConfig {
  port: number;
  nodeEnv: string;
  publicBaseUrl: string;
  /** "oidc" uses Entra ID (production). "disabled" skips auth and injects a
   *  fixed local user — for local validation only. */
  authMode: AuthMode;
  /** Local (dummy) user injected when authMode === "disabled". */
  localDevUser: { name: string; email: string };
  entra: {
    tenantId: string;
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    /** Admission gate: any of these group IDs is enough to log in. */
    requiredGroupIds: string[];
    /** RBAC mapping (highest match wins). Empty = every user is admin. */
    adminGroupIds: string[];
    operatorGroupIds: string[];
    viewerGroupIds: string[];
  };
  /** App role injected for AUTH_MODE=disabled local user. */
  localDevRole: AppRole;
  sessionSecret: string;
  /**
   * AES-256 key for encrypting Meraki API keys at rest in Kintone.
   * null = pass-through (local dev without the secret). Production with the
   * Meraki credentials app enabled should always set CREDENTIALS_ENCRYPTION_KEY.
   */
  credentialsEncryptionKey: Buffer | null;
  kintone: {
    domain: string;
    configAppId: string;
    configAppToken: string;
    auditAppId: string;
    auditAppToken: string;
    username: string;
    password: string;
    baseUrl: string;
    /** Meraki 接続情報アプリ（任意）。未設定時は Meraki クレデンシャル機能
     *  は無効化され、Meraki 取得画面では都度入力のみとなる。 */
    merakiAppId: string;
    merakiAppToken: string;
    /** 顧客情報（ノード管理）アプリ（任意・読み取り専用）。機器のアカウント名 /
     *  パスワードの正本で、ローカル取得ヘルパーのログインに適用する（Issue #53）。
     *  未設定時は候補提示が無効化され、取得ダイアログは都度入力のみとなる。
     *  トークンは**閲覧のみ**の権限で発行すること（本機能は書き込みを一切行わない）。 */
    customerInfoAppId: string;
    customerInfoAppToken: string;
  };
  commentPrefixes: string[];
  /** Meraki Dashboard API 関連のオプション設定。API キーは環境変数
   *  (MERAKI_API_KEY) で予め指定することも、インポート要求本体で都度
   *  受け取ることもできる。本番運用ではfly secrets経由で設定することを
   *  想定しているが、顧客/組織每にキーが分かれる場合は都度入力を優先する。 */
  meraki: {
    apiKey: string;
    /** Meraki API のベース URL。中国リージョン等では上書きが必要。 */
    apiBase: string;
    /** Meraki API 呼び出し每のタイムアウト (ms)。 */
    timeoutMs: number;
    /** 429 受信時の最大リトライ回数。 */
    maxRetries: number;
    /** セクション取得の最大並列数。レート制限 (429) 抑制のため既定 5。 */
    sectionConcurrency: number;
  };
}

let cached: AppConfig | null = null;

export function loadConfig(): AppConfig {
  if (cached) return cached;
  const publicBaseUrl = optional("PUBLIC_BASE_URL", "http://localhost:3000");
  const domain = required("KINTONE_DOMAIN");
  const nodeEnv = optional("NODE_ENV", "development");
  const authMode: AuthMode =
    optional("AUTH_MODE", "oidc") === "disabled" ? "disabled" : "oidc";
  // AUTH_MODE=disabled bypasses Entra ID entirely. That is convenient for local
  // validation but catastrophic if it ever reaches production, so refuse to
  // boot when NODE_ENV=production.
  if (authMode === "disabled" && nodeEnv === "production") {
    throw new Error(
      "AUTH_MODE=disabled is not allowed when NODE_ENV=production. " +
        "Set AUTH_MODE=oidc (and configure ENTRA_* / SESSION_SECRET) for production.",
    );
  }
  // Entra ID + session secret are only required for the OIDC flow.
  const entraRequired = authMode !== "disabled";
  const cfg: AppConfig = {
    port: int("PORT", 3000),
    nodeEnv,
    publicBaseUrl,
    authMode,
    localDevUser: {
      name: optional("LOCAL_DEV_USER_NAME", "Local Developer"),
      email: optional("LOCAL_DEV_USER_EMAIL", "local-dev@example.com"),
    },
    entra: {
      tenantId: entraRequired
        ? required("ENTRA_TENANT_ID")
        : optional("ENTRA_TENANT_ID", "disabled"),
      clientId: entraRequired
        ? required("ENTRA_CLIENT_ID")
        : optional("ENTRA_CLIENT_ID", "disabled"),
      clientSecret: entraRequired
        ? required("ENTRA_CLIENT_SECRET")
        : optional("ENTRA_CLIENT_SECRET", "disabled"),
      redirectUri: optional("ENTRA_REDIRECT_URI", `${publicBaseUrl}/auth/callback`),
      requiredGroupIds: optional("ENTRA_REQUIRED_GROUP_IDS")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      adminGroupIds: optional("ENTRA_GROUP_ADMIN_IDS")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      operatorGroupIds: optional("ENTRA_GROUP_OPERATOR_IDS")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      viewerGroupIds: optional("ENTRA_GROUP_VIEWER_IDS")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    },
    localDevRole: parseAppRole(optional("LOCAL_DEV_USER_ROLE", "admin")),
    sessionSecret: loadSessionSecret(entraRequired, nodeEnv),
    credentialsEncryptionKey: parseEncryptionKey(
      optional("CREDENTIALS_ENCRYPTION_KEY", ""),
    ),
    kintone: {
      domain,
      configAppId: required("KINTONE_CONFIG_APP_ID"),
      configAppToken: required("KINTONE_CONFIG_APP_TOKEN"),
      auditAppId: required("KINTONE_AUDIT_APP_ID"),
      auditAppToken: required("KINTONE_AUDIT_APP_TOKEN"),
      // Meraki 接続情報アプリは任意。未設定時は Meraki クレデンシャル機能が無効。
      merakiAppId: optional("KINTONE_MERAKI_APP_ID", ""),
      merakiAppToken: optional("KINTONE_MERAKI_APP_TOKEN", ""),
      // 顧客情報アプリも任意。未設定時は機器認証情報の候補提示が無効。
      customerInfoAppId: optional("KINTONE_CUSTOMER_INFO_APP_ID", ""),
      customerInfoAppToken: optional("KINTONE_CUSTOMER_INFO_APP_TOKEN", ""),
      username: optional("KINTONE_USERNAME"),
      password: optional("KINTONE_PASSWORD"),
      baseUrl: `https://${domain}`,
    },
    commentPrefixes: optional("CONFIG_COMMENT_PREFIXES", "!")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    meraki: {
      // MERAKI_API_KEY は必須ではない（都度入力でもよい）。空文字列を許容。
      apiKey: optional("MERAKI_API_KEY", ""),
      apiBase: optional("MERAKI_API_BASE", "https://api.meraki.com/api/v1"),
      timeoutMs: int("MERAKI_TIMEOUT_MS", 30_000),
      maxRetries: int("MERAKI_MAX_RETRIES", 3),
      sectionConcurrency: int("MERAKI_SECTION_CONCURRENCY", 5),
    },
  };
  cached = cfg;
  return cfg;
}

function parseAppRole(raw: string): AppRole {
  if (raw === "viewer" || raw === "operator" || raw === "admin") return raw;
  throw new Error(
    `LOCAL_DEV_USER_ROLE must be one of viewer|operator|admin (got "${raw}")`,
  );
}

/**
 * SESSION_SECRET must be long enough for iron-session (min 32 chars).
 * Production / OIDC refuses short or placeholder values so weak seals never ship.
 */
function loadSessionSecret(entraRequired: boolean, nodeEnv: string): string {
  const MIN_LEN = 32;
  const PLACEHOLDERS = new Set([
    "change-me-to-a-long-random-string",
    "insecure-local-dev-secret-do-not-use-in-prod",
  ]);
  if (!entraRequired) {
    return optional(
      "SESSION_SECRET",
      "insecure-local-dev-secret-do-not-use-in-prod",
    );
  }
  const secret = required("SESSION_SECRET");
  if (secret.length < MIN_LEN || PLACEHOLDERS.has(secret)) {
    throw new Error(
      `SESSION_SECRET must be a high-entropy secret of at least ${MIN_LEN} characters ` +
        `(got length=${secret.length}). Generate with: openssl rand -base64 32`,
    );
  }
  // Extra hard fail in production even if someone forces AUTH_MODE=disabled path off.
  if (nodeEnv === "production" && secret.length < MIN_LEN) {
    throw new Error("SESSION_SECRET is too short for production");
  }
  return secret;
}
