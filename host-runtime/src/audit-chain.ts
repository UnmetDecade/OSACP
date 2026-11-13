import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { redactDeep } from "./redact.js";

/**
 * Tamper-evident audit log.
 *
 * Every record carries the hash of the previous record, so deleting, reordering or editing a line
 * breaks every hash after it. Verification runs at startup: if the chain is broken, the runtime
 * reports it and the reconcile gate refuses to create anything new until an operator intervenes.
 *
 * This is not a defense against a root attacker rewriting the whole file (nothing local is); it is
 * a defense against quiet edits, accidental truncation, and "the log says something else now".
 */

export interface AuditRecord {
  seq: number;
  at: string;
  event: string;
  [key: string]: unknown;
}

export interface AuditVerifyResult {
  ok: boolean;
  records: number;
  broken_at?: number;
  reason?: string;
  last_hash: string;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
}

/** Each hash covers the previous hash and the whole record body, so position and content are both bound. */
function hashRecord(prev: string, body: Record<string, unknown>): string {
  return `sha256:${createHash("sha256").update(`${prev}\n${canonical(body)}`).digest("hex")}`;
}

export class AuditChain {
  private lastHash = "";
  private seq = 0;
  private writeFailed = false;

  constructor(
    private readonly file: string,
    private readonly onError?: (message: string) => void,
  ) {}

  /** Read the whole chain and recompute it. Cheap enough at startup; reports the first broken record. */
  verify(): AuditVerifyResult {
    let raw: string;
    try {
      raw = fs.readFileSync(this.file, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        this.lastHash = "";
        this.seq = 0;
        return { ok: true, records: 0, last_hash: "" };
      }
      return { ok: false, records: 0, reason: (e as Error).message, last_hash: "" };
    }

    let prev = "";
    let expectedSeq = 1;
    let records = 0;
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let rec: Record<string, unknown>;
      try {
        rec = JSON.parse(line);
      } catch {
        return { ok: false, records, broken_at: expectedSeq, reason: "record is not valid JSON", last_hash: prev };
      }
      const { hash, ...body } = rec as { hash?: string } & Record<string, unknown>;
      const want = hashRecord(prev, body);
      if (hash !== want) {
        return {
          ok: false,
          records,
          broken_at: Number(rec.seq) || expectedSeq,
          reason: "record hash does not match its content",
          last_hash: prev,
        };
      }
      if (Number(rec.seq) !== expectedSeq) {
        return {
          ok: false,
          records,
          broken_at: expectedSeq,
          reason: `sequence gap at ${expectedSeq} (record says ${String(rec.seq)})`,
          last_hash: prev,
        };
      }
      prev = want;
      expectedSeq++;
      records++;
    }
    this.lastHash = prev;
    this.seq = records;
    return { ok: true, records, last_hash: prev };
  }

  /** Append one record. A write failure is reported but never throws into the caller's path. */
  append(event: string, data: Record<string, unknown> = {}): void {
    const body: Record<string, unknown> = {
      seq: this.seq + 1,
      at: new Date().toISOString(),
      event,
      prev: this.lastHash || null,
      ...(redactDeep(data) as Record<string, unknown>),
    };
    const hash = hashRecord(this.lastHash, body);
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      // Append mode with O_APPEND: concurrent writers cannot interleave partial lines.
      fs.appendFileSync(this.file, `${JSON.stringify({ ...body, hash })}\n`, { mode: 0o600 });
      this.lastHash = hash;
      this.seq += 1;
    } catch (e) {
      this.writeFailed = true;
      this.onError?.(`Audit write failed (${event}): ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** A record that could not be written means the log no longer reflects what happened. */
  get broken(): boolean {
    return this.writeFailed;
  }

  get last_hash(): string {
    return this.lastHash;
  }
}
