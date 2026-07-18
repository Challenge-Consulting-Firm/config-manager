/**
 * Centralized, validated access to environment variables.
 * Throws on missing required values so the process fails fast on boot.
 */

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
    requiredGroupIds: string[];
  };
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
  };
  commentPrefixes: string[];
}

let cached: AppConfig | null = null;

export function loadConfig(): AppConfig {
  if (cached) return cached;
  const publicBaseUrl = optional("PUBLIC_BASE_URL", "http://localhost:3000");
  const domain = required("KINTONE_DOMAIN");
  const authMode: AuthMode =
    optional("AUTH_MODE", "oidc") === "disabled" ? "disabled" : "oidc";
  // Entra ID + session secret are only required for the OIDC flow.
  const entraRequired = authMode !== "disabled";
  const cfg: AppConfig = {
    port: int("PORT", 3000),
    nodeEnv: optional("NODE_ENV", "development"),
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
    },
    sessionSecret: entraRequired
      ? required("SESSION_SECRET")
      : optional("SESSION_SECRET", "insecure-local-dev-secret-do-not-use-in-prod"),
    kintone: {
      domain,
      configAppId: required("KINTONE_CONFIG_APP_ID"),
      configAppToken: required("KINTONE_CONFIG_APP_TOKEN"),
      auditAppId: required("KINTONE_AUDIT_APP_ID"),
      auditAppToken: required("KINTONE_AUDIT_APP_TOKEN"),
      username: optional("KINTONE_USERNAME"),
      password: optional("KINTONE_PASSWORD"),
      baseUrl: `https://${domain}`,
    },
    commentPrefixes: optional("CONFIG_COMMENT_PREFIXES", "!")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  };
  cached = cfg;
  return cfg;
}
