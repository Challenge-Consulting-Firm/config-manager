import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { evaluateAudit, renderSummary } from "./check-pnpm-audit.mjs";

const baseline = JSON.parse(await readFile(new URL("../.github/security-audit-baseline.json", import.meta.url), "utf8"));

function advisory({
  packageName = "example",
  severity = "high",
  ghsa = "GHSA-aaaa-bbbb-cccc",
  cves = ["CVE-2026-1000"],
} = {}) {
  return {
    module_name: packageName,
    severity,
    github_advisory_id: ghsa,
    cves,
    url: `https://github.com/advisories/${ghsa}`,
    title: "Test advisory",
  };
}

function report(...advisories) {
  return { advisories: Object.fromEntries(advisories.map((entry, index) => [String(index), entry])) };
}

test("advisory がない場合は成功する", () => {
  const result = evaluateAudit({ report: report(), baseline, today: "2026-08-26" });
  assert.equal(result.ok, true);
  assert.equal(result.blocking.length, 0);
  assert.equal(result.stale.length, 2);
});

test("期限内の xlsx 既知2件だけなら成功する", () => {
  const result = evaluateAudit({
    report: report(
      advisory({ packageName: "xlsx", ghsa: "GHSA-4r6h-8v6p-xvw6", cves: ["CVE-2023-30533"] }),
      advisory({ packageName: "xlsx", ghsa: "GHSA-5pgg-2g8v-p4x9", cves: ["CVE-2024-22363"] }),
    ),
    baseline,
    today: "2026-11-30",
  });
  assert.equal(result.ok, true);
  assert.equal(result.matched.length, 2);
  assert.equal(result.expired.length, 0);
});

test("期限の翌日は既知 advisory でも失敗する", () => {
  const result = evaluateAudit({
    report: report(advisory({ packageName: "xlsx", ghsa: "GHSA-4r6h-8v6p-xvw6", cves: ["CVE-2023-30533"] })),
    baseline,
    today: "2026-12-01",
  });
  assert.equal(result.ok, false);
  assert.equal(result.expired.length, 2);
  assert.equal(result.blocking.length, 1);
});

test("新規 High と Critical は失敗する", () => {
  const result = evaluateAudit({
    report: report(advisory(), advisory({ severity: "critical", ghsa: "GHSA-dddd-eeee-ffff", cves: ["CVE-2026-2000"] })),
    baseline,
    today: "2026-08-26",
  });
  assert.equal(result.ok, false);
  assert.equal(result.blocking.length, 2);
});

test("Moderate と Low は表示するが失敗させない", () => {
  const result = evaluateAudit({
    report: report(
      advisory({ severity: "moderate" }),
      advisory({ severity: "low", ghsa: "GHSA-dddd-eeee-ffff", cves: ["CVE-2026-2000"] }),
    ),
    baseline,
    today: "2026-08-26",
  });
  assert.equal(result.ok, true);
  assert.equal(result.informational.length, 2);
});

test("package、severity、CVE、GHSA のいずれかが違えば除外しない", () => {
  const variants = [
    advisory({ packageName: "not-xlsx", ghsa: "GHSA-4r6h-8v6p-xvw6", cves: ["CVE-2023-30533"] }),
    advisory({ packageName: "xlsx", severity: "critical", ghsa: "GHSA-4r6h-8v6p-xvw6", cves: ["CVE-2023-30533"] }),
    advisory({ packageName: "xlsx", ghsa: "GHSA-4r6h-8v6p-xvw6", cves: ["CVE-2026-9999"] }),
    advisory({ packageName: "xlsx", ghsa: "GHSA-dddd-eeee-ffff", cves: ["CVE-2023-30533"] }),
  ];
  const result = evaluateAudit({ report: report(...variants), baseline, today: "2026-08-26" });
  assert.equal(result.ok, false);
  assert.equal(result.blocking.length, 4);
});

test("不正またはエラーの audit JSON は fail closed", () => {
  assert.throws(() => evaluateAudit({ report: {}, baseline, today: "2026-08-26" }), /advisories/);
  assert.throws(() => evaluateAudit({ report: { error: "registry unavailable" }, baseline, today: "2026-08-26" }), /エラー/);
  assert.throws(() => evaluateAudit({ report: { advisories: { one: {} } }, baseline, today: "2026-08-26" }), /不足/);
});

test("baseline の重複と不正日付を拒否する", () => {
  const duplicate = { ...baseline, npm: [...baseline.npm, baseline.npm[0]] };
  assert.throws(() => evaluateAudit({ report: report(), baseline: duplicate, today: "2026-08-26" }), /重複/);

  const invalidDate = structuredClone(baseline);
  invalidDate.npm[0].expiresOn = "2026-02-30";
  assert.throws(() => evaluateAudit({ report: report(), baseline: invalidDate, today: "2026-08-26" }), /実在する日付/);
});

test("サマリに判定とブロック対象を含める", () => {
  const result = evaluateAudit({ report: report(advisory()), baseline, today: "2026-08-26" });
  const summary = renderSummary(result, "2026-08-26");
  assert.match(summary, /新規 High\/Critical: 1件/);
  assert.match(summary, /結果: 失敗/);
});

test("symlink 経由の CLI 起動でも監査を実行する", async () => {
  const directory = await mkdtemp(join(tmpdir(), "audit-gate-"));
  const link = join(directory, "check-audit.mjs");
  await symlink(new URL("./check-pnpm-audit.mjs", import.meta.url), link);

  const command = spawnSync(process.execPath, [link, "--date", "2026-08-26"], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
  });
  assert.equal(command.status, 0, command.stderr);
  assert.match(command.stdout, /pnpm dependency audit/);
  assert.match(command.stdout, /結果: 成功/);
});
