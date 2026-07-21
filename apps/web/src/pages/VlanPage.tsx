import { useEffect, useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import type {
  ConfigVersion,
  DeviceIdentifiers,
  VlanDefinition,
  VlanPort,
} from "@config-manager/shared";
import { apiFetch, ApiError } from "../apiClient";

type View = "vlans" | "ports" | "matrix";

/** Membership of a port in a VLAN, for the matrix cell. */
type Membership = "access" | "native" | "tagged" | null;

export function VlanPage() {
  const { id } = useParams<{ id: string }>();
  const [params] = useSearchParams();
  const returnKey = params.get("from") || "/";

  const [version, setVersion] = useState<ConfigVersion | null>(null);
  const [ids, setIds] = useState<DeviceIdentifiers | null>(null);
  const [vlans, setVlans] = useState<VlanDefinition[]>([]);
  const [ports, setPorts] = useState<VlanPort[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>("vlans");
  const [filter, setFilter] = useState("");

  useEffect(() => {
    if (!id) return;
    (async () => {
      try {
        const [verRes, vlanRes] = await Promise.all([
          apiFetch<{ version: ConfigVersion; identifiers: DeviceIdentifiers }>(
            `/api/versions/${id}`,
          ),
          apiFetch<{ vlans: VlanDefinition[]; ports: VlanPort[] }>(
            `/api/versions/${id}/vlan`,
          ),
        ]);
        setVersion(verRes.version);
        setIds(verRes.identifiers);
        setVlans(vlanRes.vlans);
        setPorts(vlanRes.ports);
      } catch (e) {
        setError(e instanceof ApiError ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    })();
  }, [id]);

  const detection = version?.detected;
  const filenameBase = `vlan-${ids?.hostname ?? "device"}-gen${version?.generation ?? "?"}`;

  const filteredVlans = useMemo(() => {
    const terms = filter.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return vlans;
    return vlans.filter((v) => {
      const hay =
        `${v.id} ${v.name} ${v.accessPorts.join(" ")} ${v.taggedPorts.join(" ")} ${v.nativePorts.join(" ")}`.toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
  }, [vlans, filter]);

  const filteredPorts = useMemo(() => {
    const terms = filter.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return ports;
    return ports.filter((p) => {
      const hay =
        `${p.name} ${p.mode} ${p.accessVlan ?? ""} ${p.nativeVlan ?? ""} ${p.allowedVlans.join(" ")} ${p.description}`.toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
  }, [ports, filter]);

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <div>
          <Link to={returnKey} className="text-sm text-blue-700 hover:underline">
            ← 戻る
          </Link>
          <h1 className="mt-1 text-xl font-semibold text-slate-900">
            VLAN構成
            {ids && (
              <span className="ml-2 text-base font-normal text-slate-600">
                {ids.hostname} · 世代 #{version?.generation}
              </span>
            )}
          </h1>
          {detection && (detection.vendor || detection.os) && (
            <p className="mt-1 text-sm text-slate-500">
              自動識別: {detection.vendor} / {detection.os}
              {detection.osVersion && ` v${detection.osVersion}`}
              {!loading && (
                <span className="ml-2 text-xs text-slate-400">
                  (VLAN {vlans.length}件 · ポート {ports.length}件)
                </span>
              )}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => exportVlanCsv(vlans, `${filenameBase}.csv`)}
            disabled={vlans.length === 0}
            className="rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            CSV出力
          </button>
        </div>
      </div>

      <div className="mb-4 flex items-center gap-2">
        <div className="flex items-center gap-1 rounded-md border border-slate-300 bg-white p-0.5 text-sm">
          {(["vlans", "ports", "matrix"] as const).map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={`rounded px-3 py-1 ${
                view === v
                  ? "bg-slate-800 text-white"
                  : "text-slate-600 hover:bg-slate-100"
              }`}
            >
              {v === "vlans" ? "VLAN一覧" : v === "ports" ? "ポート一覧" : "マトリクス"}
            </button>
          ))}
        </div>
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="スペース区切りAND検索（VLAN ID/名前/ポート/説明）"
          className="flex-1 rounded-md border border-slate-300 px-3 py-2 text-sm"
        />
      </div>

      {loading && <p className="text-slate-500">読み込み中…</p>}
      {error && <p className="text-red-600">エラー: {error}</p>}

      {!loading && !error && vlans.length === 0 && ports.length === 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-6 text-sm text-amber-800">
          このコンフィグからVLAN構成を抽出できませんでした。VLAN定義（vlan
          ...）またはスイッチポート設定（switchport ...）を含むスイッチのコンフィグか確認してください。
        </div>
      )}

      {!loading && !error && view === "vlans" && vlans.length > 0 && (
        <VlanTable vlans={filteredVlans} />
      )}
      {!loading && !error && view === "ports" && ports.length > 0 && (
        <PortTable ports={filteredPorts} />
      )}
      {!loading && !error && view === "matrix" && (
        <MatrixView vlans={filteredVlans} ports={ports} />
      )}
    </div>
  );
}

function VlanTable({ vlans }: { vlans: VlanDefinition[] }) {
  return (
    <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
      <table className="w-full text-sm">
        <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
          <tr>
            <th className="px-3 py-2 text-right">VLAN ID</th>
            <th className="px-3 py-2">名前</th>
            <th className="px-3 py-2">アクセスポート</th>
            <th className="px-3 py-2">タグ付きポート（trunk）</th>
            <th className="px-3 py-2">ネイティブポート</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {vlans.map((v) => (
            <tr key={v.id} className="hover:bg-slate-50">
              <td className="px-3 py-1.5 text-right mono font-medium">{v.id}</td>
              <td className="px-3 py-1.5">{v.name || "—"}</td>
              <td className="px-3 py-1.5 mono text-xs">
                {v.accessPorts.join(", ") || "—"}
              </td>
              <td className="px-3 py-1.5 mono text-xs">
                {v.taggedPorts.join(", ") || "—"}
              </td>
              <td className="px-3 py-1.5 mono text-xs">
                {v.nativePorts.join(", ") || "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function modeBadge(mode: string): string {
  if (mode === "trunk") return "bg-purple-100 text-purple-700";
  if (mode === "access") return "bg-blue-100 text-blue-700";
  return "bg-slate-100 text-slate-500";
}

function PortTable({ ports }: { ports: VlanPort[] }) {
  return (
    <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
      <table className="w-full text-sm">
        <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
          <tr>
            <th className="px-3 py-2">ポート</th>
            <th className="px-3 py-2">モード</th>
            <th className="px-3 py-2 text-right">アクセスVLAN</th>
            <th className="px-3 py-2 text-right">ネイティブVLAN</th>
            <th className="px-3 py-2">許可VLAN（tagged）</th>
            <th className="px-3 py-2">説明</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {ports.map((p) => (
            <tr key={p.name} className="hover:bg-slate-50">
              <td className="px-3 py-1.5 mono font-medium">{p.name}</td>
              <td className="px-3 py-1.5">
                <span className={`rounded px-1.5 py-0.5 text-xs ${modeBadge(p.mode)}`}>
                  {p.mode || "—"}
                </span>
              </td>
              <td className="px-3 py-1.5 text-right mono text-xs">
                {p.accessVlan ?? "—"}
              </td>
              <td className="px-3 py-1.5 text-right mono text-xs">
                {p.nativeVlan ?? "—"}
              </td>
              <td className="px-3 py-1.5 mono text-xs">
                {p.allowedVlans.length ? p.allowedVlans.join(", ") : "—"}
              </td>
              <td className="px-3 py-1.5 text-xs text-slate-500">
                {p.description || ""}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function membership(port: VlanPort, vlanId: number): Membership {
  if (port.accessVlan === vlanId) return "access";
  if (port.nativeVlan === vlanId) return "native";
  if (port.allowedVlans.includes(vlanId)) return "tagged";
  return null;
}

const CELL_LABEL: Record<Exclude<Membership, null>, string> = {
  access: "A",
  native: "N",
  tagged: "T",
};
const CELL_STYLE: Record<Exclude<Membership, null>, string> = {
  access: "bg-blue-100 text-blue-700",
  native: "bg-amber-100 text-amber-700",
  tagged: "bg-purple-100 text-purple-700",
};

function MatrixView({
  vlans,
  ports,
}: {
  vlans: VlanDefinition[];
  ports: VlanPort[];
}) {
  if (vlans.length === 0 || ports.length === 0) {
    return (
      <p className="text-sm text-amber-700">
        マトリクス表示にはVLAN定義とポートの両方が必要です。
      </p>
    );
  }
  return (
    <div>
      <div className="mb-2 flex flex-wrap gap-3 text-xs text-slate-500">
        <span>
          <span className="rounded bg-blue-100 px-1.5 py-0.5 text-blue-700">A</span> アクセス
        </span>
        <span>
          <span className="rounded bg-amber-100 px-1.5 py-0.5 text-amber-700">N</span> ネイティブ（trunk untagged）
        </span>
        <span>
          <span className="rounded bg-purple-100 px-1.5 py-0.5 text-purple-700">T</span> タグ付き（trunk allowed）
        </span>
      </div>
      <div className="overflow-auto rounded-lg border border-slate-200 bg-white">
        <table className="border-collapse text-xs">
          <thead>
            <tr>
              <th className="sticky left-0 z-10 bg-slate-100 px-2 py-1.5 text-left">
                ポート ＼ VLAN
              </th>
              {vlans.map((v) => (
                <th key={v.id} className="px-2 py-1.5 text-center mono" title={v.name}>
                  {v.id}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {ports.map((p) => (
              <tr key={p.name}>
                <td className="sticky left-0 bg-white px-2 py-1 mono font-medium">
                  {p.name}
                </td>
                {vlans.map((v) => {
                  const m = membership(p, v.id);
                  return (
                    <td
                      key={v.id}
                      className="border-l border-slate-100 px-2 py-1 text-center"
                    >
                      {m ? (
                        <span className={`rounded px-1.5 py-0.5 ${CELL_STYLE[m]}`}>
                          {CELL_LABEL[m]}
                        </span>
                      ) : (
                        <span className="text-slate-200">·</span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Export the VLAN list to CSV (VLAN definitions with their port membership). */
function exportVlanCsv(vlans: VlanDefinition[], filename: string): void {
  const cols = [
    "VLAN ID",
    "Name",
    "Access Ports",
    "Tagged Ports",
    "Native Ports",
  ];
  const esc = (v: unknown) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [cols.join(",")];
  for (const v of vlans) {
    lines.push(
      [
        v.id,
        v.name,
        v.accessPorts.join(" "),
        v.taggedPorts.join(" "),
        v.nativePorts.join(" "),
      ]
        .map(esc)
        .join(","),
    );
  }
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
