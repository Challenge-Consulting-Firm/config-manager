import { useCallback, useState } from "react";
import { useDropzone, type FileRejection } from "react-dropzone";
import { useNavigate, useSearchParams } from "react-router-dom";
import { apiFetch, ApiError } from "../apiClient";
import { safeReturnPath } from "../utils/safeReturnPath";
import { detectDeviceInfo, type DeviceDetection, type Role } from "@config-manager/shared";

interface UploadResult {
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
}

export function UploadPage() {
  const [params] = useSearchParams();
  // Identifier fields can be pre-filled via query params (e.g. when the user
  // clicks "この機器に新世代をアップロード" on a device detail page). This lets
  // the same device receive a new config generation without re-typing its
  // identifiers, avoiding typo-induced device splits.
  const presetRole: Role = params.get("role") === "spare" ? "spare" : "production";
  const [customer, setCustomer] = useState(params.get("customer") ?? "");
  const [hostname, setHostname] = useState(params.get("hostname") ?? "");
  const [ipAddress, setIpAddress] = useState(params.get("ipAddress") ?? "");
  const [purpose, setPurpose] = useState(params.get("purpose") ?? "");
  const [serialNumber, setSerialNumber] = useState(params.get("serialNumber") ?? "");
  const [role, setRole] = useState<Role>(presetRole);
  const [note, setNote] = useState("");
  const [rawText, setRawText] = useState<string>("");
  const [fileName, setFileName] = useState<string>("");
  const [detected, setDetected] = useState<DeviceDetection | null>(null);
  const [autoHost, setAutoHost] = useState(false);
  const [autoIp, setAutoIp] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<UploadResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  const returnKey = safeReturnPath(params.get("from"));

  const onDrop = useCallback(
    (files: File[], rejections: FileRejection[]) => {
      setError(null);
      if (rejections.length > 0) {
        const errs = rejections[0].errors;
        if (errs.some((e) => e.code === "file-too-large")) {
          setError("ファイルサイズが上限（5MB）を超えています。");
        } else if (errs.some((e) => e.code === "file-invalid-type")) {
          setError("対応していないファイル形式です（.conf/.cfg/.txt/.log/.bin のみ）。");
        } else {
          setError(errs[0]?.message ?? "ファイルを受け付けられませんでした。");
        }
        return;
      }
      const file = files[0];
      if (!file) return;
      setFileName(file.name);
      file
        .text()
        .then((text) => {
          setRawText(text);
          // Run detection client-side so we can auto-fill hostname / IP.
          const d = detectDeviceInfo(text);
          setDetected(d.confidence > 0 ? d : null);
          // Only auto-fill hostname / IP when the user did NOT come from a
          // device-specific link (i.e. no preset value). Otherwise respect the
          // pre-filled identifiers of the device being updated.
          if (!hostname && d.hostname) {
            setHostname(d.hostname);
            setAutoHost(true);
          } else {
            setAutoHost(false);
          }
          if (!ipAddress && d.ipAddress) {
            setIpAddress(d.ipAddress);
            setAutoIp(true);
          } else {
            setAutoIp(false);
          }
        })
        .catch(() => setError("ファイル読み込みに失敗しました"));
    },
    [],
  );

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    multiple: false,
    maxSize: 5 * 1024 * 1024,
    // .bin covers Buffalo BS-GS exports (plain-text config with a .bin name).
    accept: {
      "text/plain": [".conf", ".cfg", ".txt", ".log", ".bin"],
      "application/octet-stream": [".bin"],
    },
  });

  const isSpare = role === "spare";

  async function submit() {
    setError(null);
    setResult(null);
    if (isSpare) {
      // 予備機はシリアル番号のみ必須。ホスト名・IP・コンフィグは任意。
      if (!customer || !serialNumber.trim()) {
        setError("予備機は顧客・シリアル番号が必須です");
        return;
      }
    } else {
      if (!customer || !hostname || !ipAddress) {
        setError("顧客・ホスト名・IPアドレスは必須です");
        return;
      }
      if (!rawText.trim()) {
        setError("ファイルをドロップまたは内容を入力してください");
        return;
      }
    }
    setSubmitting(true);
    try {
      // The BFF normalizes (removes comment/blank lines) server-side; we send
      // the raw text. Normalization happens once, server-side, so the stored
      // hash is authoritative.
      const res = await apiFetch<UploadResult>("/api/upload", {
        method: "POST",
        body: JSON.stringify({
          customer,
          hostname,
          ipAddress,
          purpose,
          serialNumber,
          role,
          note,
          body: rawText,
        }),
      });
      setResult(res);
      if (res.created) {
        // Reset for next upload.
        setRawText("");
        setFileName("");
      }
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
      <h1 className="mb-4 text-xl font-semibold text-slate-900">
        {isSpare ? "予備機の登録" : "コンフィグのアップロード"}
        {!isSpare && params.get("hostname") && (
          <span className="ml-2 text-base font-normal text-slate-600">
            既存機器への新世代追加
          </span>
        )}
      </h1>
      {isSpare ? (
        <p className="mb-4 text-sm text-slate-600">
          予備機（故障時の差し替え用機材）を登録します。
          <span className="text-blue-700">シリアル番号のみ必須</span>
          で、ホスト名・IPアドレス・コンフィグは任意です。コンフィグは後から
          「新世代アップロード」で追加してもDiffできます。
        </p>
      ) : (
        <p className="mb-4 text-sm text-slate-600">
          ファイルをドラッグ&ドロップで登録します。コメント行・空白行・末尾空白は
          サーバー側で除去されたうえで世代管理されます。
          {params.get("hostname") && (
            <span className="ml-1 text-blue-700">
              識別情報は選択中の機器から引き継いでいます。
            </span>
          )}
        </p>
      )}

      {/* 予備機モード時、対象機器（本番機）の紐付け先を明示する */}
      {isSpare && params.get("hostname") && (
        <div className="mb-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          <span className="font-semibold">対象機器（本番機）:</span>{" "}
          {customer} / <span className="mono">{params.get("hostname")}</span>
          {" — "}
          同じ顧客・ホスト名で紐づき、登録後に本番機とDiffできます。
        </div>
      )}

      {/* 自動検出結果パネル */}
      {detected && (detected.vendor || detected.os) && (
        <div className="mb-4 rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-800">
          <span className="font-semibold uppercase">コンフィグから自動識別:</span>{" "}
          {detected.vendor} / {detected.os}
          {detected.osVersion && ` v${detected.osVersion}`}
          {detected.model && ` · 機種 ${detected.model}`}
          （ホスト名・IPアドレスも自動入力しました。必要に応じて修正してください）
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="顧客 *">
          <input value={customer} onChange={(e) => setCustomer(e.target.value)} className={inputCls} />
        </Field>
        <Field label={isSpare ? "ホスト名" : "ホスト名 *"} auto={autoHost}>
          <input
            value={hostname}
            onChange={(e) => {
              setHostname(e.target.value);
              setAutoHost(false);
            }}
            placeholder={
              isSpare
                ? "任意（対象機器から引き継ぎ）"
                : detected
                  ? "検出できませんでした。入力してください"
                  : "例: RTR-01"
            }
            className={inputCls}
          />
        </Field>
        <Field label={isSpare ? "IPアドレス" : "IPアドレス *"} auto={autoIp}>
          <input
            value={ipAddress}
            onChange={(e) => {
              setIpAddress(e.target.value);
              setAutoIp(false);
            }}
            placeholder={
              isSpare
                ? "任意"
                : detected
                  ? "検出できませんでした。入力してください"
                  : "例: 10.0.0.1"
            }
            className={inputCls}
          />
        </Field>
        <Field label={isSpare ? "シリアル番号 *" : "シリアル番号"}>
          <input value={serialNumber} onChange={(e) => setSerialNumber(e.target.value)} placeholder="例: FCHXXXXX" className={inputCls} />
        </Field>
        <Field label="用途">
          <input value={purpose} onChange={(e) => setPurpose(e.target.value)} placeholder="edge-router / core-switch など" className={inputCls} />
        </Field>
      </div>

      <div className="mt-4 flex items-center gap-6">
        <span className="text-xs font-medium uppercase text-slate-500">稼働区分 *</span>
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

      <div className="mt-4">
        <Field label="メモ（任意）">
          <input value={note} onChange={(e) => setNote(e.target.value)} className={inputCls} />
        </Field>
      </div>

      <div
        {...getRootProps()}
        className={`mt-4 flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed p-8 text-center transition ${
          isDragActive ? "border-blue-500 bg-blue-50" : "border-slate-300 bg-white"
        }`}
      >
        <input {...getInputProps()} />
        {fileName ? (
          <p className="text-sm text-slate-700">
            <span className="font-medium">{fileName}</span> · {rawText.length}文字
          </p>
        ) : isDragActive ? (
          <p className="text-sm text-blue-600">ドロップしてください</p>
        ) : (
          <p className="text-sm text-slate-500">
            ここにファイルをドラッグ&ドロップ、またはクリックして選択
            {isSpare && <span className="text-blue-600">（任意）</span>}
            <br />
            <span className="text-xs">(.conf / .cfg / .txt / .log / .bin)</span>
          </p>
        )}
      </div>

      <div className="mt-4 flex items-center justify-between">
        <p className="text-xs text-slate-500">
          巨大なファイルはブラウザのメモリに読み込まれます。想定外の巨大ファイルに注意してください。
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
            {submitting ? "送信中…" : "アップロード"}
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
                (result.created.detected.vendor || result.created.detected.os) && (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <span className="font-semibold uppercase text-xs">自動検出:</span>
                    <Detected>{result.created.detected.vendor}</Detected>
                    <Detected>{result.created.detected.os}</Detected>
                    {result.created.detected.osVersion && (
                      <Detected>v{result.created.detected.osVersion}</Detected>
                    )}
                    {result.created.detected.model && (
                      <Detected>{result.created.detected.model}</Detected>
                    )}
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
  auto,
  children,
}: {
  label: string;
  auto?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 flex items-center gap-1.5 text-xs font-medium uppercase text-slate-500">
        {label}
        {auto && (
          <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium normal-case text-emerald-700">
            自動検出
          </span>
        )}
      </span>
      {children}
    </label>
  );
}
