/**
 * Centralized, validated access to environment variables.
 * Throws on missing required values so the process fails fast on boot.
 */

import type { AppRole } from "@config-manager/shared";

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
    sessionSecret: entraRequired
      ? required("SESSION_SECRET")
      : optional("SESSION_SECRET", "insecure-local-dev-secret-do-not-use-in-prod"),
    kintone: {
      domain,
      configAppId: required("KINTONE_CONFIG_APP_ID"),
      configAppToken: required("KINTONE_CONFIG_APP_TOKEN"),
      auditAppId: required("KINTONE_AUDIT_APP_ID"),
      auditAppToken: required("KINTONE_AUDIT_APP_TOKEN"),
      // Meraki 接続情報アプリは任意。未設定時は Meraki クレデンシャル機能が無効。
      merakiAppId: optional("KINTONE_MERAKI_APP_ID", ""),
      merakiAppToken: optional("KINTONE_MERAKI_APP_TOKEN", ""),
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
