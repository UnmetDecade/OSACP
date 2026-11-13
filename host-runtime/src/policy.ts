import fs from "node:fs";
import path from "node:path";

/**
 * Root-owned local policy veto.
 *
 * The control plane decides what should run; this host decides what it is willing to run. The file
 * lives outside every directory the platform writes to, so an operator can stop this machine with
 * one edit even when PCS, the scheduler or the network are compromised.
 *
 * Default is "no file, no veto": an existing host that never created one keeps working. The moment
 * the file exists it becomes authoritative, and anything wrong with it fails closed -- an
 * unreadable or world-writable policy is not "no policy", it is "policy unknown", which is a veto.
 */

export type PolicyAction = "DEPLOY" | "START" | "RESTART" | "STOP" | "REMOVE";

export interface HostPolicy {
  version?: number;
  /** Stop all new work on this host; stopping and removing existing deployments stays possible. */
  kill_switch?: boolean;
  deploy?: boolean;
  start?: boolean;
  restart?: boolean;
  stop?: boolean;
  remove?: boolean;
  /** When set, only these roles may be deployed here. */
  allowed_roles?: string[];
  /** Any image whose reference starts with one of these prefixes is refused. */
  denied_image_prefixes?: string[];
  /** Cap on deployments this host will accept, counted from its own state. */
  max_deployments?: number;
  updated_at?: string;
  note?: string;
}

export interface PolicyDecision {
  allowed: boolean;
  reason?: string;
  /** "absent" means no policy file was configured; "file" means it was read and applied. */
  source: "absent" | "file";
  kill_switch: boolean;
}

export interface PolicyContext {
  action: PolicyAction;
  role_id?: string;
  image?: string;
  /** Number of deployments this host currently intends to run, excluding the one being started. */
  active_deployments?: number;
}

const DEFAULT_FILE = "/etc/osacp/host-policy.json";

export class HostPolicyGate {
  private cached?: { key: string; decision: PolicyDecision; policy?: HostPolicy };
  readonly file: string;

  constructor(
    file = process.env.OSACP_HOST_POLICY_FILE || DEFAULT_FILE,
    private readonly log: (message: string) => void = () => {},
  ) {
    this.file = path.resolve(file);
  }

  check(ctx: PolicyContext): PolicyDecision {
    const { decision, policy } = this.read();
    if (!decision.allowed) return decision;

    // Stopping is always allowed: a veto must not be able to trap a running workload on the host.
    if (ctx.action === "STOP" || ctx.action === "REMOVE") {
      return { ...decision, allowed: policy?.[ctx.action.toLowerCase() as "stop" | "remove"] !== false };
    }

    if (!policy) return decision;
    if (policy.kill_switch) {
      return { ...decision, allowed: false, reason: "HOST_KILL_SWITCH" };
    }
    const perAction = policy[ctx.action.toLowerCase() as "deploy" | "start" | "restart"];
    if (perAction === false) {
      return { ...decision, allowed: false, reason: `POLICY_DENIES_${ctx.action}` };
    }
    if (Array.isArray(policy.allowed_roles) && policy.allowed_roles.length) {
      if (!ctx.role_id || !policy.allowed_roles.includes(ctx.role_id)) {
        return { ...decision, allowed: false, reason: "POLICY_ROLE_NOT_ALLOWED" };
      }
    }
    if (Array.isArray(policy.denied_image_prefixes)) {
      const image = String(ctx.image ?? "");
      const hit = policy.denied_image_prefixes.find((p) => p && image.startsWith(p));
      if (hit) return { ...decision, allowed: false, reason: "POLICY_IMAGE_DENIED" };
    }
    if (ctx.action === "DEPLOY" && Number(policy.max_deployments) > 0) {
      if (Number(ctx.active_deployments ?? 0) >= Number(policy.max_deployments)) {
        return { ...decision, allowed: false, reason: "POLICY_MAX_DEPLOYMENTS" };
      }
    }
    return decision;
  }

  status(): { file: string; source: "absent" | "file"; kill_switch: boolean; trusted: boolean } {
    const { decision, policy } = this.read();
    return {
      file: this.file,
      source: decision.source,
      kill_switch: Boolean(policy?.kill_switch) || !decision.allowed,
      trusted: decision.allowed || Boolean(policy),
    };
  }

  private read(): { decision: PolicyDecision; policy?: HostPolicy } {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(this.file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        const decision: PolicyDecision = { allowed: true, source: "absent", kill_switch: false };
        this.cached = { key: "absent", decision };
        return { decision };
      }
      // A stat failure may be transient (permissions changed mid-read); re-check, but do not log every round.
      const key = `stat-error:${new Date().toISOString().slice(0, 16)}`;
      if (this.cached?.key === key) return { decision: this.cached.decision };
      return this.deny(key, `POLICY_UNREADABLE: ${(e as Error).message}`);
    }

    const key = `${stat.mtimeMs}:${stat.size}:${stat.ino}`;
    if (this.cached?.key === key) return { decision: this.cached.decision, policy: this.cached.policy };

    if (!stat.isFile()) return this.deny(key, "POLICY_UNTRUSTED: the policy path is not a regular file");
    // A policy that anyone but root can rewrite is not a policy. Root-owned is accepted without the
    // write bit check only when this process cannot check owners (non-root runtimes on a workstation).
    const worldWritable = (stat.mode & 0o022) !== 0;
    if (worldWritable) {
      return this.deny(
        key,
        `POLICY_UNTRUSTED: ${this.file} is writable by group or others (mode ${(stat.mode & 0o777).toString(8)})`,
      );
    }
    if (typeof process.getuid === "function" && process.getuid() === 0 && stat.uid !== 0) {
      return this.deny(key, `POLICY_UNTRUSTED: ${this.file} is not owned by root (uid ${stat.uid})`);
    }

    let policy: HostPolicy;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return this.deny(key, "POLICY_UNREADABLE: the policy must be a JSON object");
      }
      policy = parsed as HostPolicy;
    } catch (e) {
      return this.deny(key, `POLICY_UNREADABLE: ${(e as Error).message}`);
    }

    const decision: PolicyDecision = {
      allowed: true,
      source: "file",
      kill_switch: Boolean(policy.kill_switch),
    };
    this.cached = { key, decision, policy };
    this.log(
      `Host policy ${this.file} loaded: ` +
        (policy.kill_switch ? "KILL SWITCH ON" : `deploy=${policy.deploy !== false}`) +
        (policy.note ? ` (${policy.note})` : ""),
    );
    return { decision, policy };
  }

  private deny(key: string, reason: string): { decision: PolicyDecision } {
    this.log(reason);
    const decision: PolicyDecision = { allowed: false, reason, source: "file", kill_switch: false };
    this.cached = { key, decision };
    return { decision };
  }
}
