/**
 * A minimal LCS-based unified diff implementation with no dependencies.
 *
 * Produces both a unified-diff patch string (for download) and a structured
 * line array consumed by the dependency-free DiffViewer component.
 */

import type { ConfigDiff, DiffLine } from "./types.js";

function buildLcs(a: string[], b: string[]): number[][] {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array(n + 1).fill(0),
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }
  return dp;
}

interface RawDiffLine {
  type: "added" | "removed" | "unchanged";
  oldNumber: number | null;
  newNumber: number | null;
  text: string;
}

function toDiffLines(a: string[], b: string[]): RawDiffLine[] {
  const dp = buildLcs(a, b);
  const result: RawDiffLine[] = [];
  let i = a.length;
  let j = b.length;
  let oldNo = a.length;
  let newNo = b.length;

  // Walk the DP table back to front emitting lines.
  const stack: RawDiffLine[] = [];
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      stack.push({
        type: "unchanged",
        oldNumber: oldNo--,
        newNumber: newNo--,
        text: a[i - 1],
      });
      i--;
      j--;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      stack.push({
        type: "removed",
        oldNumber: oldNo--,
        newNumber: null,
        text: a[i - 1],
      });
      i--;
    } else {
      stack.push({
        type: "added",
        oldNumber: null,
        newNumber: newNo--,
        text: b[j - 1],
      });
      j--;
    }
  }
  while (i > 0) {
    stack.push({
      type: "removed",
      oldNumber: oldNo--,
      newNumber: null,
      text: a[i - 1],
    });
    i--;
  }
  while (j > 0) {
    stack.push({
      type: "added",
      oldNumber: null,
      newNumber: newNo--,
      text: b[j - 1],
    });
    j--;
  }
  for (let k = stack.length - 1; k >= 0; k--) result.push(stack[k]);
  return result;
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
  const raw = toDiffLines(a, b);

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
  };
}
