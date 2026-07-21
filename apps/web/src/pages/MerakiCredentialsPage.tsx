import { useCallback, useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import type { MerakiCredential } from "@config-manager/shared";
import { apiFetch, ApiError } from "../apiClient";
import { safeReturnPath } from "../utils/safeReturnPath";

/** BFF の GET /api/meraki/credentials 応答。apiKey はマスク済み。 */
interface CredentialListResponse {
  enabled: boolean;
  credentials: MerakiCredential[];
  error?: string;
}

interface EditState {
  id: string;
  label: string;
  networkId: string;
  apiKey: string;
  defaultCustomer: string;
  defaultHostname: string;
  memo: string;
}

const emptyEdit: EditState = {
  id: "",
  label: "",
  networkId: "",
  apiKey: "",
  defaultCustomer: "",
  defaultHostname: "",
  memo: "",
};

export function MerakiCredentialsPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const returnKey = safeReturnPath(params.get("from"));

  const [enabled, setEnabled] = useState(true);
  const [credentials, setCredentials] = useState<MerakiCredential[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [edit, setEdit] = useState<EditState>(emptyEdit);
  const [isEditing, setIsEditing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch<CredentialListResponse>(
        "/api/meraki/credentials",
      );
      setEnabled(res.enabled);
      setCredentials(res.credentials);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  function startNew() {
    setEdit(emptyEdit);
    setIsEditing(true);
    setError(null);
    setNotice(null);
  }

  function startEdit(c: MerakiCredential) {
    // apiKey はマスク済みで返ってきているため、編集時は空欄にして「入力時のみ更新」扱い。
    setEdit({
      id: c.id,
      label: c.label,
      networkId: c.networkId,
      apiKey: "",
      defaultCustomer: c.defaultCustomer ?? "",
      defaultHostname: c.defaultHostname ?? "",
      memo: c.memo ?? "",
    });
    setIsEditing(true);
    setError(null);
    setNotice(null);
  }

  function cancel() {
    setIsEditing(false);
    setEdit(emptyEdit);
  }

  async function save() {
    setError(null);
    setNotice(null);
    if (!edit.label.trim() || !edit.networkId.trim()) {
      setError("表示名・ネットワーク ID は必須です");
      return;
    }
    // 新規登録時のみ apiKey 必須。編集時は空欄なら更新しない。
    if (!isEditingExisting() && !edit.apiKey.trim()) {
      setError("API キーは新規登録時に必須です");
      return;
    }
    setSubmitting(true);
    try {
      if (isEditingExisting()) {
        const body: Record<string, string> = {
          label: edit.label.trim(),
          networkId: edit.networkId.trim(),
          defaultCustomer: edit.defaultCustomer.trim(),
          defaultHostname: edit.defaultHostname.trim(),
          memo: edit.memo.trim(),
        };
        if (edit.apiKey.trim()) body.apiKey = edit.apiKey.trim();
        await apiFetch(`/api/meraki/credentials/${edit.id}`, {
          method: "PUT",
          body: JSON.stringify(body),
        });
        setNotice("接続情報を更新しました。");
      } else {
        await apiFetch("/api/meraki/credentials", {
          method: "POST",
          body: JSON.stringify({
            label: edit.label.trim(),
            networkId: edit.networkId.trim(),
            apiKey: edit.apiKey.trim(),
            defaultCustomer: edit.defaultCustomer.trim(),
            defaultHostname: edit.defaultHostname.trim(),
            memo: edit.memo.trim(),
          }),
        });
        setNotice("接続情報を登録しました。");
      }
      setIsEditing(false);
      setEdit(emptyEdit);
      await reload();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  function isEditingExisting(): boolean {
    return edit.id.length > 0;
  }

  async function remove(c: MerakiCredential) {
    if (
      !window.confirm(
        `「${c.label}」を削除しますか？（ネットワーク ID: ${c.networkId}）`,
      )
    ) {
      return;
    }
    setError(null);
    try {
      await apiFetch(`/api/meraki/credentials/${c.id}`, { method: "DELETE" });
      setNotice("接続情報を削除しました。");
      await reload();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    }
  }

  /** 登録済みクレデンシャルを使って Meraki 取得ページへ遷移。 */
  function useForImport(c: MerakiCredential) {
    const qs = new URLSearchParams({
      credentialId: c.id,
      customer: c.defaultCustomer ?? "",
      hostname: c.defaultHostname ?? "",
    });
    navigate(`/meraki?${qs.toString()}`);
  }

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-2">
        <button
          onClick={() => navigate(returnKey)}
          className="text-sm text-blue-700 hover:underline"
        >
          ← 戻る
        </button>
      </div>
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">
            Meraki 接続情報
          </h1>
          <p className="mt-1 text-sm text-slate-600">
            ネットワーク ID と API キーのセットを登録・再利用します。登録済みのセットは
            「Meraki 取得」画面で選択できます。
          </p>
        </div>
        {!isEditing && enabled && (
          <button
            onClick={startNew}
            className="rounded-md bg-blue-600 px-3 py-2 text-sm text-white hover:bg-blue-700"
          >
            + 新規登録
          </button>
        )}
      </div>

      <div className="mb-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
        <span className="font-semibold">取り扱い:</span>{" "}
        API キーは Kintone 上に平文で保存されます（一覧・編集画面では末尾 4
        文字のみ表示）。本システムは API トークンでアクセス制御された Kintone
        アプリへ保存するため、取り扱い権限の設計にご注意ください。
      </div>

      {!enabled && (
        <div className="mb-4 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600">
          Meraki 接続情報アプリが未設定です（
          <code className="rounded bg-white px-1 py-0.5 ring-1 ring-slate-200">
            KINTONE_MERAKI_APP_ID
          </code>{" "}
          /{" "}
          <code className="rounded bg-white px-1 py-0.5 ring-1 ring-slate-200">
            KINTONE_MERAKI_APP_TOKEN
          </code>
          ）。未設定でも「Meraki 取得」画面で都度入力は可能です。
        </div>
      )}

      {error && <p className="mb-4 text-red-600">エラー: {error}</p>}
      {notice && (
        <p className="mb-4 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          {notice}
        </p>
      )}

      {isEditing && (
        <div className="mb-4 rounded-lg border border-slate-200 bg-white p-4">
          <h2 className="mb-3 text-sm font-semibold text-slate-700">
            {isEditingExisting() ? "接続情報の編集" : "新規登録"}
          </h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="表示名 *">
              <input
                value={edit.label}
                onChange={(e) =>
                  setEdit({ ...edit, label: e.target.value })
                }
                placeholder="例: 東京オフィス MX"
                className={inputCls}
              />
            </Field>
            <Field label="ネットワーク ID *">
              <input
                value={edit.networkId}
                onChange={(e) =>
                  setEdit({ ...edit, networkId: e.target.value })
                }
                placeholder="L_646829496481105433"
                className={inputCls}
              />
            </Field>
            <Field
              label={
                isEditingExisting() ? "API キー（空欄で変更なし）" : "API キー *"
              }
            >
              <input
                type="password"
                value={edit.apiKey}
                onChange={(e) =>
                  setEdit({ ...edit, apiKey: e.target.value })
                }
                placeholder={isEditingExisting() ? "********" : ""}
                autoComplete="off"
                className={inputCls}
              />
            </Field>
            <Field label="デフォルト顧客（任意）">
              <input
                value={edit.defaultCustomer}
                onChange={(e) =>
                  setEdit({ ...edit, defaultCustomer: e.target.value })
                }
                className={inputCls}
              />
            </Field>
            <Field label="デフォルトホスト名（任意）">
              <input
                value={edit.defaultHostname}
                onChange={(e) =>
                  setEdit({ ...edit, defaultHostname: e.target.value })
                }
                className={inputCls}
              />
            </Field>
            <Field label="メモ（任意）">
              <input
                value={edit.memo}
                onChange={(e) => setEdit({ ...edit, memo: e.target.value })}
                className={inputCls}
              />
            </Field>
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <button
              onClick={cancel}
              className="rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50"
            >
              キャンセル
            </button>
            <button
              onClick={save}
              disabled={submitting}
              className="rounded-md bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {submitting ? "保存中…" : "保存"}
            </button>
          </div>
        </div>
      )}

      {loading && <p className="text-slate-500">読み込み中…</p>}

      {!loading && enabled && credentials.length === 0 && !isEditing && (
        <p className="text-slate-500">
          登録済みの接続情報はありません。「+ 新規登録」から追加してください。
        </p>
      )}

      {!loading && enabled && credentials.length > 0 && (
        <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
              <tr>
                <th className="px-4 py-2">表示名</th>
                <th className="px-4 py-2">ネットワーク ID</th>
                <th className="px-4 py-2">API キー</th>
                <th className="px-4 py-2">デフォルト顧客</th>
                <th className="px-4 py-2">デフォルトホスト名</th>
                <th className="px-4 py-2">メモ</th>
                <th className="px-4 py-2 text-right">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {credentials.map((c) => (
                <tr key={c.id} className="hover:bg-slate-50">
                  <td className="px-4 py-2 font-medium text-slate-900">
                    {c.label}
                  </td>
                  <td className="px-4 py-2 mono text-xs">{c.networkId}</td>
                  <td className="px-4 py-2 mono text-xs text-slate-500">
                    {c.apiKey || "(空)"}
                  </td>
                  <td className="px-4 py-2">{c.defaultCustomer || "—"}</td>
                  <td className="px-4 py-2">{c.defaultHostname || "—"}</td>
                  <td className="px-4 py-2 text-slate-600">
                    {c.memo || "—"}
                  </td>
                  <td className="px-4 py-2 text-right">
                    <div className="flex justify-end gap-1">
                      <button
                        onClick={() => useForImport(c)}
                        className="rounded border border-blue-300 px-2 py-1 text-xs text-blue-700 hover:bg-blue-50"
                      >
                        取得で使用
                      </button>
                      <button
                        onClick={() => startEdit(c)}
                        className="rounded border border-slate-300 px-2 py-1 text-xs text-slate-700 hover:bg-slate-100"
                      >
                        編集
                      </button>
                      <button
                        onClick={() => remove(c)}
                        className="rounded border border-red-300 px-2 py-1 text-xs text-red-700 hover:bg-red-50"
                      >
                        削除
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
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
