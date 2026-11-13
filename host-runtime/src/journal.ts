import fs from "node:fs";
import path from "node:path";

/**
 * Operation journal for host-side mutations.
 *
 * Docker and process spawns are not transactional: a deploy can create a container, start it, and
 * then fail while writing files, and a crash can land anywhere in between. The journal records the
 * intent before the mutation (BEGIN), the fact after it (APPLIED), and closure when the whole
 * command succeeded (COMMITTED). Anything still open after a restart was interrupted mid-flight and
 * is rolled back before reconciliation continues.
 *
 * The journal is append-only JSONL and deliberately dumb: it must still be readable when the state
 * file is corrupt, because it is the record of what might exist outside the state file.
 */

export type JournalPhase = "BEGIN" | "APPLIED" | "COMMITTED" | "ROLLED_BACK";

export type OperationKind = "CONTAINER_CREATE" | "CONTAINER_START" | "NATIVE_START" | "DEPLOYMENT_REMOVE";

export interface Operation {
  op_id: string;
  txn_id: string;
  kind: OperationKind;
  /** Container name, instance id or other target the rollback action needs. */
  target: string;
  detail: Record<string, unknown>;
  phase: JournalPhase;
  at: string;
  reason?: string;
}

interface JournalLine extends Partial<Operation> {
  phase: JournalPhase;
  op_id: string;
}

const MAX_LINES = 2000;

export class OperationJournal {
  private ops = new Map<string, Operation>();
  private lines = 0;

  constructor(
    private readonly file: string,
    private readonly log: (message: string) => void = () => {},
  ) {
    this.replay();
  }

  private replay(): void {
    let raw = "";
    try {
      raw = fs.readFileSync(this.file, "utf8");
    } catch {
      return;
    }
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      this.lines++;
      let rec: JournalLine;
      try {
        rec = JSON.parse(line);
      } catch {
        // A torn final line (crash during append) is expected; ignore it and keep the rest.
        continue;
      }
      if (!rec?.op_id) continue;
      const prev = this.ops.get(rec.op_id);
      if (rec.phase === "BEGIN" && !prev) {
        this.ops.set(rec.op_id, {
          op_id: rec.op_id,
          txn_id: String(rec.txn_id ?? ""),
          kind: (rec.kind ?? "CONTAINER_CREATE") as OperationKind,
          target: String(rec.target ?? ""),
          detail: (rec.detail ?? {}) as Record<string, unknown>,
          phase: "BEGIN",
          at: String(rec.at ?? new Date(0).toISOString()),
        });
      } else if (prev) {
        prev.phase = rec.phase;
        prev.at = String(rec.at ?? prev.at);
        if (rec.reason) prev.reason = rec.reason;
      }
    }
  }

  private append(line: JournalLine): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      fs.appendFileSync(this.file, `${JSON.stringify(line)}\n`, { mode: 0o600 });
      this.lines++;
    } catch (e) {
      this.log(`Journal write failed (${line.op_id} ${line.phase}): ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    if (this.lines > MAX_LINES) this.compact();
  }

  private compact(): void {
    const keep = [...this.ops.values()].filter((op) => op.phase === "BEGIN" || op.phase === "APPLIED");
    const lines: string[] = [];
    for (const op of keep) {
      lines.push(JSON.stringify({ op_id: op.op_id, txn_id: op.txn_id, kind: op.kind, target: op.target, detail: op.detail, phase: "BEGIN", at: op.at }));
      if (op.phase === "APPLIED") {
        lines.push(JSON.stringify({ op_id: op.op_id, phase: "APPLIED", at: op.at }));
      }
    }
    try {
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, lines.length ? `${lines.join("\n")}\n` : "", { mode: 0o600 });
      fs.renameSync(tmp, this.file);
      this.lines = lines.length;
      this.ops = new Map(keep.map((op) => [op.op_id, op]));
    } catch (e) {
      this.log(`Journal compaction failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  begin(txnId: string, kind: OperationKind, target: string, detail: Record<string, unknown> = {}): Operation {
    const op: Operation = {
      op_id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      txn_id: txnId,
      kind,
      target,
      detail,
      phase: "BEGIN",
      at: new Date().toISOString(),
    };
    this.ops.set(op.op_id, op);
    this.append({ op_id: op.op_id, txn_id: op.txn_id, kind, target, detail, phase: "BEGIN", at: op.at });
    return op;
  }

  applied(op: Operation): void {
    op.phase = "APPLIED";
    op.at = new Date().toISOString();
    this.append({ op_id: op.op_id, phase: "APPLIED", at: op.at });
  }

  commit(op: Operation): void {
    op.phase = "COMMITTED";
    op.at = new Date().toISOString();
    this.append({ op_id: op.op_id, phase: "COMMITTED", at: op.at });
  }

  rolledBack(op: Operation, reason: string): void {
    op.phase = "ROLLED_BACK";
    op.reason = reason;
    op.at = new Date().toISOString();
    this.append({ op_id: op.op_id, phase: "ROLLED_BACK", reason, at: op.at });
  }

  /** Operations interrupted by a crash: applied but not committed, or begun and never finished. */
  pending(): Operation[] {
    return [...this.ops.values()].filter((op) => op.phase === "BEGIN" || op.phase === "APPLIED");
  }

  forTxn(txnId: string): Operation[] {
    return [...this.ops.values()].filter((op) => op.txn_id === txnId);
  }

  get size(): number {
    return this.ops.size;
  }
}
