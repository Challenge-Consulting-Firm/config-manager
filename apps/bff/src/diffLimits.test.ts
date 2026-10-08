/**
 * コンフィグ差分のメモリ上限テスト。
 *
 * LCS 表は (m+1)×(n+1) のサイズになるため、行数の多いコンフィグ同士の比較で
 * BFF のメモリを使い切らないよう、上限を超えたら簡易差分に切り替える。
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  countLines,
  diffConfigs,
  MAX_DIFF_LINES,
  MAX_LCS_CELLS,
} from "@config-manager/shared";

const ver = (generation: number, lines: string[]) => ({
  generation,
  body: lines.join("\n"),
  hash: "",
});

test("行数が多く上限を超える比較は簡易差分になり、すぐに終わる", () => {
  const n = Math.ceil(Math.sqrt(MAX_LCS_CELLS)) + 10;
  const a = Array.from({ length: n }, (_, i) => `a${i}`);
  const b = Array.from({ length: n }, (_, i) => `b${i}`);
  const started = Date.now();
  const diff = diffConfigs(ver(1, a), ver(2, b));
  assert.ok(Date.now() - started < 2000);
  assert.equal(diff.approximate, true);
  assert.deepEqual(diff.stats, { added: n, removed: n, unchanged: 0 });
});

test("共通の先頭・末尾は上限の計算から除かれ、正確な差分になる", () => {
  const common = Array.from({ length: 20_000 }, (_, i) => `line ${i}`);
  const a = [...common.slice(0, 10_000), "old", ...common.slice(10_000)];
  const b = [...common.slice(0, 10_000), "new", ...common.slice(10_000)];
  const diff = diffConfigs(ver(1, a), ver(2, b));
  assert.equal(diff.approximate, undefined);
  assert.deepEqual(diff.stats, { added: 1, removed: 1, unchanged: 20_000 });
  const removed = diff.lines.find((l) => l.type === "removed");
  const added = diff.lines.find((l) => l.type === "added");
  assert.equal(removed?.oldNumber, 10_001);
  assert.equal(added?.newNumber, 10_001);
});

test("小さな差分は従来と同じ順序・行番号で出力される", () => {
  const diff = diffConfigs(ver(1, ["a", "b", "c"]), ver(2, ["a", "x", "c", "d"]));
  assert.deepEqual(diff.stats, { added: 2, removed: 1, unchanged: 2 });
  assert.deepEqual(
    diff.lines.map((l) => [l.type, l.oldNumber, l.newNumber, l.text]),
    [
      ["unchanged", 1, 1, "a"],
      ["added", null, 2, "x"],
      ["removed", 2, null, "b"],
      ["unchanged", 3, 3, "c"],
      ["added", null, 4, "d"],
    ],
  );
});

test("共通接頭辞の長い行でも、上限直下の比較が短時間で終わる", () => {
  // 行を整数 ID に置き換えて比較するため、行の長さは LCS の計算量に効かない。
  const n = Math.floor(Math.sqrt(MAX_LCS_CELLS)) - 2;
  const prefix = "x".repeat(10_000);
  const a = Array.from({ length: n }, (_, i) => `${prefix}a${i % 7}`);
  const b = Array.from({ length: n }, (_, i) => `${prefix}b${i % 7}`);
  const started = Date.now();
  const diff = diffConfigs(ver(1, a), ver(2, b));
  assert.equal(diff.approximate, undefined);
  assert.ok(Date.now() - started < 3000);
});

test("countLines は split(\"\\n\") と同じ行数を返す", () => {
  for (const body of ["", "a", "a\n", "a\nb", "\n\n", "a\n\nb\n"]) {
    const expected = body.length === 0 ? 0 : body.split("\n").length;
    assert.equal(countLines(body), expected, JSON.stringify(body));
  }
  assert.ok(countLines("x\n".repeat(MAX_DIFF_LINES)) > MAX_DIFF_LINES);
});

test("空の本文との比較では全行が追加・削除になる", () => {
  const added = diffConfigs(ver(1, []), ver(2, ["a", "b"]));
  assert.deepEqual(added.stats, { added: 2, removed: 0, unchanged: 0 });
  const removed = diffConfigs(ver(1, ["a", "b"]), ver(2, []));
  assert.deepEqual(removed.stats, { added: 0, removed: 2, unchanged: 0 });
  const same = diffConfigs(ver(1, ["a", "b"]), ver(2, ["a", "b"]));
  assert.deepEqual(same.stats, { added: 0, removed: 0, unchanged: 2 });
});
