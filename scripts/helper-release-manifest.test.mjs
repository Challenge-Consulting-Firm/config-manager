import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const SCRIPT = new URL("./helper-release-manifest.sh", import.meta.url).pathname;

/** 配布物を模した一時ディレクトリを作る。中身は任意のバイト列でよい。 */
async function fixture({ windows = true, macUniversal = true, macSplit = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "helper-manifest-"));
  await mkdir(join(dir, "windows-x64"), { recursive: true });
  await mkdir(join(dir, "darwin-universal"), { recursive: true });
  if (windows) {
    await writeFile(join(dir, "windows-x64/config-manager-helper.exe"), "windows-binary");
  }
  if (macUniversal) {
    await writeFile(join(dir, "darwin-universal/config-manager-helper"), "mac-universal-binary");
  }
  if (macSplit) {
    await writeFile(join(dir, "darwin-universal/config-manager-helper-arm64"), "mac-arm64");
    await writeFile(join(dir, "darwin-universal/config-manager-helper-amd64"), "mac-amd64");
  }
  return dir;
}

function run(dir, extraArgs = []) {
  return spawnSync(
    "bash",
    [SCRIPT, "--dir", dir, "--version", "1.2.3", ...extraArgs],
    { encoding: "utf8" },
  );
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

test("checksums と latest.json を生成し、ハッシュが実ファイルと一致する", async () => {
  const dir = await fixture();
  const result = run(dir);
  assert.equal(result.status, 0, result.stderr);

  const manifest = JSON.parse(await readFile(join(dir, "latest.json"), "utf8"));
  assert.equal(manifest.version, "1.2.3");
  assert.equal(
    manifest.assets["windows-x64"].sha256,
    sha256("windows-binary"),
  );
  assert.equal(
    manifest.assets["darwin-universal"].sha256,
    sha256("mac-universal-binary"),
  );

  const checksums = await readFile(join(dir, "checksums.sha256"), "utf8");
  assert.match(
    checksums,
    new RegExp(`^${sha256("windows-binary")}  windows-x64/config-manager-helper\\.exe$`, "m"),
  );
});

test("署名種別が latest.json に記録される", async () => {
  const dir = await fixture();
  const result = run(dir, [
    "--windows-signature",
    "authenticode",
    "--macos-signature",
    "developer-id-notarized",
  ]);
  assert.equal(result.status, 0, result.stderr);

  const manifest = JSON.parse(await readFile(join(dir, "latest.json"), "utf8"));
  assert.equal(manifest.assets["windows-x64"].signature, "authenticode");
  assert.equal(
    manifest.assets["darwin-universal"].signature,
    "developer-id-notarized",
  );
});

test("署名種別を省略すると none になる（未署名を明示する）", async () => {
  const dir = await fixture();
  assert.equal(run(dir).status, 0);
  const manifest = JSON.parse(await readFile(join(dir, "latest.json"), "utf8"));
  assert.equal(manifest.assets["windows-x64"].signature, "none");
});

test("base-url を渡すと絶対 URL になる", async () => {
  const dir = await fixture();
  const result = run(dir, ["--base-url", "https://example.com/releases/helper-v1.2.3/"]);
  assert.equal(result.status, 0, result.stderr);

  const manifest = JSON.parse(await readFile(join(dir, "latest.json"), "utf8"));
  assert.equal(
    manifest.assets["windows-x64"].url,
    "https://example.com/releases/helper-v1.2.3/windows-x64/config-manager-helper.exe",
  );
});

test("base-url 未指定なら BFF 同梱の相対 URL になる", async () => {
  const dir = await fixture();
  assert.equal(run(dir).status, 0);
  const manifest = JSON.parse(await readFile(join(dir, "latest.json"), "utf8"));
  assert.equal(
    manifest.assets["darwin-universal"].url,
    "/downloads/helper/darwin-universal/config-manager-helper",
  );
});

test("universal が無い場合は arm64 / amd64 を個別に載せる", async () => {
  const dir = await fixture({ macUniversal: false, macSplit: true });
  assert.equal(run(dir).status, 0);
  const manifest = JSON.parse(await readFile(join(dir, "latest.json"), "utf8"));
  assert.equal(manifest.assets["darwin-universal"], undefined);
  assert.equal(manifest.assets["darwin-arm64"].sha256, sha256("mac-arm64"));
  assert.equal(manifest.assets["darwin-amd64"].sha256, sha256("mac-amd64"));
});

test("アセットが 1 つも無ければ失敗する（空の manifest を配らない）", async () => {
  const dir = await fixture({ windows: false, macUniversal: false });
  const result = run(dir);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /配布アセットが 1 つもありません/);
});

test("--dir / --version が無ければ失敗する", () => {
  const result = spawnSync("bash", [SCRIPT, "--version", "1.2.3"], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
});
