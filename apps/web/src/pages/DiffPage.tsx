import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import type {
  ConfigDiff,
  FirewallRule,
  FirewallRuleDiff,
  RoutingRoute,
  RoutingRouteDiff,
  WirelessAccessPoint,
  WirelessDiff,
  WirelessSsid,
} from "@config-manager/shared";
import { wirelessAuthModeLabel } from "@config-manager/shared";
import { apiFetch, ApiError } from "../apiClient";
import { DiffViewer } from "../components/DiffViewer";

type Tab = "config" | "firewall" | "routing" | "wireless";

export function DiffPage() {
  const [params] = useSearchParams();
  const before = params.get("before") ?? "";
  const after = params.get("after") ?? "";
  const [tab, setTab] = useState<Tab>("config");

  const [configDiff, setConfigDiff] = useState<ConfigDiff | null>(null);
  const [fwDiff, setFwDiff] = useState<FirewallRuleDiff | null>(null);
  const [routeDiff, setRouteDiff] = useState<RoutingRouteDiff | null>(null);
  const [wirelessDiff, setWirelessDiff] = useState<WirelessDiff | null>(null);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Config diff is the default and always loaded first.
  useEffect(() => {
    if (!before || !after) {
      setError("before と after の世代を指定してください");
      setLoading(false);
      return;
    }
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await apiFetch<{ diff: ConfigDiff }>(
          `/api/diff?before=${encodeURIComponent(before)}&after=${encodeURIComponent(after)}`,
        );
        setConfigDiff(res.diff);
      } catch (e) {
        setError(e instanceof ApiError ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    })();
  }, [before, after]);

  // Firewall diff is loaded lazily on tab activation to avoid the extra
  // Kintone round-trip when the user only wants a config diff.
  useEffect(() => {
    if (tab !== "firewall" || fwDiff || !before || !after) return;
    void loadFirewallDiff(before, after, setFwDiff, setError);
  }, [tab, fwDiff, before, after]);

  // Routing diff likewise.
  useEffect(() => {
    if (tab !== "routing" || routeDiff || !before || !after) return;
    void loadRoutingDiff(before, after, setRouteDiff, setError);
  }, [tab, routeDiff, before, after]);

  // Wireless (SSID / AP) diff likewise.
  useEffect(() => {
    if (tab !== "wireless" || wirelessDiff || !before || !after) return;
    void loadWirelessDiff(before, after, setWirelessDiff, setError);
  }, [tab, wirelessDiff, before, after]);

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <div>
          <Link to="/" className="text-sm text-blue-700 hover:underline">
            ← 機器一覧へ
          </Link>
          <h1 className="mt-1 text-xl font-semibold text-slate-900">コンフィグ Diff</h1>
        </div>
        {configDiff && (
          <div className="flex items-center gap-2">
            <span className="mono rounded bg-slate-100 px-2 py-1 text-xs">
              世代 {configDiff.before.generation} → {configDiff.after.generation}
            </span>
            <button
              onClick={() => downloadPatch(configDiff)}
              className="rounded border border-slate-300 px-2 py-1 text-xs hover:bg-slate-50"
            >
              パッチ(.patch)をダウンロード
            </button>
          </div>
        )}
      </div>

      <div className="mb-3 flex items-center gap-1 rounded-md border border-slate-300 bg-white p-0.5 text-sm w-fit">
        {(["config", "firewall", "routing", "wireless"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`rounded px-3 py-1 ${
              tab === t
                ? "bg-slate-800 text-white"
                : "text-slate-600 hover:bg-slate-100"
            }`}
          >
            {tabLabel(t)}
          </button>
        ))}
      </div>

      {loading && tab === "config" && (
        <p className="text-slate-500">差分を計算中…</p>
      )}
      {error && <p className="text-red-600">エラー: {error}</p>}

      {!loading && !error && tab === "config" && configDiff && (
        <DiffViewer lines={configDiff.lines} stats={configDiff.stats} />
      )}
      {!loading && !error && tab === "config" && !configDiff && (
        <p className="text-slate-500">差分がありません。</p>
      )}

      {!error && tab === "firewall" && (
        <FirewallDiffView diff={fwDiff} loading={!fwDiff} />
      )}

      {!error && tab === "routing" && (
        <RoutingDiffView diff={routeDiff} loading={!routeDiff} />
      )}

      {!error && tab === "wireless" && (
        <WirelessDiffView diff={wirelessDiff} loading={!wirelessDiff} />
      )}
    </div>
  );
}

async function loadFirewallDiff(
  before: string,
  after: string,
  set: (d: FirewallRuleDiff) => void,
  setError: (e: string | null) => void,
) {
  try {
    const res = await apiFetch<{ diff: FirewallRuleDiff }>(
      `/api/diff/firewall?before=${encodeURIComponent(before)}&after=${encodeURIComponent(after)}`,
    );
    set(res.diff);
  } catch (e) {
    setError(e instanceof ApiError ? e.message : String(e));
  }
}

async function loadRoutingDiff(
  before: string,
  after: string,
  set: (d: RoutingRouteDiff) => void,
  setError: (e: string | null) => void,
) {
  try {
    const res = await apiFetch<{ diff: RoutingRouteDiff }>(
      `/api/diff/routing?before=${encodeURIComponent(before)}&after=${encodeURIComponent(after)}`,
    );
    set(res.diff);
  } catch (e) {
    setError(e instanceof ApiError ? e.message : String(e));
  }
}

async function loadWirelessDiff(
  before: string,
  after: string,
  set: (d: WirelessDiff) => void,
  setError: (e: string | null) => void,
) {
  try {
    const res = await apiFetch<{ diff: WirelessDiff }>(
      `/api/diff/wireless?before=${encodeURIComponent(before)}&after=${encodeURIComponent(after)}`,
    );
    set(res.diff);
  } catch (e) {
    setError(e instanceof ApiError ? e.message : String(e));
  }
}

function tabLabel(t: Tab): string {
  switch (t) {
    case "config":
      return "コンフィグ";
    case "firewall":
      return "FW / ACL";
    case "routing":
      return "ルーティング";
    case "wireless":
      return "無線 SSID/AP";
  }
}

function downloadPatch(diff: ConfigDiff) {
  const blob = new Blob([diff.patch], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `config-${diff.before.generation}-to-${diff.after.generation}.patch`;
  a.click();
  URL.revokeObjectURL(url);
}

function StatsHeader({ added, removed, changed, unchanged }: {
  added: number;
  removed: number;
  changed: number;
  unchanged: number;
}) {
  return (
    <div className="mb-3 flex flex-wrap items-center gap-3 text-sm">
      <span className="rounded bg-emerald-100 px-2 py-0.5 text-emerald-700">追加 {added}</span>
      <span className="rounded bg-red-100 px-2 py-0.5 text-red-700">削除 {removed}</span>
      <span className="rounded bg-amber-100 px-2 py-0.5 text-amber-700">変更 {changed}</span>
      <span className="rounded bg-slate-100 px-2 py-0.5 text-slate-600">維持 {unchanged}</span>
    </div>
  );
}

function FirewallDiffView({ diff, loading }: { diff: FirewallRuleDiff | null; loading: boolean }) {
  if (loading) return <p className="text-slate-500">FWルールの差分を計算中…</p>;
  if (!diff) return null;
  if (diff.added.length + diff.removed.length + diff.changed.length === 0) {
    return (
      <p className="text-slate-500">
        FWルールに差分はありません（{diff.unchanged}ルールが同一）。
      </p>
    );
  }
  return (
    <div>
      <StatsHeader
        added={diff.added.length}
        removed={diff.removed.length}
        changed={diff.changed.length}
        unchanged={diff.unchanged}
      />
      {diff.removed.length > 0 && (
        <DiffSection title={`削除 (${diff.removed.length})`}>
          {diff.removed.map((r, i) => (
            <RuleRow key={`r-${i}`} rule={r} tone="removed" />
          ))}
        </DiffSection>
      )}
      {diff.added.length > 0 && (
        <DiffSection title={`追加 (${diff.added.length})`}>
          {diff.added.map((r, i) => (
            <RuleRow key={`a-${i}`} rule={r} tone="added" />
          ))}
        </DiffSection>
      )}
      {diff.changed.length > 0 && (
        <DiffSection title={`変更 (${diff.changed.length})`}>
          {diff.changed.map((c, i) => (
            <li key={`c-${i}`}>
              <RuleRow rule={c.before} tone="removed" />
              <RuleRow rule={c.after} tone="added" />
            </li>
          ))}
        </DiffSection>
      )}
    </div>
  );
}

function RoutingDiffView({ diff, loading }: { diff: RoutingRouteDiff | null; loading: boolean }) {
  if (loading) return <p className="text-slate-500">ルーティングの差分を計算中…</p>;
  if (!diff) return null;
  if (diff.added.length + diff.removed.length + diff.changed.length === 0) {
    return (
      <p className="text-slate-500">
        ルーティングに差分はありません（{diff.unchanged}エントリが同一）。
      </p>
    );
  }
  return (
    <div>
      <StatsHeader
        added={diff.added.length}
        removed={diff.removed.length}
        changed={diff.changed.length}
        unchanged={diff.unchanged}
      />
      {diff.removed.length > 0 && (
        <DiffSection title={`削除 (${diff.removed.length})`}>
          {diff.removed.map((r, i) => (
            <RouteRow key={`r-${i}`} route={r} tone="removed" />
          ))}
        </DiffSection>
      )}
      {diff.added.length > 0 && (
        <DiffSection title={`追加 (${diff.added.length})`}>
          {diff.added.map((r, i) => (
            <RouteRow key={`a-${i}`} route={r} tone="added" />
          ))}
        </DiffSection>
      )}
      {diff.changed.length > 0 && (
        <DiffSection title={`変更 (${diff.changed.length})`}>
          {diff.changed.map((c, i) => (
            <li key={`c-${i}`}>
              <RouteRow route={c.before} tone="removed" />
              <RouteRow route={c.after} tone="added" />
            </li>
          ))}
        </DiffSection>
      )}
    </div>
  );
}

function DiffSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-4">
      <h3 className="mb-2 text-sm font-semibold uppercase text-slate-500">{title}</h3>
      <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200 bg-white">
        {children}
      </ul>
    </div>
  );
}

function RuleRow({ rule, tone }: { rule: FirewallRule; tone: "added" | "removed" }) {
  const bg = tone === "added" ? "bg-emerald-50" : "bg-red-50";
  const sign = tone === "added" ? "+" : "−";
  const signColor = tone === "added" ? "text-emerald-700" : "text-red-700";
  return (
    <li className={`flex items-start gap-2 px-3 py-2 text-sm ${bg}`}>
      <span className={`mono font-bold ${signColor}`}>{sign}</span>
      <div className="flex-1">
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="mono font-medium text-slate-900">{rule.name}</span>
          {rule.displayName && (
            <span className="text-xs text-slate-600">「{rule.displayName}」</span>
          )}
          <span className="text-xs text-slate-500">{rule.action}</span>
          <span className="text-xs text-slate-500">{rule.protocol}</span>
          <span className="text-xs text-slate-400">
            ({rule.vendor} L{rule.line})
          </span>
        </div>
        <div className="mono mt-1 text-xs text-slate-700">
          {rule.source} → {rule.destination}
          {rule.port && rule.port !== "any" ? ` :${rule.port}` : ""}
        </div>
      </div>
    </li>
  );
}

function WirelessDiffView({ diff, loading }: { diff: WirelessDiff | null; loading: boolean }) {
  if (loading) return <p className="text-slate-500">無線 SSID/AP の差分を計算中…</p>;
  if (!diff) return null;
  const ssidChanges =
    diff.ssids.added.length + diff.ssids.removed.length + diff.ssids.changed.length;
  const apChanges =
    diff.accessPoints.added.length +
    diff.accessPoints.removed.length +
    diff.accessPoints.changed.length;
  if (ssidChanges + apChanges === 0) {
    return (
      <p className="text-slate-500">
        無線 SSID/AP に差分はありません（SSID {diff.ssids.unchanged} 件 / AP{" "}
        {diff.accessPoints.unchanged} 台が同一）。
      </p>
    );
  }
  return (
    <div>
      <h2 className="mb-2 text-sm font-semibold text-slate-700">SSID</h2>
      <StatsHeader
        added={diff.ssids.added.length}
        removed={diff.ssids.removed.length}
        changed={diff.ssids.changed.length}
        unchanged={diff.ssids.unchanged}
      />
      {diff.ssids.removed.length > 0 && (
        <DiffSection title={`削除 (${diff.ssids.removed.length})`}>
          {diff.ssids.removed.map((s, i) => (
            <SsidRow key={`sr-${i}`} ssid={s} tone="removed" />
          ))}
        </DiffSection>
      )}
      {diff.ssids.added.length > 0 && (
        <DiffSection title={`追加 (${diff.ssids.added.length})`}>
          {diff.ssids.added.map((s, i) => (
            <SsidRow key={`sa-${i}`} ssid={s} tone="added" />
          ))}
        </DiffSection>
      )}
      {diff.ssids.changed.length > 0 && (
        <DiffSection title={`変更 (${diff.ssids.changed.length})`}>
          {diff.ssids.changed.map((c, i) => (
            <li key={`sc-${i}`}>
              <SsidRow ssid={c.before} tone="removed" />
              <SsidRow ssid={c.after} tone="added" />
            </li>
          ))}
        </DiffSection>
      )}

      <h2 className="mb-2 mt-6 text-sm font-semibold text-slate-700">
        アクセスポイント
      </h2>
      <StatsHeader
        added={diff.accessPoints.added.length}
        removed={diff.accessPoints.removed.length}
        changed={diff.accessPoints.changed.length}
        unchanged={diff.accessPoints.unchanged}
      />
      {diff.accessPoints.removed.length > 0 && (
        <DiffSection title={`削除 (${diff.accessPoints.removed.length})`}>
          {diff.accessPoints.removed.map((a, i) => (
            <ApRow key={`ar-${i}`} ap={a} tone="removed" />
          ))}
        </DiffSection>
      )}
      {diff.accessPoints.added.length > 0 && (
        <DiffSection title={`追加 (${diff.accessPoints.added.length})`}>
          {diff.accessPoints.added.map((a, i) => (
            <ApRow key={`aa-${i}`} ap={a} tone="added" />
          ))}
        </DiffSection>
      )}
      {diff.accessPoints.changed.length > 0 && (
        <DiffSection title={`変更 (${diff.accessPoints.changed.length})`}>
          {diff.accessPoints.changed.map((c, i) => (
            <li key={`ac-${i}`}>
              <ApRow ap={c.before} tone="removed" />
              <ApRow ap={c.after} tone="added" />
            </li>
          ))}
        </DiffSection>
      )}
    </div>
  );
}

function SsidRow({ ssid, tone }: { ssid: WirelessSsid; tone: "added" | "removed" }) {
  const bg = tone === "added" ? "bg-emerald-50" : "bg-red-50";
  const sign = tone === "added" ? "+" : "−";
  const signColor = tone === "added" ? "text-emerald-700" : "text-red-700";
  return (
    <li className={`flex items-start gap-2 px-3 py-2 text-sm ${bg}`}>
      <span className={`mono font-bold ${signColor}`}>{sign}</span>
      <div className="flex-1">
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="mono text-xs text-slate-400">#{ssid.number}</span>
          <span className="font-medium text-slate-900">{ssid.name || "(無名)"}</span>
          <span className="text-xs text-slate-500">
            {ssid.enabled ? "有効" : "無効"}
          </span>
          <span className="text-xs text-slate-500">
            {wirelessAuthModeLabel(ssid.authMode)}
          </span>
        </div>
        <div className="mono mt-1 text-xs text-slate-700">
          {ssid.ipAssignmentMode || "—"}
          {ssid.useVlanTagging ? ` · VLAN ${ssid.vlanId ?? "tag"}` : ""}
          {ssid.bandSelection ? ` · ${ssid.bandSelection}` : ""}
        </div>
      </div>
    </li>
  );
}

function ApRow({ ap, tone }: { ap: WirelessAccessPoint; tone: "added" | "removed" }) {
  const bg = tone === "added" ? "bg-emerald-50" : "bg-red-50";
  const sign = tone === "added" ? "+" : "−";
  const signColor = tone === "added" ? "text-emerald-700" : "text-red-700";
  return (
    <li className={`flex items-start gap-2 px-3 py-2 text-sm ${bg}`}>
      <span className={`mono font-bold ${signColor}`}>{sign}</span>
      <div className="flex-1">
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="font-medium text-slate-900">{ap.name || "(無名)"}</span>
          <span className="mono text-xs text-slate-600">{ap.model}</span>
          <span className="mono text-xs text-slate-400">{ap.serial}</span>
        </div>
        <div className="mono mt-1 text-xs text-slate-700">
          {ap.firmware && `fw ${ap.firmware}`}
          {ap.lanIp ? ` · LAN ${ap.lanIp}` : ""}
          {ap.publicIp ? ` · Public ${ap.publicIp}` : ""}
        </div>
      </div>
    </li>
  );
}

function RouteRow({ route, tone }: { route: RoutingRoute; tone: "added" | "removed" }) {
  const bg = tone === "added" ? "bg-emerald-50" : "bg-red-50";
  const sign = tone === "added" ? "+" : "−";
  const signColor = tone === "added" ? "text-emerald-700" : "text-red-700";
  return (
    <li className={`flex items-start gap-2 px-3 py-2 text-sm ${bg}`}>
      <span className={`mono font-bold ${signColor}`}>{sign}</span>
      <div className="flex-1">
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="mono font-medium text-slate-900">{route.protocol}</span>
          <span className="mono text-slate-900">{route.network}</span>
          <span className="text-xs text-slate-500">via</span>
          <span className="mono text-slate-900">{route.nextHop}</span>
          {route.interface && (
            <span className="text-xs text-slate-600">@{route.interface}</span>
          )}
          <span className="text-xs text-slate-400">({route.vendor})</span>
        </div>
      </div>
    </li>
  );
}
