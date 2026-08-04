/**
 * Helpers that keep internal exception details out of production API responses
 * while still logging them server-side for operators.
 */

/** Log the original error and return a client-safe message. */
export function publicErrorMessage(
  err: unknown,
  nodeEnv: string,
  fallback: string,
): string {
  const detail = err instanceof Error ? err.message : String(err);
  console.error(`[api-error] ${fallback}:`, err);
  if (nodeEnv === "production") return fallback;
  return `${fallback}: ${detail}`;
}
