/**
 * Thin wrapper around fetch that surfaces JSON errors and never caches.
 */

export class ApiError extends Error {
  constructor(public status: number, message: string, public body?: unknown) {
    super(message);
  }
}

export async function apiFetch<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    credentials: "same-origin",
  });
  if (res.status === 401) {
    // Redirect to BFF login flow, preserving current path.
    const here = window.location.pathname + window.location.search;
    window.location.href = `/auth/login?returnTo=${encodeURIComponent(here)}`;
    // Throw so callers stop executing.
    throw new ApiError(401, "unauthenticated");
  }
  const text = await res.text();
  // BFF が JSON 以外 (例: Hono デフォルトの "Internal Server Error") を返した
  // 場合でもクラッシュしないよう、JSON パースは try/catch で保護する。
  let json: unknown = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      // JSON でないテキストが返ってきた場合は、そのテキストをメッセージとして扱う。
      // res.ok でなければ下のエラー分岐で ApiError へ流れる。
      if (!res.ok) {
        throw new ApiError(
          res.status,
          text.slice(0, 500) || `request failed (${res.status})`,
          text,
        );
      }
      // res.ok なのに JSON でない場合は呼び出し元で扱えるようそのまま返す。
      throw new ApiError(
        res.status,
        `expected JSON response but got: ${text.slice(0, 200)}`,
        text,
      );
    }
  }
  if (!res.ok) {
    const message =
      (json && typeof json === "object" && json !== null && "error" in json
        ? String((json as Record<string, unknown>).error)
        : "") ||
      `request failed (${res.status})`;
    throw new ApiError(res.status, message, json);
  }
  return json as T;
}
