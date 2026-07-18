#!/usr/bin/env node
/**
 * Create the Kintone field definitions for the config-management and audit-log
 * apps. The field codes here MUST match the codes read/written by the BFF in
 * apps/bff/src/kintone.ts.
 *
 * Authentication: this script uses the **API token** of the *target app* (the
 * app whose fields are being created). The token must have app-management
 * permission enabled. No Kintone user ID/password is required.
 *
 *   - For --app config it uses KINTONE_CONFIG_APP_TOKEN / KINTONE_CONFIG_APP_ID
 *   - For --app audit  it uses KINTONE_AUDIT_APP_TOKEN  / KINTONE_AUDIT_APP_ID
 *
 * Note: API tokens can ADD/DELETE form fields (preview APIs) on this Kintone
 * domain, but CANNOT read app settings (GET returns 401). So this script only
 * performs writes — it cannot show you the current fields. If a field code
 * already exists, the add call returns an error for that field; the rest still
 * apply. Inspect the form in the Kintone portal to see results.
 *
 * Usage:
 *   1. In the target app's 設定 > APIトークン, generate a token and enable the
 *      アプリ管理 (app management) permission, then click アプリを更新.
 *   2. Put the token + app id in .env.
 *   3. Run:
 *        node scripts/setup-kintone.mjs --app config
 *        node scripts/setup-kintone.mjs --app audit
 *        node scripts/setup-kintone.mjs --app all
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

// --- minimal .env loader (no dotenv dependency) ---
function loadEnv() {
  try {
    const text = readFileSync(resolve(root, ".env"), "utf8");
    for (const line of text.split("\n")) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)?\s*$/);
      if (!m) continue;
      const key = m[1];
      let val = m[2] ?? "";
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (!process.env[key]) process.env[key] = val;
    }
  } catch {
    /* fall back to real env vars */
  }
}
loadEnv();

function die(msg) {
  console.error("ERROR:", msg);
  process.exit(1);
}

function targetFor(which) {
  if (which === "config") {
    return {
      label: "コンフィグ管理",
      token: process.env.KINTONE_CONFIG_APP_TOKEN,
      appId: process.env.KINTONE_CONFIG_APP_ID,
      file: "config-app-fields.json",
    };
  }
  if (which === "audit") {
    return {
      label: "作業履歴",
      token: process.env.KINTONE_AUDIT_APP_TOKEN,
      appId: process.env.KINTONE_AUDIT_APP_ID,
      file: "audit-app-fields.json",
    };
  }
  die(`Unknown --app value: ${which}. Use config | audit | all.`);
}

const DOMAIN = process.env.KINTONE_DOMAIN;
if (!DOMAIN) die("KINTONE_DOMAIN is not set in .env");

const BASE = `https://${DOMAIN}`;

async function call(path, { method = "POST", token, body }) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "X-Cybozu-API-Token": token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  return { ok: res.ok, status: res.status, json };
}

async function applyFields({ label, token, appId, file }) {
  if (!token || token.startsWith("your-")) {
    die(
      `${label}: the API token is not set (still placeholder). Generate a ` +
        `token with app-management permission in the app's 設定 > APIトークン ` +
        `and set it in .env.`,
    );
  }
  if (!appId) die(`${label}: the app id is not set in .env.`);
  const id = Number(appId);

  console.log(`\n=== ${label}: app ${id} ===`);
  const def = JSON.parse(readFileSync(resolve(here, "kintone", file), "utf8"));
  const properties = def.properties;
  const codes = Object.keys(properties);
  console.log(`  ensuring ${codes.length} fields: ${codes.join(", ")}`);

  // 1. Add fields ONE BY ONE to the preview environment. This is idempotent:
  //    already-existing fields error per-call and are skipped, while new ones
  //    succeed. (A single bulk POST is rejected wholesale if any field exists.)
  let added = 0;
  let skipped = 0;
  for (const code of codes) {
    const one = await call("/k/v1/preview/app/form/fields.json", {
      token,
      body: { app: id, properties: { [code]: properties[code] } },
    });
    if (one.ok) {
      added++;
    } else {
      // GAIA_DT01 / similar: field code already exists -> benign.
      skipped++;
      console.log(
        `    - ${code}: exists/skipped (${one.json?.code ?? one.status})`,
      );
    }
  }
  console.log(`  added ${added}, already-existed ${skipped}.`);

  if (added === 0) {
    console.log("  no changes to deploy.");
    return;
  }

  // 2. Deploy preview to production.
  console.log("  deploying to production...");
  const deploy = await call("/k/v1/preview/app/deploy.json", {
    token,
    body: { apps: [{ app: id }] },
  });
  if (!deploy.ok) die(`deploy failed (${deploy.status}): ${JSON.stringify(deploy.json)}`);

  // 3. Poll until done.
  let status = "PROCESSING";
  for (let i = 0; i < 20 && status === "PROCESSING"; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const s = await fetch(
      `${BASE}/k/v1/preview/app/deploy.json?apps[0]=${id}`,
      { headers: { "X-Cybozu-API-Token": token } },
    );
    const sj = await s.json();
    status = sj?.apps?.[0]?.status ?? "DONE";
    if (!s.ok) {
      console.log(`  deploy status check returned ${s.status}; assuming done.`);
      status = "DONE";
      break;
    }
  }
  console.log(`  deploy status: ${status}`);
}

async function main() {
  const idx = process.argv.indexOf("--app");
  const which = idx >= 0 ? process.argv[idx + 1] : "all";
  const targets = which === "all" ? ["config", "audit"] : [which];
  for (const t of targets) {
    await applyFields(targetFor(t));
  }
  console.log(
    "\n✓ Done. Open each app's 設定 > フォーム in the portal to verify the " +
      "fields, then make sure the API token has the record read/add/update " +
      "permissions (and app management if you'll re-run this script).",
  );
}

main().catch((e) => die(e?.stack || String(e)));
