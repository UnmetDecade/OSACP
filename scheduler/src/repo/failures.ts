import { createHash } from "node:crypto";
import { q, type Client } from "../db.js";

/**
 * Failure signatures make a dead-letter queue readable across a fleet.
 *
 * Raw error text carries paths, UUIDs, URLs, numbers and sometimes file names; grouping by the raw
 * string gives one entry per occurrence. The normalizer replaces those parts before hashing, so
 * "ENOENT /build/a1/src/x.ts" and "ENOENT /build/b2/src/y.ts" collapse into one signature while the
 * evidence (the raw message) stays on the attempt.
 */

const MAX_SAMPLE = 240;

export function normalizeFailure(text: unknown): string {
  return String(text ?? "")
    .replace(/```[\s\S]*?```/g, " <code> ")
    .replace(/https?:\/\/\S+/gi, "<url>")
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "<email>")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<uuid>")
    .replace(/(?:[A-Za-z]:)?(?:[\\/][^\s:*?"<>|]+)+/g, "<path>")
    .replace(/\b[0-9a-f]{16,}\b/gi, "<hex>")
    .replace(/\b\d+(?:\.\d+)?\b/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_SAMPLE);
}

export function failureKind(code: string): string {
  const upper = code.toUpperCase();
  if (/TIMEOUT|DEADLINE/.test(upper)) return "timeout";
  if (/STALL/.test(upper)) return "stalled";
  if (/RATE_LIMIT|QUOTA|USAGE_LIMIT|TOO_MANY_REQUESTS/.test(upper)) return "rate_limit";
  if (/OUTWARD/.test(upper)) return "outward";
  if (/DIGEST|SCHEMA|INVALID|DENIED|NOT_ALLOWED|UNKNOWN/.test(upper)) return "permanent";
  return "error";
}

export interface FailureSignature {
  signature: string;
  kind: string;
  sample: string;
}

/** `kind:sha256(code|normalized message)[:16]` — stable across hosts and attempts. */
export function failureSignature(code: string, message: unknown): FailureSignature {
  const sample = normalizeFailure(message);
  const digest = createHash("sha256").update(`${code}|${sample}`).digest("hex").slice(0, 16);
  const kind = failureKind(code);
  return { signature: `${kind}:${digest}`, kind, sample };
}

/** Upsert the signature and return its id; called once per failed attempt, inside the result transaction. */
export async function recordFailureSignature(
  c: Client,
  input: { code: string; message: unknown },
): Promise<string> {
  const sig = failureSignature(input.code, input.message);
  await c.query(
    `INSERT INTO failure_signatures (signature, kind, code, sample, occurrences, first_seen_at, last_seen_at)
     VALUES ($1, $2, $3, $4, 1, app_now(), app_now())
     ON CONFLICT (signature) DO UPDATE
        SET occurrences = failure_signatures.occurrences + 1,
            sample = EXCLUDED.sample,
            last_seen_at = app_now()`,
    [sig.signature, sig.kind, input.code, sig.sample],
  );
  return sig.signature;
}

export async function listFailureSignatures(limit?: number) {
  const bounded = Math.min(200, Math.max(1, Number(limit) || 50));
  return q(
    `SELECT signature, kind, code, sample, occurrences, first_seen_at, last_seen_at
       FROM failure_signatures
      ORDER BY last_seen_at DESC
      LIMIT $1`,
    [bounded],
  );
}
