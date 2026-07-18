import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import type { MerakiCredential, MerakiProductType, Role } from "@config-manager/shared";
import { apiFetch, ApiError } from "../apiClient";

/** BFF の GET /api/meraki/credentials 応答。apiKey はマスク済み。 */
interface CredentialListResponse {
  enabled: boolean;
  credentials: MerakiCredential[];
  error?: string;
}

/** BFF の /api/meraki/import レスポンス。 */
interface MerakiImportResult {
  created?: {
    id: string;
    generation: number;
    hash: string;
    detected?: {
      vendor: string;
      os: string;
      osVersion: string;
      model: string;
      confidence: number;
    };
  };
  skipped?: boolean;
  reason?: string;
  strippedLines?: number;
  summary?: {
    deviceCount: number;
    sectionsByProduct: Record<MerakiProductType, number>;
    /** 機器仕様上スキップ (400) されたエンドポイント。エラーではない。 */
    skippedSections: number;
    skipped: { label: string; error: string }[];
    /** 実エラー (401/403/429/500 等) のエンドポイント。 */
    failedSections: number;
    failures: { label: string; error: string }[];
  };
  network?: {
    id: string;
    name: string;
    productTypes: MerakiProductType[];
  };
}

const PRODUCT_LABELS: Record<MerakiProductType, string> = {
  appliance: "MX (Security Appliance)",
  switch: "MS (Switch)",
  wireless: "MR (Wireless)",
};

export function MerakiImportPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const returnKey = params.get("from") || "/";

  // クレデンシャル選択状態。URL パラメータ `credentialId` で事前選択可能
  // （Meraki 接続情報ページの「取得で使用」ボタンから遷移してくる）。
  const presetCredentialId = params.get("credentialId") ?? "";

  const [enabled, setEnabled] = useState(true);
  const [credentials, setCredentials] = useState<MerakiCredential[]>([]);
  const [credentialId, setCredentialId] = useState(presetCredentialId);

  // 手動入力欄（credentialId 未選択時、または上書き用）
  const [networkId, setNetworkId] = useState(
    params.get("networkId") ?? "",
  );
  const [apiKey, setApiKey] = useState("");

  // 識別子（クレデンシャル選択時にデフォルト値で補完）
  const [customer, setCustomer] = useState(params.get("customer") ?? "");
  const [hostname, setHostname] = useState(params.get("hostname") ?? "");
  const [ipAddress, setIpAddress] = useState(params.get("ipAddress") ?? "");
  const [purpose, setPurpose] = useState(params.get("purpose") ?? "");
  const [serialNumber, setSerialNumber] = useState(
    params.get("serialNumber") ?? "",
  );
  const [role, setRole] = useState<Role>(
    params.get("role") === "spare" ? "spare" : "production",
  );
  const [note, setNote] = useState("");

  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<MerakiImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  // クレデンシャル一覧を取得。
  useEffect(() => {
    (async () => {
      try {
        const res = await apiFetch<CredentialListResponse>(
          "/api/meraki/credentials",
        );
        setEnabled(res.enabled);
        setCredentials(res.credentials);
      } catch (e) {
        // クレデンシャル機能が未設定でも継続（手動入力のみで使えるように）。
        setEnabled(false);
        console.warn("meraki credentials load failed", e);
      }
    })();
  }, []);

  // クレデンシャル選択時、customer/hostname が未入力ならデフォルト値で補完。
  // networkId/apiKey は BFF 側で credentialId から解決するため、UI 上では
  // 読み取り専用で表示するだけで送信不要。ただし「別のネットワークを手動指定」
  // したいケースに備え、networkId 入力欄は選択を外せば使えるように残す。
  const selected = credentials.find((c) => c.id === credentialId);
  useEffect(() => {
    if (selected) {
      if (!customer && selected.defaultCustomer)
        setCustomer(selected.defaultCustomer);
      if (!hostname && selected.defaultHostname)
        setHostname(selected.defaultHostname);
    }
  }, [selected, customer, hostname]);

  async function submit() {
    setError(null);
    setResult(null);
    if (credentialId) {
      // クレデンシャル選択時は networkId/apiKey は BFF 側で解決。
      if (!customer.trim() || !hostname.trim()) {
        setError("顧客・ホスト名は必須です");
        return;
      }
    } else {
      if (!networkId.trim()) {
        setError("ネットワーク ID または接続情報の選択が必要です");
        return;
      }
      if (!customer.trim() || !hostname.trim()) {
        setError("顧客・ホスト名は必須です");
        return;
      }
    }
    setSubmitting(true);
    try {
      const body: Record<string, string> = {
        customer: customer.trim(),
        hostname: hostname.trim(),
        role,
      };
      if (credentialId) {
        body.credentialId = credentialId;
      } else {
        body.networkId = networkId.trim();
        if (apiKey.trim()) body.apiKey = apiKey.trim();
      }
      if (ipAddress.trim()) body.ipAddress = ipAddress.trim();
      if (purpose.trim()) body.purpose = purpose.trim();
      if (serialNumber.trim()) body.serialNumber = serialNumber.trim();
      if (note.trim()) body.note = note.trim();

      const res = await apiFetch<MerakiImportResult>("/api/meraki/import", {
        method: "POST",
        body: JSON.stringify(body),
      });
      setResult(res);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-2">
        <button
          onClick={() => navigate(returnKey)}
          className="text-sm text-blue-700 hover:underline"
        >
          ← 戻る
        </button>
      </div>
      <h1 className="mb-2 text-xl font-semibold text-slate-900">
        Meraki 設定の取得（MR/MX/MS）
      </h1>
      <p className="mb-4 text-sm text-slate-600">
        ネットワーク ID と API キーを入力するか、登録済みの接続情報を選択して
        ください。Meraki Dashboard API から設定を取得して新規世代として保存します。
        保存後は手動アップロードと同じく Diff・FW/ルーティング抽出・履歴管理が
        利用できます。
      </p>

      <div className="mb-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
        <span className="font-semibold">取り扱い:</span>{" "}
        API キーは BFF 経由で Meraki API 呼び出しにのみ使用し、Kintone
        やログへは保存されません。接続情報として登録する場合は、Kintone
        上に平文で保存されます（
        <a
          href="/meraki/credentials"
          className="underline"
        >
          接続情報ページ
        </a>
        の注記を参照）。
      </div>

      {/* クレデンシャル選択 */}
      {enabled && credentials.length > 0 && (
        <div className="mb-4 rounded-md border border-slate-200 bg-white p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-medium uppercase text-slate-500">
              登録済み接続情報から選択（任意）
            </span>
            <a
              href="/meraki/credentials"
              className="text-xs text-blue-700 hover:underline"
            >
              接続情報の管理 →
            </a>
          </div>
          <select
            value={credentialId}
            onChange={(e) => setCredentialId(e.target.value)}
            className={inputCls}
          >
            <option value="">（選択しない — 手動入力）</option>
            {credentials.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label} — {c.networkId}
                {c.defaultCustomer ? ` (${c.defaultCustomer})` : ""}
              </option>
            ))}
          </select>
          {selected && (
            <div className="mt-2 rounded bg-slate-50 px-2 py-1.5 text-xs text-slate-600">
              選択中:{" "}
              <span className="font-semibold">{selected.label}</span>{" "}
              <span className="mono">{selected.networkId}</span>
              {selected.defaultCustomer &&
                ` · 顧客=${selected.defaultCustomer}`}
              {selected.defaultHostname &&
                ` · ホスト=${selected.defaultHostname}`}
            </div>
          )}
        </div>
      )}

      {/* 手動入力（クレデンシャル未選択時のみ有効） */}
      {!credentialId && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="ネットワーク ID *">
            <input
              value={networkId}
              onChange={(e) => setNetworkId(e.target.value)}
              placeholder="L_646829496481105433"
              className={inputCls}
            />
          </Field>
          <Field label="Meraki API キー（省略可）">
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="環境変数未設定時は必須"
              autoComplete="off"
              className={inputCls}
            />
          </Field>
        </div>
      )}

      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="顧客 *">
          <input
            value={customer}
            onChange={(e) => setCustomer(e.target.value)}
            className={inputCls}
          />
        </Field>
        <Field label="ホスト名 *">
          <input
            value={hostname}
            onChange={(e) => setHostname(e.target.value)}
            placeholder="例: Tokyo-Office-MX"
            className={inputCls}
          />
        </Field>
        <Field label="IPアドレス（省略可）">
          <input
            value={ipAddress}
            onChange={(e) => setIpAddress(e.target.value)}
            placeholder="未入力時はデバイスの lanIp (プライベート IP) で補完"
            className={inputCls}
          />
        </Field>
        <Field label="シリアル番号（省略可）">
          <input
            value={serialNumber}
            onChange={(e) => setSerialNumber(e.target.value)}
            placeholder="Q2XX-XXXX-XXXX"
            className={inputCls}
          />
        </Field>
        <Field label="用途（省略可）">
          <input
            value={purpose}
            onChange={(e) => setPurpose(e.target.value)}
            placeholder="未入力時はネットワーク名を自動設定"
            className={inputCls}
          />
        </Field>
        <Field label="メモ（省略可）">
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            className={inputCls}
          />
        </Field>
      </div>

      <div className="mt-4 flex items-center gap-6">
        <span className="text-xs font-medium uppercase text-slate-500">
          稼働区分 *
        </span>
        <label className="flex items-center gap-1.5 text-sm">
          <input
            type="radio"
            name="role"
            checked={role === "production"}
            onChange={() => setRole("production")}
          />
          本番（稼働中）
        </label>
        <label className="flex items-center gap-1.5 text-sm">
          <input
            type="radio"
            name="role"
            checked={role === "spare"}
            onChange={() => setRole("spare")}
          />
          予備（故障時代替機）
        </label>
      </div>

      <div className="mt-4 flex items-center justify-between">
        <p className="text-xs text-slate-500">
          取得対象は network.productTypes から自動判定します（MR/MX/MS のみ）。
        </p>
        <div className="flex gap-2">
          <button
            onClick={() => navigate(returnKey)}
            className="rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50"
          >
            キャンセル
          </button>
          <button
            onClick={submit}
            disabled={submitting}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {submitting ? "取得中…" : "取得して保存"}
          </button>
        </div>
      </div>

      {error && <p className="mt-4 text-red-600">エラー: {error}</p>}

      {result && (
        <div className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800">
          {result.skipped ? (
            <>
              変更なし — 最新世代と同一のコンフィグです。新世代は作成されませんでした。
              {result.reason ? `（${result.reason}）` : ""}
            </>
          ) : (
            <>
              世代 #{result.created?.generation} を登録しました（
              {result.strippedLines ?? 0} 行のコメント/空白行を除去）。
              {result.created?.detected &&
                (result.created.detected.vendor ||
                  result.created.detected.os) && (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <span className="font-semibold uppercase text-xs">
                      自動検出:
                    </span>
                    <Detected>{result.created.detected.vendor}</Detected>
                    <Detected>{result.created.detected.os}</Detected>
                  </div>
                )}
              <button
                onClick={() => navigate(returnKey)}
                className="ml-2 underline"
              >
                {params.get("hostname") ? "機器詳細へ戻る" : "機器一覧へ戻る"}
              </button>
            </>
          )}

          {result.network && (
            <div className="mt-3 rounded bg-white/70 p-2 text-xs">
              <div>
                <span className="font-semibold">ネットワーク:</span>{" "}
                {result.network.name} ({result.network.id})
              </div>
              <div className="mt-1 flex flex-wrap gap-1">
                {result.network.productTypes.map((pt) => (
                  <span
                    key={pt}
                    className="rounded bg-blue-100 px-1.5 py-0.5 text-blue-800"
                  >
                    {PRODUCT_LABELS[pt]}
                  </span>
                ))}
              </div>
            </div>
          )}

          {result.summary && (
            <div className="mt-2 rounded bg-white/70 p-2 text-xs">
              <div>
                <span className="font-semibold">デバイス数:</span>{" "}
                {result.summary.deviceCount}
              </div>
              <div className="mt-1">
                <span className="font-semibold">取得セクション:</span>{" "}
                {(["appliance", "switch", "wireless"] as MerakiProductType[])
                  .filter(
                    (pt) => (result.summary!.sectionsByProduct[pt] ?? 0) > 0,
                  )
                  .map(
                    (pt) =>
                      `${PRODUCT_LABELS[pt].split(" ")[0]}: ${
                        result.summary!.sectionsByProduct[pt]
                      }`,
                  )
                  .join(" / ")}
              </div>

              {/* 機器仕様上のスキップ (情報扱い) */}
              {result.summary.skippedSections > 0 && (
                <div className="mt-2">
                  <div className="text-slate-600">
                    <span className="font-semibold">対象外セクション:</span>{" "}
                    {result.summary.skippedSections} 件
                    <span className="ml-1 text-slate-400">
                      （このネットワークで使われていない機能。正常な動作です）
                    </span>
                  </div>
                  <details className="mt-1">
                    <summary className="cursor-pointer text-slate-500">
                      対象外の詳細
                    </summary>
                    <ul className="mt-1 list-inside list-disc text-slate-500">
                      {result.summary.skipped.map((f, i) => (
                        <li key={i}>
                          <span className="font-mono">{f.label}</span>: {f.error}
                        </li>
                      ))}
                    </ul>
                  </details>
                </div>
              )}

              {/* 実エラー (401/403/429/500 等) */}
              {result.summary.failedSections > 0 && (
                <div className="mt-2">
                  <div className="text-amber-700">
                    <span className="font-semibold">取得エラー:</span>{" "}
                    {result.summary.failedSections} 件
                  </div>
                  <details className="mt-1">
                    <summary className="cursor-pointer text-amber-700">
                      エラー詳細
                    </summary>
                    <ul className="mt-1 list-inside list-disc text-amber-700">
                      {result.summary.failures.map((f, i) => (
                        <li key={i}>
                          <span className="font-mono">{f.label}</span>: {f.error}
                        </li>
                      ))}
                    </ul>
                  </details>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Detected({ children }: { children: React.ReactNode }) {
  if (!children) return null;
  return (
    <span className="rounded bg-white px-2 py-0.5 ring-1 ring-emerald-200">
      {children}
    </span>
  );
}

const inputCls =
  "w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500";

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium uppercase text-slate-500">
        {label}
      </span>
      {children}
    </label>
  );
}
