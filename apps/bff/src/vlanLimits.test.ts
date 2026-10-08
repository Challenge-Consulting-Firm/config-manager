/**
 * VLAN 抽出の入力検証・計算量のテスト。
 *
 * - 2^53 以上の VLAN ID を含むコンフィグで `v++` が値を進めず、展開ループが
 *   終わらなくなる DoS を防ぐため、VLAN ID を 1〜4094 に制限している。
 * - `1-4094` のような短い範囲指定を大量に並べた増幅型の入力に備え、展開数の
 *   総量に上限（MAX_VLAN_EXPANSION）を設けている。
 *
 * 無限ループが再発するとテストプロセス自体が止まらなくなるため、危険な入力は
 * 子プロセスで実行し、親から期限超過で強制終了する。
 */
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { extractVlans, MAX_VLAN_OUTPUT_BYTES } from "@config-manager/shared";

/** 出力 JSON の上限。見積もりは上界なので、実際の UTF-8 バイト数がこれを超えないこと。 */
const OUTPUT_CEILING = MAX_VLAN_OUTPUT_BYTES;

/** 子プロセスで extractVlans を実行し、結果の要約を返す（期限超過は失敗）。 */
function extractInChild(
  body: string,
  vendor: string,
): { vlans: number; ports: number; truncated: boolean; jsonBytes: number } {
  const script = `
    import { readFileSync } from "node:fs";
    import { extractVlans } from "@config-manager/shared";
    const { body, vendor } = JSON.parse(readFileSync(0, "utf8"));
    const r = extractVlans(body, vendor);
    process.stdout.write(JSON.stringify({
      vlans: r.vlans.length,
      ports: r.ports.length,
      truncated: r.truncated === true,
      jsonBytes: Buffer.byteLength(JSON.stringify(r), "utf8"),
    }));
  `;
  const res = spawnSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", script],
    {
      cwd: import.meta.dirname,
      // 入力は環境変数だと E2BIG になる大きさがあるため stdin で渡す。
      input: JSON.stringify({ body, vendor }),
      timeout: 10_000,
      encoding: "utf8",
    },
  );
  assert.equal(res.error, undefined, `子プロセスが期限内に終わらなかった: ${res.error}`);
  assert.equal(res.status, 0, res.stderr);
  return JSON.parse(res.stdout);
}

test("巨大な VLAN ID の範囲指定でも展開が終了し、無視される", () => {
  const body = [
    "vlan 9007199254740992-9007199254740992",
    "vlan 99999999999999999999-99999999999999999999",
    "vlan 9007199254740992",
  ].join("\n");
  const r = extractInChild(body, "Cisco");
  assert.equal(r.vlans, 0);
  assert.equal(r.truncated, false);
});

test("Buffalo の member / untagged に巨大な値があっても終了する", () => {
  const body = [
    "interface vlan10",
    " member 9007199254740992-9007199254740992",
    " untagged 9007199254740992-9007199254740992",
    "interface GigabitEthernet0/1",
    " PVID 10",
  ].join("\n");
  const r = extractInChild(body, "Buffalo");
  assert.equal(r.vlans, 1);
  assert.equal(r.ports, 1);
});

test("重複した範囲指定を大量に並べても展開数は上限で打ち切られる", () => {
  const evilList = Array.from({ length: 20_000 }, () => "1-4094").join(",");
  const trunkPorts = Array.from(
    { length: 400 },
    (_, i) =>
      `interface GigabitEthernet1/0/${i + 1}\n switchport trunk allowed vlan add ${evilList.slice(0, 2000)}`,
  ).join("\n");
  const r = extractInChild(`vlan ${evilList}\n${trunkPorts}`, "Cisco");
  // 400 ポート × 全 VLAN の所属は出力予算を超えるが、VLAN 定義とポートは残る。
  assert.equal(r.vlans, 4094);
  assert.equal(r.ports, 400);
  assert.equal(r.truncated, true);
  assert.ok(r.jsonBytes < OUTPUT_CEILING, `json ${r.jsonBytes} bytes`);

  const buffalo = Array.from(
    { length: 3000 },
    (_, i) => `interface vlan${(i % 4094) + 1}\n member 1-4094`,
  ).join("\n");
  const rb = extractInChild(buffalo, "Buffalo");
  assert.equal(rb.truncated, true);
});

test("範囲外（0・4095 以上）の VLAN ID は無視される", () => {
  const result = extractVlans("vlan 0,4095,4096-4100,5000", "Cisco");
  assert.deepEqual(result.vlans, []);
});

test("1〜4094 をまたぐ範囲（片端が範囲外）は展開しない", () => {
  const result = extractVlans("vlan 4000-5000", "Cisco");
  assert.deepEqual(result.vlans, []);
});

test("有効な VLAN ID の範囲は従来どおり展開される", () => {
  const result = extractVlans("vlan 1,200-202,4094", "Cisco");
  assert.deepEqual(
    result.vlans.map((v) => v.id),
    [1, 200, 201, 202, 4094],
  );
  assert.equal(result.truncated, undefined);
});

test("Cisco trunk の 1-4094 は全 VLAN をタグ付きとして扱う", () => {
  const body = [
    "interface GigabitEthernet1/0/1",
    " switchport mode trunk",
    " switchport trunk allowed vlan 1-4094",
    " switchport trunk native vlan 99",
  ].join("\n");
  const result = extractVlans(body, "Cisco");
  assert.equal(result.ports[0].allowedVlans.length, 4094);
  assert.equal(result.vlans.length, 4094);
  const v99 = result.vlans.find((v) => v.id === 99);
  assert.deepEqual(v99?.taggedPorts, ["GigabitEthernet1/0/1"]);
  assert.deepEqual(v99?.nativePorts, ["GigabitEthernet1/0/1"]);
});

test("Buffalo の member / untagged / PVID からポート所属を組み立てる", () => {
  const body = [
    "interface vlan10",
    ' name "users"',
    " member 1-4",
    " untagged 1-2",
    "interface vlan20",
    " member 3-4",
    "interface GigabitEthernet0/1",
    " PVID 10",
    "interface GigabitEthernet0/3",
    ' name "uplink"',
  ].join("\n");
  const result = extractVlans(body, "Buffalo");
  const v10 = result.vlans.find((v) => v.id === 10);
  assert.deepEqual(v10?.accessPorts, ["GigabitEthernet0/1", "port2"]);
  assert.deepEqual(v10?.taggedPorts, ["GigabitEthernet0/3", "port4"]);
  assert.deepEqual(v10?.nativePorts, ["GigabitEthernet0/1"]);
  const uplink = result.ports.find((p) => p.name === "GigabitEthernet0/3");
  assert.deepEqual(uplink?.allowedVlans, [10, 20]);
  assert.equal(uplink?.mode, "trunk");
});

test("部分範囲（1-4093）の反復も走査予算で打ち切られる", () => {
  const list = Array.from({ length: 100_000 }, () => "1-4093").join(",");
  const r = extractInChild(`vlan ${list}`, "Cisco");
  assert.equal(r.truncated, true);
});

test("同一 interface vlanN の反復による PVID 所属の増幅を出力予算で抑える", () => {
  const body = [
    ...Array.from({ length: 2000 }, () => "interface vlan10"),
    ...Array.from(
      { length: 2000 },
      (_, i) => `interface GigabitEthernet0/${i + 1}\n PVID 10`,
    ),
  ].join("\n");
  const r = extractInChild(body, "Buffalo");
  assert.equal(r.truncated, true);
  assert.ok(r.jsonBytes < OUTPUT_CEILING, `json ${r.jsonBytes} bytes`);
});

test("長いポート名 × 全 VLAN の複製を出力予算で抑える", () => {
  const body = Array.from(
    { length: 20 },
    (_, k) =>
      `interface Gi${k}${"9".repeat(10_000)}\n switchport trunk allowed vlan 1-4094`,
  ).join("\n");
  const r = extractInChild(body, "Cisco");
  assert.equal(r.truncated, true);
  assert.ok(r.jsonBytes < OUTPUT_CEILING, `json ${r.jsonBytes} bytes`);
});

test("空白を大量に含む一覧行で正規表現が二乗時間にならない", () => {
  const spaces = " ".repeat(200_000);
  const body = [
    `vlan ${spaces}!`,
    "interface GigabitEthernet1/0/1",
    ` switchport trunk allowed vlan add ${spaces}!`,
  ].join("\n");
  extractInChild(body, "Cisco");
  const buffalo = ["interface vlan1", `member ${spaces}!`, `untagged ${spaces}!`].join("\n");
  extractInChild(buffalo, "");
  extractInChild(buffalo, "Buffalo");
});

test("通常規模（48 ポート × 全 VLAN の trunk）は打ち切られない", () => {
  const body = Array.from(
    { length: 48 },
    (_, i) =>
      `interface GigabitEthernet1/0/${i + 1}\n switchport trunk allowed vlan 1-4094`,
  ).join("\n");
  const result = extractVlans(body, "Cisco");
  assert.equal(result.truncated, undefined);
  assert.equal(result.vlans.find((v) => v.id === 4094)?.taggedPorts.length, 48);
});

test("U+2028 を含む description / name 行で正規表現が二乗時間にならない", () => {
  const spaces = " ".repeat(200_000);
  const body = [
    "interface GigabitEthernet1/0/1",
    ` description ${spaces}x\u2028x`,
    `vlan 10 name ${spaces}x\u2028x`,
    "vlan 20",
    ` name ${spaces}x\u2029x`,
  ].join("\n");
  extractInChild(body, "Cisco");
  const buffalo = [
    "interface vlan1",
    ` name ${spaces}x\u2028x`,
    "interface GigabitEthernet0/1",
    ` name ${spaces}x\u2028x`,
    " PVID 1",
  ].join("\n");
  extractInChild(buffalo, "Buffalo");
});

test("制御文字・日本語を含む名前でも、出力の実バイト数が上限内に収まる", () => {
  const ctrl = "\u0001".repeat(10_000);
  const buffalo = [
    "interface vlan1",
    " member 1-4094",
    ...Array.from({ length: 4094 }, (_, i) => `interface vlan${i + 1}\n member 1`),
    // Buffalo は物理ポート名を \S+ で受け入れ、末尾の番号で所属を引く。
    `interface GigabitEthernet${ctrl}0/1`,
    " PVID 1",
  ].join("\n");
  const rb = extractInChild(buffalo, "Buffalo");
  assert.equal(rb.ports, 1);
  assert.equal(rb.truncated, true);
  assert.ok(rb.jsonBytes <= OUTPUT_CEILING, `json ${rb.jsonBytes} bytes`);

  // 汎用文法のポート名は数字のみなので、日本語は description で膨らませる。
  const jp = "日本語".repeat(3_000);
  const cisco = Array.from(
    { length: 1000 },
    (_, k) => `interface Gi1/0/${k}\n description ${jp}`,
  ).join("\n");
  const rc = extractInChild(cisco, "Cisco");
  assert.equal(rc.truncated, true);
  assert.ok(rc.jsonBytes <= OUTPUT_CEILING, `json ${rc.jsonBytes} bytes`);
});

test("所属のないポートの大量定義や長い description も出力予算に数える", () => {
  const manyPorts = Array.from(
    { length: 300_000 },
    (_, i) => `interface Gi1/${i}`,
  ).join("\n");
  const r = extractInChild(manyPorts, "Cisco");
  assert.equal(r.truncated, true);
  assert.ok(r.jsonBytes <= OUTPUT_CEILING, `json ${r.jsonBytes} bytes`);

  const longDesc = Array.from(
    { length: 400 },
    (_, i) => `interface Gi1/${i}\n description ${"\u0001".repeat(10_000)}`,
  ).join("\n");
  const rd = extractInChild(longDesc, "Cisco");
  assert.equal(rd.truncated, true);
  assert.ok(rd.jsonBytes <= OUTPUT_CEILING, `json ${rd.jsonBytes} bytes`);
});

test("単独サロゲートや範囲外の Buffalo VLAN ID でも、出力の実バイト数が上限内に収まる", () => {
  const lone = "\ud800".repeat(10_000);
  const cisco = Array.from(
    { length: 600 },
    (_, i) => `interface Gi1/0/${i}\n description x${lone}`,
  ).join("\n");
  const rc = extractInChild(cisco, "Cisco");
  assert.equal(rc.truncated, true);
  assert.ok(rc.jsonBytes <= OUTPUT_CEILING, `json ${rc.jsonBytes} bytes`);

  const buffalo = [
    ...Array.from(
      { length: 480 },
      () => "interface vlan9007199254740991\n member 1-4094",
    ),
    ...Array.from(
      { length: 4094 },
      (_, i) => `interface GigabitEthernet0/${i + 1}`,
    ),
  ].join("\n");
  const rb = extractInChild(buffalo, "Buffalo");
  assert.equal(rb.truncated, true);
  assert.ok(rb.jsonBytes <= OUTPUT_CEILING, `json ${rb.jsonBytes} bytes`);
});
