/**
 * Destructive-action audit helpers:
 *   1. Standardised detail strings for delete / credential mutations.
 *   2. Process-local burst detector that emits [audit-alert] when a single
 *      actor fires too many destructive ops in a short window.
 *
 * The detector is best-effort (single machine). Wire it to an external
 * notifier (email / Slack / PagerDuty) later if needed — for now Fly logs
 * + the Kintone audit app are the system of record.
 */

export type DestructiveKind =
  | "version.delete"
  | "device.delete"
  | "credential.create"
  | "credential.update"
  | "credential.delete"
  /** 顧客情報アプリの機器認証情報を参照した（トークン発行・引き換え）。
   *  削除系ではないが、平文パスワードに触れる操作なのでバースト検知の対象に含める。 */
  | "credential.reveal";

export interface DestructiveAuditFields {
  kind: DestructiveKind;
  /** Free-form human summary (kept for the existing audit UI). */
  summary: string;
  /** Structured key=value fragments appended after the summary. */
  attrs?: Record<string, string | number | undefined | null>;
}

/**
 * Build a stable audit `detail` string:
 *   event=<kind> | <summary> | k=v k2=v2
 *
 * Downstream greppers / alert rules can key off `event=`.
 */
export function formatDestructiveDetail(fields: DestructiveAuditFields): string {
  const parts: string[] = [`event=${fields.kind}`, fields.summary];
  if (fields.attrs) {
    const kv = Object.entries(fields.attrs)
      .filter(([, v]) => v !== undefined && v !== null && v !== "")
      .map(([k, v]) => `${k}=${String(v)}`)
      .join(" ");
    if (kv) parts.push(kv);
  }
  return parts.join(" | ");
}

interface HitBucket {
  hits: number[];
}

const buckets = new Map<string, HitBucket>();

export interface BurstWatchOptions {
  /** Unique surface name (used in the bucket key + log line). */
  name: string;
  /** Max events inside the window before alerting. */
  limit: number;
  /** Window length in ms. */
  windowMs: number;
}

const DEFAULT_BURST: BurstWatchOptions = {
  name: "destructive",
  limit: 5,
  windowMs: 10 * 60 * 1000, // 5 deletes in 10 minutes
};

/**
 * Record a destructive action and emit `[audit-alert]` when the actor exceeds
 * the configured burst threshold. Always returns whether an alert was raised
 * so callers can optionally add a flag to the audit detail.
 */
export function watchDestructiveBurst(
  actorKey: string,
  kind: DestructiveKind,
  opts: BurstWatchOptions = DEFAULT_BURST,
): { alerted: boolean; count: number } {
  const key = `${opts.name}:${actorKey}`;
  const now = Date.now();
  const windowStart = now - opts.windowMs;
  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = { hits: [] };
    buckets.set(key, bucket);
  }
  bucket.hits = bucket.hits.filter((t) => t >= windowStart);
  bucket.hits.push(now);

  if (buckets.size > 10_000) {
    for (const [k, b] of buckets) {
      b.hits = b.hits.filter((t) => t >= windowStart);
      if (b.hits.length === 0) buckets.delete(k);
    }
  }

  const count = bucket.hits.length;
  if (count >= opts.limit) {
    console.warn(
      `[audit-alert] burst detected actor=${actorKey} kind=${kind} ` +
        `count=${count}/${opts.limit} windowMs=${opts.windowMs}`,
    );
    return { alerted: true, count };
  }
  return { alerted: false, count };
}
