#!/usr/bin/env node

import { appendFile, readFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const DEFAULT_BASELINE_PATH = new URL("../.github/security-audit-baseline.json", import.meta.url);
const BLOCKING_SEVERITIES = new Set(["high", "critical"]);
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function normalizeStrings(values) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.filter((value) => typeof value === "string").map((value) => value.trim()).filter(Boolean))].sort();
}

function validateDate(value, field) {
  if (typeof value !== "string" || !DATE_PATTERN.test(value)) {
    throw new Error(`${field} は YYYY-MM-DD 形式で指定してください`);
  }

  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error(`${field} が実在する日付ではありません: ${value}`);
  }
}

function normalizeBaseline(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("baseline のルートはオブジェクトである必要があります");
  }
  if (raw.schemaVersion !== 1 || !Array.isArray(raw.npm)) {
    throw new Error("baseline は schemaVersion: 1 と npm 配列を含む必要があります");
  }

  const seen = new Set();
  return raw.npm.map((entry, index) => {
    const field = `npm[${index}]`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`${field} はオブジェクトである必要があります`);
    }

    for (const key of ["package", "severity", "ghsa", "advisory", "reason", "expiresOn"]) {
      if (typeof entry[key] !== "string" || entry[key].trim() === "") {
        throw new Error(`${field}.${key} は空でない文字列である必要があります`);
      }
    }

    const severity = entry.severity.toLowerCase();
    if (!BLOCKING_SEVERITIES.has(severity)) {
      throw new Error(`${field}.severity は high または critical である必要があります`);
    }
    if (!/^GHSA-[0-9a-z-]+$/i.test(entry.ghsa)) {
      throw new Error(`${field}.ghsa の形式が不正です: ${entry.ghsa}`);
    }
    const cves = normalizeStrings(entry.cves);
    if (cves.length === 0 || cves.some((cve) => !/^CVE-\d{4}-\d+$/i.test(cve))) {
      throw new Error(`${field}.cves は1件以上のCVE IDを含む必要があります`);
    }
    validateDate(entry.expiresOn, `${field}.expiresOn`);

    const normalized = {
      package: entry.package,
      severity,
      ghsa: entry.ghsa.toUpperCase(),
      cves: cves.map((cve) => cve.toUpperCase()),
      advisory: entry.advisory,
      reason: entry.reason,
      expiresOn: entry.expiresOn,
    };
    const key = `${normalized.package}\u0000${normalized.ghsa}`;
    if (seen.has(key)) {
      throw new Error(`baseline が重複しています: ${normalized.package} / ${normalized.ghsa}`);
    }
    seen.add(key);
    return normalized;
  });
}

function normalizeAdvisories(report) {
  if (!report || typeof report !== "object" || Array.isArray(report)) {
    throw new Error("pnpm audit の結果はオブジェクトである必要があります");
  }
  if (report.error) {
    const message = typeof report.error === "string" ? report.error : JSON.stringify(report.error);
    throw new Error(`pnpm audit がエラーを返しました: ${message}`);
  }
  if (!("advisories" in report)) {
    throw new Error("pnpm audit の結果に advisories がありません");
  }

  const entries = Array.isArray(report.advisories)
    ? report.advisories
    : report.advisories && typeof report.advisories === "object"
      ? Object.values(report.advisories)
      : null;
  if (!entries) {
    throw new Error("pnpm audit の advisories は配列またはオブジェクトである必要があります");
  }

  return entries.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`advisories[${index}] はオブジェクトである必要があります`);
    }
    const packageName = entry.module_name ?? entry.name;
    const ghsa = entry.github_advisory_id ?? entry.github_advisory ?? entry.ghsa;
    const severity = typeof entry.severity === "string" ? entry.severity.toLowerCase() : "";
    if (typeof packageName !== "string" || packageName === "" || typeof ghsa !== "string" || ghsa === "" || severity === "") {
      throw new Error(`advisories[${index}] に package/GHSA/severity が不足しています`);
    }

    return {
      package: packageName,
      severity,
      ghsa: ghsa.toUpperCase(),
      cves: normalizeStrings(entry.cves).map((cve) => cve.toUpperCase()),
      advisory: typeof entry.url === "string" ? entry.url : "",
      title: typeof entry.title === "string" ? entry.title : "",
    };
  });
}

function sameStrings(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function baselineMatches(advisory, baseline) {
  return advisory.package === baseline.package
    && advisory.severity === baseline.severity
    && advisory.ghsa === baseline.ghsa
    && sameStrings(advisory.cves, baseline.cves);
}

export function evaluateAudit({ report, baseline, today }) {
  validateDate(today, "today");
  const advisories = normalizeAdvisories(report);
  const allowedEntries = normalizeBaseline(baseline);
  const expired = allowedEntries.filter((entry) => today > entry.expiresOn);
  const matched = [];
  const blocking = [];
  const informational = [];

  for (const advisory of advisories) {
    const allowed = allowedEntries.find((entry) => baselineMatches(advisory, entry));
    if (allowed && today <= allowed.expiresOn) {
      matched.push({ advisory, baseline: allowed });
    } else if (BLOCKING_SEVERITIES.has(advisory.severity)) {
      blocking.push(advisory);
    } else {
      informational.push(advisory);
    }
  }

  const matchedKeys = new Set(matched.map(({ baseline: entry }) => `${entry.package}\u0000${entry.ghsa}`));
  const stale = allowedEntries.filter((entry) => !matchedKeys.has(`${entry.package}\u0000${entry.ghsa}`));

  return {
    ok: blocking.length === 0 && expired.length === 0,
    advisories,
    matched,
    blocking,
    informational,
    expired,
    stale,
  };
}

export function renderSummary(result, today) {
  const lines = [
    "## pnpm dependency audit",
    "",
    `- 判定日 (UTC): ${today}`,
    `- 検出 advisory: ${result.advisories.length}件`,
    `- 期限内 baseline: ${result.matched.length}件`,
    `- 新規 High/Critical: ${result.blocking.length}件`,
    `- 期限切れ baseline: ${result.expired.length}件`,
    "",
  ];

  if (result.matched.length > 0) {
    lines.push("### 期限内の既知例外", "");
    for (const { advisory, baseline } of result.matched) {
      lines.push(`- ${advisory.package} / ${advisory.ghsa} (${advisory.severity}) — 期限 ${baseline.expiresOn}`);
    }
    lines.push("");
  }
  if (result.blocking.length > 0) {
    lines.push("### ブロック対象", "");
    for (const advisory of result.blocking) {
      lines.push(`- ${advisory.package} / ${advisory.ghsa} (${advisory.severity})${advisory.advisory ? ` — ${advisory.advisory}` : ""}`);
    }
    lines.push("");
  }
  if (result.expired.length > 0) {
    lines.push("### 期限切れ baseline", "");
    for (const entry of result.expired) {
      lines.push(`- ${entry.package} / ${entry.ghsa} — ${entry.expiresOn}`);
    }
    lines.push("");
  }
  const resolved = result.stale.filter((entry) => !result.expired.includes(entry));
  if (resolved.length > 0) {
    lines.push("### 現在は検出されない baseline", "");
    for (const entry of resolved) {
      lines.push(`- ${entry.package} / ${entry.ghsa} — 解消を確認後、baseline から削除してください`);
    }
    lines.push("");
  }

  lines.push(result.ok ? "**結果: 成功**" : "**結果: 失敗**", "");
  return lines.join("\n");
}

function currentUtcDate() {
  return new Date().toISOString().slice(0, 10);
}

function parseArguments(argv) {
  const options = { reportPath: null, baselinePath: fileURLToPath(DEFAULT_BASELINE_PATH), today: currentUtcDate() };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--report" || argument === "--baseline" || argument === "--date") {
      const value = argv[index + 1];
      if (!value) throw new Error(`${argument} の値が必要です`);
      if (argument === "--report") options.reportPath = value;
      if (argument === "--baseline") options.baselinePath = value;
      if (argument === "--date") options.today = value;
      index += 1;
    } else {
      throw new Error(`不明な引数です: ${argument}`);
    }
  }
  return options;
}

async function loadReport(reportPath) {
  if (reportPath) {
    return JSON.parse(await readFile(reportPath, "utf8"));
  }

  const command = spawnSync("pnpm", ["audit", "--audit-level=high", "--json"], {
    cwd: process.cwd(),
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  if (command.error) throw command.error;
  if (command.signal) throw new Error(`pnpm audit がシグナル ${command.signal} で終了しました`);
  if (!command.stdout.trim()) {
    throw new Error(`pnpm audit がJSONを返しませんでした (exit ${command.status ?? "unknown"}): ${command.stderr.trim()}`);
  }
  return JSON.parse(command.stdout);
}

async function main() {
  try {
    const options = parseArguments(process.argv.slice(2));
    const [report, baseline] = await Promise.all([
      loadReport(options.reportPath),
      readFile(options.baselinePath, "utf8").then(JSON.parse),
    ]);
    const result = evaluateAudit({ report, baseline, today: options.today });
    const summary = renderSummary(result, options.today);
    console.log(summary);
    if (process.env.GITHUB_STEP_SUMMARY) {
      await appendFile(process.env.GITHUB_STEP_SUMMARY, summary, "utf8");
    }
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Dependency audit gate error: ${message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  await main();
}
