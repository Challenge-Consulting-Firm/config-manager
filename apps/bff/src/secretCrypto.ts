/**
 * AES-256-GCM helpers for encrypting secrets at rest (e.g. Meraki API keys
 * stored in Kintone). Ciphertext is self-describing so plaintext leftovers can
 * be detected and lazily re-encrypted.
 *
 * Wire format:
 *   enc:v1:<iv_b64url>:<tag_b64url>:<ct_b64url>
 *
 * Key material comes from CREDENTIALS_ENCRYPTION_KEY (32 raw bytes, base64 or
 * 64-char hex). When the key is empty, encrypt/decrypt become pass-through so
 * local dev without the secret still works — production must set the key.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const PREFIX = "enc:v1:";
const ALGO = "aes-256-gcm";
const IV_LEN = 12; // NIST recommended for GCM
const KEY_LEN = 32;

export class SecretCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretCryptoError";
  }
}

/** True when the value is already in the encrypted wire format. */
export function isEncryptedSecret(value: string): boolean {
  return value.startsWith(PREFIX);
}

/**
 * Parse a CREDENTIALS_ENCRYPTION_KEY env value into a 32-byte key.
 * Accepts base64 (standard or url-safe) or 64-char hex. Returns null when empty.
 */
export function parseEncryptionKey(raw: string): Buffer | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return Buffer.from(trimmed, "hex");
  }

  // Try standard base64, then base64url.
  for (const encoding of ["base64", "base64url"] as const) {
    try {
      const buf = Buffer.from(trimmed, encoding);
      if (buf.length === KEY_LEN) return buf;
    } catch {
      // try next encoding
    }
  }

  throw new SecretCryptoError(
    `CREDENTIALS_ENCRYPTION_KEY must be 32 bytes (base64 or 64-char hex). ` +
      `Generate with: openssl rand -base64 32`,
  );
}

/** Encrypt plaintext. When `key` is null the value is returned unchanged. */
export function encryptSecret(plaintext: string, key: Buffer | null): string {
  if (!key) return plaintext;
  if (!plaintext) return plaintext;
  // Avoid double-encrypting a value that already carries the prefix.
  if (isEncryptedSecret(plaintext)) return plaintext;

  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return (
    PREFIX +
    `${b64url(iv)}:${b64url(tag)}:${b64url(ct)}`
  );
}

/**
 * Decrypt a wire-format value. Plaintext leftovers (no prefix) are returned as-is
 * so legacy Kintone rows keep working until they are re-saved.
 */
export function decryptSecret(stored: string, key: Buffer | null): string {
  if (!stored) return stored;
  if (!isEncryptedSecret(stored)) {
    // Legacy plaintext row — usable, but should be re-encrypted on next write.
    return stored;
  }
  if (!key) {
    throw new SecretCryptoError(
      "Encrypted credential encountered but CREDENTIALS_ENCRYPTION_KEY is not set",
    );
  }

  const body = stored.slice(PREFIX.length);
  const parts = body.split(":");
  if (parts.length !== 3) {
    throw new SecretCryptoError("Malformed encrypted secret (expected 3 parts)");
  }
  const [ivB64, tagB64, ctB64] = parts;
  const iv = Buffer.from(ivB64, "base64url");
  const tag = Buffer.from(tagB64, "base64url");
  const ct = Buffer.from(ctB64, "base64url");
  if (iv.length !== IV_LEN) {
    throw new SecretCryptoError(`Unexpected IV length: ${iv.length}`);
  }

  try {
    const decipher = createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    return pt.toString("utf8");
  } catch {
    throw new SecretCryptoError(
      "Failed to decrypt secret (wrong key or corrupted ciphertext)",
    );
  }
}

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}
