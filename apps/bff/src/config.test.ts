import { strict as assert } from "node:assert";
import { test } from "node:test";
import { _resetConfigCacheForTests, loadConfig } from "./config.js";

/** Env required by loadConfig() regardless of the RBAC settings under test. */
const BASE_ENV: Record<string, string> = {
  KINTONE_DOMAIN: "example.cybozu.com",
  KINTONE_CONFIG_APP_ID: "1",
  KINTONE_CONFIG_APP_TOKEN: "token",
  KINTONE_AUDIT_APP_ID: "2",
  KINTONE_AUDIT_APP_TOKEN: "token",
  ENTRA_TENANT_ID: "tenant",
  ENTRA_CLIENT_ID: "client",
  ENTRA_CLIENT_SECRET: "secret",
  SESSION_SECRET: "test-session-secret-at-least-32-characters",
};

/** Run loadConfig() against a pristine env built from BASE_ENV + overrides. */
function withEnv<T>(overrides: Record<string, string>, fn: () => T): T {
  const saved = process.env;
  process.env = { ...BASE_ENV, ...overrides } as NodeJS.ProcessEnv;
  _resetConfigCacheForTests();
  try {
    return fn();
  } finally {
    process.env = saved;
    _resetConfigCacheForTests();
  }
}

test("本番 OIDC でロールグループ未設定なら起動に失敗する", () => {
  withEnv({ NODE_ENV: "production", AUTH_MODE: "oidc" }, () => {
    assert.throws(
      () => loadConfig(),
      /ENTRA_GROUP_ADMIN_IDS/,
      "RBAC マッピング未設定は明確なエラーで拒否されること",
    );
  });
});

test("本番 OIDC でロールグループが1つでもあれば起動できる", () => {
  withEnv(
    {
      NODE_ENV: "production",
      AUTH_MODE: "oidc",
      ENTRA_GROUP_ADMIN_IDS: "g-admin",
    },
    () => {
      const cfg = loadConfig();
      assert.deepEqual(cfg.entra.adminGroupIds, ["g-admin"]);
      assert.deepEqual(cfg.entra.operatorGroupIds, []);
    },
  );
});

test("本番以外はロールグループ未設定でも起動できる", () => {
  withEnv({ NODE_ENV: "development", AUTH_MODE: "oidc" }, () => {
    const cfg = loadConfig();
    assert.equal(cfg.entra.adminGroupIds.length, 0);
  });
});

test("グループ ID はカンマ区切りで前後空白を落として読み込む", () => {
  withEnv(
    {
      NODE_ENV: "production",
      ENTRA_GROUP_ADMIN_IDS: " g-admin , g-admin2 ",
      ENTRA_GROUP_VIEWER_IDS: "g-viewer",
    },
    () => {
      const cfg = loadConfig();
      assert.deepEqual(cfg.entra.adminGroupIds, ["g-admin", "g-admin2"]);
      assert.deepEqual(cfg.entra.viewerGroupIds, ["g-viewer"]);
    },
  );
});
