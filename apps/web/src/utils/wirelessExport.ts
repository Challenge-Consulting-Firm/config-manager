import {
  wirelessAuthModeLabel,
  type WirelessAccessPoint,
  type WirelessSsid,
} from "@config-manager/shared";

/** Export the wireless snapshot to an .xlsx workbook with two sheets:
 *  - "SSIDs": the SSID configuration list
 *  - "Access Points": the AP inventory
 *
 *  The `xlsx` library is loaded lazily so it does not bloat the initial bundle.
 */
export async function exportWirelessExcel(
  ssids: WirelessSsid[],
  accessPoints: WirelessAccessPoint[],
  filename: string,
  meta?: { hostname?: string; generation?: number },
): Promise<void> {
  const XLSX = await import("xlsx");
  const wb = XLSX.utils.book_new();

  const wsSsids = XLSX.utils.json_to_sheet(ssids.map(ssidToRow));
  wsSsids["!cols"] = ssidColumns();
  XLSX.utils.book_append_sheet(wb, wsSsids, "SSIDs");

  const wsAps = XLSX.utils.json_to_sheet(accessPoints.map(apToRow));
  wsAps["!cols"] = apColumns();
  XLSX.utils.book_append_sheet(wb, wsAps, "Access Points");

  void meta;
  XLSX.writeFile(wb, filename);
}

/** Export the SSID list as plain CSV. */
export function exportWirelessSsidCsv(
  ssids: WirelessSsid[],
  filename: string,
): void {
  const cols = [
    "#",
    "SSID Name",
    "Status",
    "Auth Mode",
    "Encryption",
    "WPA Mode",
    "IP Assignment",
    "VLAN",
    "Band",
    "BW Down(Kbps)",
    "BW Up(Kbps)",
    "Visible",
    "RADIUS",
    "Splash",
    "Attributes",
  ];
  const rows = ssids.map((s) => [
    s.number,
    s.name,
    s.enabled ? "enabled" : "disabled",
    wirelessAuthModeLabel(s.authMode),
    s.encryptionMode,
    s.wpaEncryptionMode,
    s.ipAssignmentMode,
    s.useVlanTagging ? (s.vlanId ?? "") : "",
    s.bandSelection,
    s.perClientBandwidthLimitDown ?? "",
    s.perClientBandwidthLimitUp ?? "",
    s.visible ? "yes" : "no",
    s.radiusServers,
    s.splashPage,
    s.attributes ?? "",
  ]);
  downloadCsv(cols, rows, filename);
}

/** Export the AP inventory as plain CSV. */
export function exportWirelessApCsv(
  accessPoints: WirelessAccessPoint[],
  filename: string,
): void {
  const cols = ["#", "Name", "Model", "Serial", "MAC", "Firmware", "LAN IP", "Public IP"];
  const rows = accessPoints.map((a, i) => [
    i + 1,
    a.name,
    a.model,
    a.serial,
    a.mac,
    a.firmware,
    a.lanIp,
    a.publicIp,
  ]);
  downloadCsv(cols, rows, filename);
}

function downloadCsv(
  cols: string[],
  rows: (string | number)[][],
  filename: string,
): void {
  const esc = (v: unknown) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [cols.join(",")];
  for (const row of rows) lines.push(row.map(esc).join(","));
  const blob = new Blob(["﻿" + lines.join("\n")], {
    type: "text/csv;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function ssidToRow(s: WirelessSsid) {
  return {
    "#": s.number,
    "SSID Name": s.name,
    Status: s.enabled ? "enabled" : "disabled",
    "Auth Mode": wirelessAuthModeLabel(s.authMode),
    Encryption: s.encryptionMode,
    "WPA Mode": s.wpaEncryptionMode,
    "IP Assignment": s.ipAssignmentMode,
    VLAN: s.useVlanTagging ? (s.vlanId ?? "") : "",
    Band: s.bandSelection,
    "BW Down(Kbps)": s.perClientBandwidthLimitDown ?? "",
    "BW Up(Kbps)": s.perClientBandwidthLimitUp ?? "",
    Visible: s.visible ? "yes" : "no",
    RADIUS: s.radiusServers,
    Splash: s.splashPage,
    Attributes: s.attributes ?? "",
  };
}

function apToRow(a: WirelessAccessPoint, i: number) {
  return {
    "#": i + 1,
    Name: a.name,
    Model: a.model,
    Serial: a.serial,
    MAC: a.mac,
    Firmware: a.firmware,
    "LAN IP": a.lanIp,
    "Public IP": a.publicIp,
  };
}

function ssidColumns() {
  return [
    { wch: 4 },
    { wch: 24 },
    { wch: 10 },
    { wch: 16 },
    { wch: 12 },
    { wch: 20 },
    { wch: 18 },
    { wch: 6 },
    { wch: 20 },
    { wch: 14 },
    { wch: 14 },
    { wch: 8 },
    { wch: 24 },
    { wch: 24 },
    { wch: 28 },
  ];
}

function apColumns() {
  return [
    { wch: 4 },
    { wch: 20 },
    { wch: 10 },
    { wch: 16 },
    { wch: 18 },
    { wch: 14 },
    { wch: 16 },
    { wch: 16 },
  ];
}
