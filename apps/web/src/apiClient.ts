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
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const message =
      (json && typeof json === "object" && "error" in json && String(json.error)) ||
      `request failed (${res.status})`;
    throw new ApiError(res.status, message, json);
  }
  return json as T;
}
