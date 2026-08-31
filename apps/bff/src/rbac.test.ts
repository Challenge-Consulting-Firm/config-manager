import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Hono } from "hono";
import type { AppConfig } from "./config.js";
import {
  requireRole,
  resolveRoleFromGroups,
  roleGroupsConfigured,
} from "./rbac.js";
import type { AppEnv } from "./api.js";
import type { AppRole, AuthUser } from "@config-manager/shared";

/** Minimal AppConfig stub: resolveRoleFromGroups only reads these fields. */
function cfgWith(entra: Partial<AppConfig["entra"]>, nodeEnv = "development") {
  return {
    nodeEnv,
    entra: {
      requiredGroupIds: [],
      adminGroupIds: [],
      operatorGroupIds: [],
      viewerGroupIds: [],
      ...entra,
    },
  } as unknown as AppConfig;
}

const MAPPED = cfgWith({
  adminGroupIds: ["g-admin"],
  operatorGroupIds: ["g-operator"],
  viewerGroupIds: ["g-viewer"],
});

test("マッピング済みのグループを対応するロールへ解決する", () => {
  assert.equal(resolveRoleFromGroups(["g-admin"], MAPPED), "admin");
  assert.equal(resolveRoleFromGroups(["g-operator"], MAPPED), "operator");
  assert.equal(resolveRoleFromGroups(["g-viewer"], MAPPED), "viewer");
});

test("複数グループに属する場合は最上位のロールが勝つ", () => {
  assert.equal(
    resolveRoleFromGroups(["g-viewer", "g-admin", "g-operator"], MAPPED),
    "admin",
  );
});

test("未知のグループしか持たないユーザーは拒否する", () => {
  assert.equal(resolveRoleFromGroups(["g-unknown"], MAPPED), null);
  assert.equal(resolveRoleFromGroups([], MAPPED), null);
});

test("本番でロールグループ未設定なら admin へ昇格させない", () => {
  const cfg = cfgWith({}, "production");
  assert.equal(roleGroupsConfigured(cfg), false);
  assert.equal(resolveRoleFromGroups(["g-any"], cfg), null);
});

test("本番以外はロールグループ未設定なら従来どおり admin 扱い", () => {
  const cfg = cfgWith({}, "development");
  assert.equal(resolveRoleFromGroups([], cfg), "admin");
});

/** Exercise requireRole through a tiny app so the 403 shape is covered too. */
async function callGuarded(required: AppRole, actual: AppRole | undefined) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    if (actual) {
      c.set("user", { displayName: "t", email: "t@example.com", role: actual } satisfies AuthUser);
    }
    await next();
  });
  app.get("/guarded", requireRole(required), (c) => c.json({ ok: true }));
  return app.request("/guarded");
}

test("requireRole は必要権限に満たないロールを 403 で拒否する", async () => {
  const res = await callGuarded("operator", "viewer");
  assert.equal(res.status, 403);
  const body = (await res.json()) as { required: string; actual: string };
  assert.equal(body.required, "operator");
  assert.equal(body.actual, "viewer");
});

test("requireRole は user 未設定を 403 で拒否する", async () => {
  const res = await callGuarded("viewer", undefined);
  assert.equal(res.status, 403);
});

test("requireRole は同等以上のロールを通す", async () => {
  assert.equal((await callGuarded("operator", "operator")).status, 200);
  assert.equal((await callGuarded("operator", "admin")).status, 200);
  assert.equal((await callGuarded("viewer", "viewer")).status, 200);
});
