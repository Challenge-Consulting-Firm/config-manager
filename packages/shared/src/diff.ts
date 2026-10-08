/**
 * A minimal LCS-based unified diff implementation with no dependencies.
 *
 * Produces both a unified-diff patch string (for download) and a structured
 * line array consumed by the dependency-free DiffViewer component.
 */

import type { ConfigDiff, DiffLine } from "./types.js";

/**
 * LCS 表のセル数上限。表は (m+1)×(n+1) の Uint32Array で 1 セル 4 バイトの
 * ため、上限時でも約 40 MB に収まる。これを超える比較は簡易差分に切り替える
 * （無制限に確保すると、行数の多いコンフィグ同士の比較だけで BFF のメモリを
 * 使い切る DoS になるため）。
 */
export const MAX_LCS_CELLS = 10_000_000;

/**
 * 差分を計算する本文の行数上限（片側）。簡易差分に切り替えても、行ごとの
 * オブジェクト・パッチ文字列・JSON 応答は行数に比例して膨らむため、これを
 * 超える比較は呼び出し側で拒否する（diffConfigs 自体は制限しない）。
 */
export const MAX_DIFF_LINES = 100_000;

/** split せずに本文の行数を数える（巨大な本文で配列を作らないため）。 */
export function countLines(body: string): number {
  if (body.length === 0) return 0;
  let n = 1;
  for (let i = body.indexOf("\n"); i !== -1; i = body.indexOf("\n", i + 1)) n++;
  return n;
}

interface RawDiffLine {
  type: "added" | "removed" | "unchanged";
  oldNumber: number | null;
  newNumber: number | null;
  text: string;
}

/**
 * 行を整数 ID に置き換える。LCS の内側ループで長い行同士の文字列比較を
 * 繰り返すと、共通接頭辞の長い行でセル数以上に CPU を食うため。
 */
function internLines(a: string[], b: string[]): [Int32Array, Int32Array] {
  const ids = new Map<string, number>();
  const intern = (lines: string[]) => {
    const out = new Int32Array(lines.length);
    lines.forEach((line, k) => {
      let id = ids.get(line);
      if (id === undefined) {
        id = ids.size;
        ids.set(line, id);
      }
      out[k] = id;
    });
    return out;
  };
  return [intern(a), intern(b)];
}

/** a / b の LCS 長の表を行優先の 1 次元配列で返す（幅は b.length + 1）。 */
function buildLcs(a: Int32Array, b: Int32Array): Uint32Array {
  const m = a.length;
  const n = b.length;
  const w = n + 1;
  const dp = new Uint32Array((m + 1) * w);
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i * w + j] = dp[(i - 1) * w + (j - 1)] + 1;
      } else {
        dp[i * w + j] = Math.max(dp[(i - 1) * w + j], dp[i * w + (j - 1)]);
      }
    }
  }
  return dp;
}

/**
 * 中間部分（共通の先頭・末尾を除いた残り）の差分行を返す。行番号は
 * offset 分ずらして元の行番号に合わせる。
 */
function diffMiddle(
  a: string[],
  b: string[],
  offset: number,
): RawDiffLine[] {
  const stack: RawDiffLine[] = [];
  let i = a.length;
  let j = b.length;

  if (a.length > 0 && b.length > 0) {
    const [ia, ib] = internLines(a, b);
    const dp = buildLcs(ia, ib);
    const w = b.length + 1;
    // Walk the DP table back to front emitting lines.
    while (i > 0 && j > 0) {
      if (ia[i - 1] === ib[j - 1]) {
        stack.push({
          type: "unchanged",
          oldNumber: offset + i,
          newNumber: offset + j,
          text: a[i - 1],
        });
        i--;
        j--;
      } else if (dp[(i - 1) * w + j] >= dp[i * w + (j - 1)]) {
        stack.push({
          type: "removed",
          oldNumber: offset + i,
          newNumber: null,
          text: a[i - 1],
        });
        i--;
      } else {
        stack.push({
          type: "added",
          oldNumber: null,
          newNumber: offset + j,
          text: b[j - 1],
        });
        j--;
      }
    }
  }
  while (i > 0) {
    stack.push({
      type: "removed",
      oldNumber: offset + i,
      newNumber: null,
      text: a[i - 1],
    });
    i--;
  }
  while (j > 0) {
    stack.push({
      type: "added",
      oldNumber: null,
      newNumber: offset + j,
      text: b[j - 1],
    });
    j--;
  }
  return stack.reverse();
}

/** 中間部分を LCS を使わず「全削除 → 全追加」として扱う簡易差分。 */
function coarseMiddle(
  a: string[],
  b: string[],
  offset: number,
): RawDiffLine[] {
  const out: RawDiffLine[] = [];
  a.forEach((text, k) =>
    out.push({ type: "removed", oldNumber: offset + k + 1, newNumber: null, text }),
  );
  b.forEach((text, k) =>
    out.push({ type: "added", oldNumber: null, newNumber: offset + k + 1, text }),
  );
  return out;
}

function toDiffLines(
  a: string[],
  b: string[],
): { lines: RawDiffLine[]; approximate: boolean } {
  // 共通の先頭・末尾は LCS に掛けずに unchanged とする。世代間の差分は大半が
  // 局所的なので、これだけで LCS 表を大幅に小さくできる。
  let prefix = 0;
  const minLen = Math.min(a.length, b.length);
  while (prefix < minLen && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < minLen - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix++;
  }

  const midA = a.slice(prefix, a.length - suffix);
  const midB = b.slice(prefix, b.length - suffix);
  const approximate = (midA.length + 1) * (midB.length + 1) > MAX_LCS_CELLS;

  const lines: RawDiffLine[] = [];
  for (let k = 0; k < prefix; k++) {
    lines.push({ type: "unchanged", oldNumber: k + 1, newNumber: k + 1, text: a[k] });
  }
  const middle = approximate
    ? coarseMiddle(midA, midB, prefix)
    : diffMiddle(midA, midB, prefix);
  for (const l of middle) lines.push(l);
  for (let k = suffix; k > 0; k--) {
    lines.push({
      type: "unchanged",
      oldNumber: a.length - k + 1,
      newNumber: b.length - k + 1,
      text: a[a.length - k],
    });
  }
  return { lines, approximate };
}

/** Produce a unified-diff patch string from structured diff lines. */
function toUnifiedPatch(
  lines: RawDiffLine[],
  beforeLabel: string,
  afterLabel: string,
): string {
  const out: string[] = [];
  out.push(`--- ${beforeLabel}`);
  out.push(`+++ ${afterLabel}`);

  // Collapse consecutive runs into hunks.
  let idx = 0;
  while (idx < lines.length) {
    const line = lines[idx];
    if (line.type === "unchanged") {
      idx++;
      continue;
    }
    // Start a hunk. Gather context = up to 3 unchanged lines around changes.
    let start = idx;
    // back up to 3 context lines
    let ctx = 0;
    while (start > 0 && ctx < 3 && lines[start - 1].type === "unchanged") {
      start--;
      ctx++;
    }
    let end = idx;
    while (end < lines.length) {
      if (lines[end].type === "unchanged") {
        // allow up to 3 trailing unchanged lines before breaking
        let run = 0;
        let probe = end;
        while (
          probe < lines.length &&
          lines[probe].type === "unchanged" &&
          run < 3
        ) {
          probe++;
          run++;
        }
        if (run < 3 || probe >= lines.length) {
          end = probe;
          break;
        } else {
          end++;
        }
      } else {
        end++;
      }
    }

    const hunk = lines.slice(start, end);
    const oldStart =
      (hunk.find((l) => l.oldNumber !== null)?.oldNumber ?? 0) -
      Math.min(
        3,
        hunk.findIndex((l) => l.oldNumber !== null) === -1
          ? 0
          : hunk.findIndex((l) => l.oldNumber !== null),
      );
    const newStart =
      (hunk.find((l) => l.newNumber !== null)?.newNumber ?? 0) -
      Math.min(
        3,
        hunk.findIndex((l) => l.newNumber !== null) === -1
          ? 0
          : hunk.findIndex((l) => l.newNumber !== null),
      );
    const oldCount = hunk.filter((l) => l.oldNumber !== null).length;
    const newCount = hunk.filter((l) => l.newNumber !== null).length;
    out.push(`@@ -${Math.max(oldStart, 1)},${oldCount} +${Math.max(newStart, 1)},${newCount} @@`);
    for (const l of hunk) {
      const prefix =
        l.type === "added" ? "+" : l.type === "removed" ? "-" : " ";
      out.push(prefix + l.text);
    }
    idx = end;
  }
  return out.join("\n");
}

/** Build a ConfigDiff from two normalized bodies. */
export function diffConfigs(
  before: { generation: number; body: string; hash: string },
  after: { generation: number; body: string; hash: string },
): ConfigDiff {
  const a = before.body.length === 0 ? [] : before.body.split("\n");
  const b = after.body.length === 0 ? [] : after.body.split("\n");
  const { lines: raw, approximate } = toDiffLines(a, b);

  const lines: DiffLine[] = raw.map((l) => ({ ...l }));
  const stats = {
    added: raw.filter((l) => l.type === "added").length,
    removed: raw.filter((l) => l.type === "removed").length,
    unchanged: raw.filter((l) => l.type === "unchanged").length,
  };
  const patch = toUnifiedPatch(
    raw,
    `generation-${before.generation}`,
    `generation-${after.generation}`,
  );
  return {
    before: { generation: before.generation, hash: before.hash },
    after: { generation: after.generation, hash: after.hash },
    patch,
    lines,
    stats,
    ...(approximate ? { approximate: true } : {}),
  };
}
