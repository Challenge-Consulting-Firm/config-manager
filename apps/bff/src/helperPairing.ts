import {
  createHash,
  createHmac,
  createPublicKey,
  randomBytes,
  timingSafeEqual,
  verify,
} from "node:crypto";

const PAIRING_NONCE_TTL_MS = 2 * 60 * 1000;
const PAIRING_MESSAGE_PREFIX = "config-manager-helper-pair-v1";
const REDEEM_MESSAGE_PREFIX = "config-manager-helper-redeem-v1";
const HELPER_ID_RE = /^[A-Za-z0-9_-]{43}$/;
const PUBLIC_KEY_RE = /^[A-Za-z0-9_-]{50,200}$/;
const PROOF_RE = /^[A-Za-z0-9_-]{43}$/;
const SIGNATURE_RE = /^[A-Za-z0-9_-]{86}$/;

interface PairingChallenge {
  expiresAt: number;
  operatorKey: string;
}

const challenges = new Map<string, PairingChallenge>();

export interface HelperPairingIdentity {
  helperId: string;
  publicKey: string;
  pairingCode: string;
  proof: string;
}

export function issueHelperPairingChallenge(operatorKey: string): {
  nonce: string;
  expiresInMs: number;
} {
  const now = Date.now();
  sweepExpired(now);
  const nonce = randomBytes(32).toString("base64url");
  challenges.set(nonce, {
    operatorKey,
    expiresAt: now + PAIRING_NONCE_TTL_MS,
  });
  return { nonce, expiresInMs: PAIRING_NONCE_TTL_MS };
}

export function verifyHelperPairing(
  identity: HelperPairingIdentity,
  nonce: string,
  operatorKey: string,
): boolean {
  const now = Date.now();
  sweepExpired(now);
  const challenge = challenges.get(nonce);
  // challenge は成否を問わず一回限りにし、proof の replay を防ぐ。
  challenges.delete(nonce);
  if (
    !challenge ||
    challenge.expiresAt <= now ||
    challenge.operatorKey !== operatorKey ||
    !validHelperIdentity(identity.helperId, identity.publicKey) ||
    !PROOF_RE.test(identity.proof)
  ) {
    return false;
  }

  const expectedId = helperIdFromPublicKey(identity.publicKey);
  if (!constantTimeTextEqual(expectedId, identity.helperId)) return false;

  let pairingSecret: Buffer;
  let suppliedProof: Buffer;
  try {
    pairingSecret = Buffer.from(identity.pairingCode, "base64url");
    suppliedProof = Buffer.from(identity.proof, "base64url");
  } catch {
    return false;
  }
  if (pairingSecret.length !== 16 || suppliedProof.length !== 32) return false;

  const message = pairingMessage(nonce, identity.helperId, identity.publicKey);
  const expectedProof = createHmac("sha256", pairingSecret)
    .update(message, "utf8")
    .digest();
  return timingSafeEqual(expectedProof, suppliedProof);
}

export function verifyHelperRedeemSignature(
  helperId: string,
  publicKey: string,
  token: string,
  targetHost: string,
  signature: string,
): boolean {
  if (
    !validHelperIdentity(helperId, publicKey) ||
    !SIGNATURE_RE.test(signature) ||
    !constantTimeTextEqual(helperIdFromPublicKey(publicKey), helperId)
  ) {
    return false;
  }
  try {
    const key = createPublicKey({
      key: Buffer.from(publicKey, "base64url"),
      format: "der",
      type: "spki",
    });
    return verify(
      null,
      Buffer.from(redeemMessage(token, targetHost), "utf8"),
      key,
      Buffer.from(signature, "base64url"),
    );
  } catch {
    return false;
  }
}

function validHelperIdentity(helperId: string, publicKey: string): boolean {
  return HELPER_ID_RE.test(helperId) && PUBLIC_KEY_RE.test(publicKey);
}

function helperIdFromPublicKey(publicKey: string): string {
  try {
    return createHash("sha256")
      .update(Buffer.from(publicKey, "base64url"))
      .digest("base64url");
  } catch {
    return "";
  }
}

function constantTimeTextEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function pairingMessage(
  nonce: string,
  helperId: string,
  publicKey: string,
): string {
  return `${PAIRING_MESSAGE_PREFIX}\n${nonce}\n${helperId}\n${publicKey}`;
}

function redeemMessage(token: string, targetHost: string): string {
  return `${REDEEM_MESSAGE_PREFIX}\n${token}\n${targetHost}`;
}

function sweepExpired(now: number): void {
  for (const [nonce, challenge] of challenges) {
    if (challenge.expiresAt <= now) challenges.delete(nonce);
  }
}

export function _resetHelperPairingForTests(): void {
  challenges.clear();
}
