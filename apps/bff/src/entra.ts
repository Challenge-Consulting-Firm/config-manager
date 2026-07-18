/**
 * Entra ID (Azure AD) OpenID Connect helpers.
 *
 * We implement the Authorization Code flow with PKCE manually rather than
 * pulling in MSAL Node, to keep the dependency surface small. The BFF is a
 * confidential client: it can hold a client secret and exchange the auth code
 * for tokens server-side.
 *
 * Endpoints used (OIDC discovery):
 *   GET  https://login.microsoftonline.com/{tenant}/v2.0/.well-known/openid-configuration
 *   POST https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token
 */

import { createHash, randomBytes } from "node:crypto";
import type { AppConfig } from "./config.js";
import type { AuthUser } from "@config-manager/shared";

interface OidcDiscovery {
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint?: string;
  jwks_uri: string;
  issuer: string;
}

const discoveryCache = new Map<string, OidcDiscovery>();

function base64UrlToBuffer(input: string): Buffer {
  const pad = 4 - (input.length % 4);
  const padded = pad === 4 ? input : input + "=".repeat(pad);
  return Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function toBase64Url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function randomString(bytes = 32): string {
  return toBase64Url(randomBytes(bytes));
}

/** Build the PKCE verifier/challenge pair (sync, node:crypto). */
export function createPkce(): { verifier: string; challenge: string } {
  const verifier = randomString(32);
  const digest = createHash("sha256").update(verifier).digest();
  const challenge = toBase64Url(digest);
  return { verifier, challenge };
}

/** OIDC discovery, cached per tenant. */
export async function discover(tenantId: string): Promise<OidcDiscovery> {
  if (discoveryCache.has(tenantId)) {
    return discoveryCache.get(tenantId)!;
  }
  const url = `https://login.microsoftonline.com/${tenantId}/v2.0/.well-known/openid-configuration`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`OIDC discovery failed: ${res.status} ${await res.text()}`);
  }
  const doc = (await res.json()) as OidcDiscovery;
  discoveryCache.set(tenantId, doc);
  return doc;
}

/** Build the authorization URL the browser is redirected to. */
export async function buildAuthUrl(
  cfg: AppConfig,
  pkce: { verifier: string; challenge: string },
  state: string,
): Promise<string> {
  const doc = await discover(cfg.entra.tenantId);
  const params = new URLSearchParams({
    client_id: cfg.entra.clientId,
    response_type: "code",
    redirect_uri: cfg.entra.redirectUri,
    response_mode: "query",
    scope: "openid profile email offline_access",
    state,
    code_challenge: pkce.challenge,
    code_challenge_method: "S256",
  });
  return `${doc.authorization_endpoint}?${params.toString()}`;
}

export interface TokenResponse {
  access_token: string;
  id_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
  scope: string;
}

/** Exchange an authorization code for tokens. */
export async function exchangeCode(
  cfg: AppConfig,
  code: string,
  pkceVerifier: string,
): Promise<TokenResponse> {
  const doc = await discover(cfg.entra.tenantId);
  const body = new URLSearchParams({
    client_id: cfg.entra.clientId,
    client_secret: cfg.entra.clientSecret,
    grant_type: "authorization_code",
    code,
    redirect_uri: cfg.entra.redirectUri,
    code_verifier: pkceVerifier,
    scope: "openid profile email offline_access",
  });
  const res = await fetch(doc.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Token exchange failed: ${res.status} ${text}`);
  }
  return JSON.parse(text) as TokenResponse;
}

interface IdTokenPayload {
  aud: string;
  iss: string;
  sub: string;
  email?: string;
  preferred_username?: string;
  name?: string;
  tid: string;
  oid: string;
  exp: number;
}

/** Decode (but not signature-verify) an id_token. Signature verification is
 * performed by Entra ID's own token endpoint; for the BFF's session we trust
 * the HTTPS response from the token endpoint. */
export function decodeIdToken(idToken: string): IdTokenPayload {
  const [, payload] = idToken.split(".");
  if (!payload) throw new Error("Malformed id_token");
  return JSON.parse(base64UrlToBuffer(payload).toString("utf8")) as IdTokenPayload;
}

/** Map an id_token to the AuthUser shape consumed by the frontend. */
export function toAuthUser(token: IdTokenPayload, displayNameFallback: string): AuthUser {
  return {
    displayName: token.name ?? token.preferred_username ?? displayNameFallback,
    email: token.email ?? token.preferred_username ?? "",
    tenantId: token.tid,
    objectId: token.oid,
  };
}

/** Look up which group object IDs the user is a member of (transitively).
 *  Used when ENTRA_REQUIRED_GROUP_IDS is configured. */
export async function getUserGroups(accessToken: string): Promise<string[]> {
  // Use the Microsoft Graph /me/transitiveMemberOf endpoint.
  const res = await fetch(
    "https://graph.microsoft.com/v1.0/me/transitiveMemberOf?$select=id",
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!res.ok) {
    throw new Error(`Graph /me/transitiveMemberOf failed: ${res.status}`);
  }
  const doc = (await res.json()) as { value: Array<{ id: string }> };
  return doc.value.map((v) => v.id);
}
