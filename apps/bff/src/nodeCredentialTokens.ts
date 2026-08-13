/**
 * 機器認証情報の引き換えトークン（Issue #53）。
 *
 * 【なぜトークンを挟むのか】
 * 機器のパスワードは、機器へログインする以上どこかで平文になる。素直に作れば
 * BFF → SPA → ヘルパー と流れるが、そうすると平文が React state・DevTools・
 * ブラウザ拡張・画面共有の露出面に載る。そこで SPA には**一回限りの不透明
 * トークン**だけを渡し、平文はローカル取得ヘルパーが BFF から直接引き換える。
 * これでブラウザは平文を一度も持たない。
 *
 * トークンの性質:
 *   - 32 バイトの乱数（推測不可）
 *   - 一回限り（引き換えた時点で破棄）
 *   - 短命（{@link NODE_CREDENTIAL_TOKEN_TTL_MS}）
 *   - 発行時の利用者・対象機器・レコード ID に束縛
 *
 * 保管はプロセスローカルの Map。単一 fly.io マシン構成での運用を前提とする。
 * 複数インスタンスへスケールする場合は共有ストアへ置き換えること（その時点で
 * ヘルパーの redeem が別インスタンスへ届いてトークンが見つからなくなる）。
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import { NODE_CREDENTIAL_TOKEN_TTL_MS } from "@config-manager/shared";

/** トークンに束縛される発行時のコンテキスト。 */
export interface NodeCredentialTokenContext {
  /** 顧客情報アプリのレコード ID。 */
  credentialId: string;
  /** パスワードの不可視文字を除去するか（利用者が明示的に選んだ場合のみ true）。 */
  stripInvisible: boolean;
  /** 発行を要求した利用者。監査ログに残す。 */
  operator: string;
  operatorEmail: string;
  /** 対象機器。redeem 時の監査ログに残す。 */
  target: { customer: string; hostname: string; ipAddress: string };
}

interface TokenEntry extends NodeCredentialTokenContext {
  expiresAt: number;
}

const tokens = new Map<string, TokenEntry>();

/** 期限切れのトークンを掃除する。発行・引き換えのたびに呼ばれる。 */
function sweepExpired(now: number): void {
  for (const [key, entry] of tokens) {
    if (entry.expiresAt <= now) tokens.delete(key);
  }
}

/**
 * トークンを発行する。返り値の文字列は SPA へ渡してよい（平文は含まない）。
 */
export function issueNodeCredentialToken(
  ctx: NodeCredentialTokenContext,
): { token: string; expiresInMs: number } {
  const now = Date.now();
  sweepExpired(now);
  const token = randomBytes(32).toString("base64url");
  tokens.set(token, { ...ctx, expiresAt: now + NODE_CREDENTIAL_TOKEN_TTL_MS });
  return { token, expiresInMs: NODE_CREDENTIAL_TOKEN_TTL_MS };
}

/**
 * トークンを引き換える。成功すると即座に破棄されるため、同じトークンで
 * 二度目の引き換えはできない。期限切れ・未知のトークンは null。
 *
 * 突き合わせは Map の参照で行うが、鍵の存在確認自体がタイミング差を生まない
 * よう、候補の比較には {@link timingSafeEqual} を使う。
 */
export function consumeNodeCredentialToken(
  token: string,
): NodeCredentialTokenContext | null {
  const now = Date.now();
  sweepExpired(now);
  if (!token) return null;

  // Map のキー探索はハッシュ照合なので、長さの一致する候補に対して
  // 定数時間比較を行い、早期リターンによる差を作らない。
  const candidate = Buffer.from(token);
  let matched: string | null = null;
  for (const key of tokens.keys()) {
    const keyBuf = Buffer.from(key);
    if (keyBuf.length !== candidate.length) continue;
    if (timingSafeEqual(keyBuf, candidate)) matched = key;
  }
  if (!matched) return null;

  const entry = tokens.get(matched);
  tokens.delete(matched);
  if (!entry || entry.expiresAt <= now) return null;

  const { expiresAt: _expiresAt, ...ctx } = entry;
  return ctx;
}

/** テスト用。保持中のトークンをすべて破棄する。 */
export function clearNodeCredentialTokens(): void {
  tokens.clear();
}
