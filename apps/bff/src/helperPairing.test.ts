import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, createHash, createHmac, sign } from "node:crypto";
import {
  _resetHelperPairingForTests,
  issueHelperPairingChallenge,
  verifyHelperPairing,
  verifyHelperRedeemSignature,
} from "./helperPairing.js";

/** テスト用の helper identity（Ed25519 鍵 + 16 byte ペアリング secret）を作る。 */
function makeHelperIdentity() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicDER = publicKey.export({ format: "der", type: "spki" });
  const publicKeyText = publicDER.toString("base64url");
  const helperId = createHash("sha256").update(publicDER).digest("base64url");
  const pairingSecret = Buffer.alloc(16, 7);
  return {
    privateKey,
    publicKeyText,
    helperId,
    pairingSecret,
    pairingCode: pairingSecret.toString("base64url"),
  };
}

function proofFor(
  pairingSecret: Buffer,
  nonce: string,
  helperId: string,
  publicKey: string,
): string {
  return createHmac("sha256", pairingSecret)
    .update(`config-manager-helper-pair-v1\n${nonce}\n${helperId}\n${publicKey}`)
    .digest("base64url");
}

test("valid helper pairing succeeds once and rejects replay", () => {
  _resetHelperPairingForTests();
  const id = makeHelperIdentity();
  const operatorKey = "operator@example.com";
  const { nonce } = issueHelperPairingChallenge(operatorKey);
  const proof = proofFor(id.pairingSecret, nonce, id.helperId, id.publicKeyText);
  const identity = {
    helperId: id.helperId,
    publicKey: id.publicKeyText,
    pairingCode: id.pairingCode,
    proof,
  };
  assert.equal(verifyHelperPairing(identity, nonce, operatorKey), true);
  // nonce は単回。同じ proof の再送は失敗する。
  assert.equal(verifyHelperPairing(identity, nonce, operatorKey), false);
});

test("pairing is rejected for a different operator", () => {
  _resetHelperPairingForTests();
  const id = makeHelperIdentity();
  const { nonce } = issueHelperPairingChallenge("owner@example.com");
  const proof = proofFor(id.pairingSecret, nonce, id.helperId, id.publicKeyText);
  const paired = verifyHelperPairing(
    {
      helperId: id.helperId,
      publicKey: id.publicKeyText,
      pairingCode: id.pairingCode,
      proof,
    },
    nonce,
    "attacker@example.com",
  );
  assert.equal(paired, false);
});

test("pairing is rejected when the user types the wrong code", () => {
  _resetHelperPairingForTests();
  const id = makeHelperIdentity();
  const operatorKey = "operator@example.com";
  const { nonce } = issueHelperPairingChallenge(operatorKey);
  // proof はヘルパーが本物の secret で生成する。利用者が別のコードを打つと、
  // BFF が入力コードで計算した HMAC が proof と一致せず拒否される。
  const proof = proofFor(id.pairingSecret, nonce, id.helperId, id.publicKeyText);
  const wrongCode = Buffer.alloc(16, 9).toString("base64url");
  const paired = verifyHelperPairing(
    {
      helperId: id.helperId,
      publicKey: id.publicKeyText,
      pairingCode: wrongCode,
      proof,
    },
    nonce,
    operatorKey,
  );
  assert.equal(paired, false);
});

test("redeem signature verifies and is bound to the target host", () => {
  const id = makeHelperIdentity();
  const token = "test-token";
  const targetHost = "192.0.2.1";
  const signature = sign(
    null,
    Buffer.from(`config-manager-helper-redeem-v1\n${token}\n${targetHost}`),
    id.privateKey,
  ).toString("base64url");
  assert.equal(
    verifyHelperRedeemSignature(id.helperId, id.publicKeyText, token, targetHost, signature),
    true,
  );
  assert.equal(
    verifyHelperRedeemSignature(id.helperId, id.publicKeyText, token, "192.0.2.2", signature),
    false,
  );
});

test("redeem signature is rejected when helperId does not match the public key", () => {
  const id = makeHelperIdentity();
  const other = makeHelperIdentity();
  const token = "test-token";
  const targetHost = "192.0.2.1";
  const signature = sign(
    null,
    Buffer.from(`config-manager-helper-redeem-v1\n${token}\n${targetHost}`),
    id.privateKey,
  ).toString("base64url");
  assert.equal(
    verifyHelperRedeemSignature(other.helperId, id.publicKeyText, token, targetHost, signature),
    false,
  );
});
