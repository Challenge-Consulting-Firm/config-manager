/**
 * Normalization of uploaded network-device configs.
 *
 * Goals:
 *  - Remove comment lines so that cosmetic comment edits do not produce
 *    spurious diffs (e.g. Cisco "!" lines).
 *  - Remove blank lines and trailing whitespace.
 *  - Strip a trailing Device-Manager/CLI banner noise on a best-effort basis.
 *  - Remove lines that carry no effective configuration meaning: terminal
 *    `end`/`exit` tokens, `--More--` paging artifacts, IOS-autoinserted
 *    `ntp clock-period`, and the leading `version X.Y` declaration (already
 *    captured by OS auto-detection).
 *  - Produce a stable representation so the SHA-256 hash can reliably detect
 *    real configuration changes across generations.
 *
 * The set of comment prefixes is configurable (see CONFIG_COMMENT_PREFIXES).
 */

export interface NormalizeOptions {
  /**
   * Characters that, when they are the first non-whitespace character on a
   * line, mark the whole line as a comment. Defaults to ["!"] (Cisco-style).
   */
  commentPrefixes?: string[];
}

const DEFAULT_COMMENT_PREFIXES = ["!"];

/** Lines that carry no effective configuration meaning and would only
 *  produce spurious diffs. Stripped unconditionally.
 *
 *  NOTE: Removing these changes the SHA-256 of bodies that previously
 *  contained them. Existing Kintone records keep their old hash, so the
 *  next upload of the same body registers one new generation. After that
 *  the hashes realign and no-op uploads skip as before. */
const NOISE_PATTERNS = [
  /^\s*end\s*$/, // Cisco IOS section terminator
  /^\s*exit\s*$/, // context-leave token (ASA/Juniper/etc.)
  /--More--/, // terminal paging artifact
  /^\s*ntp\s+clock-period\s+\d+/i, // IOS-autoinserted drift-correction line
  /^\s*version\s+\d[\d.()A-Za-z-]*\s*$/i, // OS version declaration; already captured by auto-detection
];

/**
 * Normalize a raw uploaded config blob.
 *
 * Returns:
 *  - body: the normalized multi-line string.
 *  - hash: SHA-256 of the normalized body.
 *  - lines: line count of the normalized body.
 *  - size: UTF-8 byte length of the normalized body.
 *  - strippedLines: number of lines that were removed.
 */
export interface NormalizeResult {
  body: string;
  hash: string;
  lines: number;
  size: number;
  strippedLines: number;
}

export async function normalizeConfig(
  raw: string,
  options: NormalizeOptions = {},
): Promise<NormalizeResult> {
  const prefixes = (options.commentPrefixes ?? DEFAULT_COMMENT_PREFIXES)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  // Precompute a single regex: ^\s*(!|#|...) -> comment line.
  const prefixPattern =
    prefixes.length > 0
      ? new RegExp(
          "^\\s*(" +
            prefixes.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") +
            ")",
        )
      : null;

  const rawLines = raw.replace(/\r\n?/g, "\n").split("\n");
  let strippedLines = 0;

  const out: string[] = [];
  for (const original of rawLines) {
    // Strip "Building configuration..." / "Current configuration:" headers
    // that Cisco IOS prepends to `show run` output.
    if (/^\s*(Current configuration|Building configuration)/i.test(original)) {
      strippedLines++;
      continue;
    }
    // Remove trailing whitespace. A line that is only whitespace is dropped.
    const trimmed = original.replace(/\s+$/g, "");
    if (trimmed.length === 0) {
      strippedLines++;
      continue;
    }
    if (prefixPattern && prefixPattern.test(trimmed)) {
      strippedLines++;
      continue;
    }
    if (NOISE_PATTERNS.some((re) => re.test(trimmed))) {
      strippedLines++;
      continue;
    }
    out.push(trimmed);
  }

  const body = out.join("\n");
  const hash = await sha256(body);
  const encoder = new TextEncoder();
  return {
    body,
    hash,
    lines: out.length,
    size: encoder.encode(body).length,
    strippedLines,
  };
}

/** Compute a hex SHA-256 of a string using the Web Crypto API. */
export async function sha256(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
