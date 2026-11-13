/**
 * Secret redaction for log lines and audit records.
 *
 * One implementation for every write path: the adapter boundary, the task log, and the audit
 * chain. A record that reaches disk is a record that can be subpoenaed, so redaction happens
 * before the write, never after.
 */
export function redact(line: string): string {
  return String(line)
    .replace(/(bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1<redacted>")
    .replace(/((?:secret|token|password|passwd|api[_-]?key)\s*[=:]\s*)[^\s,"'}]+/gi, "$1<redacted>")
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "<redacted-private-key>");
}

/** Apply redaction to every string in a nested value, leaving the shape intact. */
export function redactDeep(value: unknown, depth = 0): unknown {
  if (depth > 6) return "<truncated>";
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = redactDeep(v, depth + 1);
    return out;
  }
  return value;
}
