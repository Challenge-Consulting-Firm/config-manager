import { useEffect, useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import {
  wirelessAuthModeLabel,
  type ConfigVersion,
  type DeviceIdentifiers,
  type WirelessAccessPoint,
  type WirelessSsid,
} from "@config-manager/shared";
import { apiFetch, ApiError } from "../apiClient";
import { safeReturnPath } from "../utils/safeReturnPath";
import {
  exportWirelessApCsv,
  exportWirelessExcel,
  exportWirelessSsidCsv,
} from "../utils/wirelessExport";

type View = "ssids" | "aps";

export function WirelessPage() {
  const { id } = useParams<{ id: string }>();
  const [params] = useSearchParams();
  const returnKey = safeReturnPath(params.get("from"));

  const [version, setVersion] = useState<ConfigVersion | null>(null);
  const [ids, setIds] = useState<DeviceIdentifiers | null>(null);
  const [ssids, setSsids] = useState<WirelessSsid[]>([]);
  const [accessPoints, setAccessPoints] = useState<WirelessAccessPoint[]>([]);
  const [fromCache, setFromCache] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>("ssids");
  const [filter, setFilter] = useState("");
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    if (!id) return;
    (async () => {
      try {
        const [verRes, wRes] = await Promise.all([
          apiFetch<{ version: ConfigVersion; identifiers: DeviceIdentifiers }>(
            `/api/versions/${id}`,
          ),
          apiFetch<{
            ssids: WirelessSsid[];
            accessPoints: WirelessAccessPoint[];
            fromCache: boolean;
          }>(`/api/versions/${id}/wireless`),
        ]);
        setVersion(verRes.version);
        setIds(verRes.identifiers);
        setSsids(wRes.ssids);
        setAccessPoints(wRes.accessPoints);
        setFromCache(wRes.fromCache);
      } catch (e) {
        setError(e instanceof ApiError ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    })();
  }, [id]);

  const filteredSsids = useMemo(() => {
    const terms = filter.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return ssids;
    return ssids.filter((s) => {
      const hay =
        `${s.number} ${s.name} ${s.authMode} ${s.encryptionMode} ${s.wpaEncryptionMode} ${s.ipAssignmentMode} ${s.vlanId ?? ""} ${s.bandSelection} ${s.radiusServers} ${s.splashPage} ${s.attributes ?? ""} ${s.enabled ? "enabled 有効" : "disabled 無効"}`.toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
  }, [ssids, filter]);

  const filteredAps = useMemo(() => {
    const terms = filter.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return accessPoints;
    return accessPoints.filter((a) => {
      const hay =
        `${a.name} ${a.model} ${a.serial} ${a.mac} ${a.firmware} ${a.lanIp} ${a.publicIp}`.toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
  }, [accessPoints, filter]);

  const filenameBase = `wireless-${ids?.hostname ?? "device"}-gen${version?.generation ?? "?"}`;
  const empty = ssids.length === 0 && accessPoints.length === 0;

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <div>
          <Link to={returnKey} className="text-sm text-blue-700 hover:underline">
            ← 戻る
          </Link>
          <h1 className="mt-1 text-xl font-semibold text-slate-900">
            無線 SSID / アクセスポイント
            {ids && (
              <span className="ml-2 text-base font-normal text-slate-600">
                {ids.hostname} · 世代 #{version?.generation}
              </span>
            )}
          </h1>
          {!loading && (
            <p className="mt-1 text-sm text-slate-500">
              <span className="text-xs text-slate-400">
                {fromCache ? "キャッシュ使用" : "新規計算"} · SSID {ssids.length} 件
                / AP {accessPoints.length} 台
              </span>
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={async () => {
              setExporting(true);
              try {
                await exportWirelessExcel(
                  filteredSsids,
                  filteredAps,
                  `${filenameBase}.xlsx`,
                  { hostname: ids?.hostname, generation: version?.generation },
                );
              } finally {
                setExporting(false);
              }
            }}
            disabled={empty || exporting}
            className="rounded-md bg-emerald-600 px-3 py-2 text-sm text-white hover:bg-emerald-700 disabled:opacity-50"
          >
            {exporting ? "出力中…" : "Excel出力"}
          </button>
          <button
            onClick={() =>
              view === "ssids"
                ? exportWirelessSsidCsv(filteredSsids, `${filenameBase}-ssids.csv`)
                : exportWirelessApCsv(filteredAps, `${filenameBase}-aps.csv`)
            }
            disabled={view === "ssids" ? filteredSsids.length === 0 : filteredAps.length === 0}
            className="rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            CSV出力
          </button>
        </div>
      </div>

      <div className="mb-4 flex items-center gap-2">
        <div className="flex items-center gap-1 rounded-md border border-slate-300 bg-white p-0.5 text-sm">
          {(["ssids", "aps"] as const).map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={`rounded px-3 py-1 ${
                view === v
                  ? "bg-slate-800 text-white"
                  : "text-slate-600 hover:bg-slate-100"
              }`}
            >
              {v === "ssids" ? `SSID (${ssids.length})` : `AP (${accessPoints.length})`}
            </button>
          ))}
        </div>
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="スペース区切りAND検索（SSID名/認証/VLAN/機種/シリアル等）"
          className="flex-1 rounded-md border border-slate-300 px-3 py-2 text-sm"
        />
        <span className="text-xs text-slate-500">
          {view === "ssids" ? filteredSsids.length : filteredAps.length} 件
        </span>
      </div>

      {loading && <p className="text-slate-500">読み込み中…</p>}
      {error && <p className="text-red-600">エラー: {error}</p>}

      {!loading && !error && empty && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-6 text-sm text-amber-800">
          このコンフィグから無線 SSID / アクセスポイント情報を抽出できませんでした。
          Meraki 取り込みで作成された MR（wireless）世代か確認してください。
        </div>
      )}

      {!loading && !error && !empty && view === "ssids" && (
        <SsidTable ssids={filteredSsids} />
      )}
      {!loading && !error && !empty && view === "aps" && (
        <ApTable accessPoints={filteredAps} />
      )}
    </div>
  );
}

function SsidTable({ ssids }: { ssids: WirelessSsid[] }) {
  if (ssids.length === 0) {
    return (
      <p className="rounded-lg border border-slate-200 bg-white p-4 text-sm text-slate-500">
        条件に一致する SSID がありません。
      </p>
    );
  }
  return (
    <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
      <table className="w-full text-sm">
        <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
          <tr>
            <th className="px-3 py-2 text-right">#</th>
            <th className="px-3 py-2">SSID名</th>
            <th className="px-3 py-2">状態</th>
            <th className="px-3 py-2">認証</th>
            <th className="px-3 py-2">暗号化</th>
            <th className="px-3 py-2">IP割当</th>
            <th className="px-3 py-2">VLAN</th>
            <th className="px-3 py-2">帯域</th>
            <th className="px-3 py-2">表示</th>
            <th className="px-3 py-2">RADIUS / Splash</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {ssids.map((s) => (
            <tr key={s.number} className="hover:bg-slate-50">
              <td className="px-3 py-1.5 text-right text-xs text-slate-400">
                {s.number}
              </td>
              <td className="px-3 py-1.5 font-medium">{s.name || "(無名)"}</td>
              <td className="px-3 py-1.5">
                <StatusBadge enabled={s.enabled} />
              </td>
              <td className="px-3 py-1.5 text-xs">
                <div>{wirelessAuthModeLabel(s.authMode)}</div>
                {s.wpaEncryptionMode && (
                  <div className="mt-0.5 text-slate-400">{s.wpaEncryptionMode}</div>
                )}
              </td>
              <td className="px-3 py-1.5 mono text-xs">
                {s.encryptionMode || "—"}
              </td>
              <td className="px-3 py-1.5 text-xs">{s.ipAssignmentMode || "—"}</td>
              <td className="px-3 py-1.5 mono text-xs">
                {s.useVlanTagging ? (s.vlanId ?? "tag") : "—"}
              </td>
              <td className="px-3 py-1.5 text-xs">{s.bandSelection || "—"}</td>
              <td className="px-3 py-1.5 text-xs">
                {s.visible ? "表示" : "非表示"}
              </td>
              <td className="px-3 py-1.5 mono text-[11px] text-slate-500">
                {s.radiusServers && <div>{s.radiusServers}</div>}
                {s.splashPage && s.splashPage !== "None" && (
                  <div className="text-slate-400">splash: {s.splashPage}</div>
                )}
                {s.attributes && <div className="text-slate-400">{s.attributes}</div>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ApTable({ accessPoints }: { accessPoints: WirelessAccessPoint[] }) {
  if (accessPoints.length === 0) {
    return (
      <p className="rounded-lg border border-slate-200 bg-white p-4 text-sm text-slate-500">
        条件に一致するアクセスポイントがありません。
      </p>
    );
  }
  return (
    <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
      <table className="w-full text-sm">
        <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
          <tr>
            <th className="px-3 py-2">名前</th>
            <th className="px-3 py-2">機種</th>
            <th className="px-3 py-2">シリアル</th>
            <th className="px-3 py-2">MAC</th>
            <th className="px-3 py-2">ファーム</th>
            <th className="px-3 py-2">LAN IP</th>
            <th className="px-3 py-2">Public IP</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {accessPoints.map((a, i) => (
            <tr key={a.serial || i} className="hover:bg-slate-50">
              <td className="px-3 py-1.5 font-medium">{a.name || "(無名)"}</td>
              <td className="px-3 py-1.5 mono text-xs">{a.model || "—"}</td>
              <td className="px-3 py-1.5 mono text-xs">{a.serial || "—"}</td>
              <td className="px-3 py-1.5 mono text-xs">{a.mac || "—"}</td>
              <td className="px-3 py-1.5 mono text-xs">{a.firmware || "—"}</td>
              <td className="px-3 py-1.5 mono text-xs">{a.lanIp || "—"}</td>
              <td className="px-3 py-1.5 mono text-xs">{a.publicIp || "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function StatusBadge({ enabled }: { enabled: boolean }) {
  return enabled ? (
    <span className="rounded bg-blue-50 px-1.5 py-0.5 text-xs text-blue-700">
      有効
    </span>
  ) : (
    <span className="rounded bg-slate-200 px-1.5 py-0.5 text-xs text-slate-700">
      無効
    </span>
  );
}
