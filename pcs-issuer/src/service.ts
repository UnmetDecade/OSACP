import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PcsConfig } from "./config.js";
import { readKey } from "./config.js";
import {
  assertNoSecretsInEnv,
  assertPinnedImage,
  normalizeResourceProfile,
  redactEnvForView,
  signCommand,
  validateFilesAndAgentEnv,
  type CommandPayload,
  type CommandType,
  type InstanceSpec,
  type PortMapping,
  type ResourceProfile,
} from "./commands.js";
import { conflict, forbidden, notFound, PcsError } from "./errors.js";
import {
  loadCredentialKey,
  looksLikePrivateKey,
  openSecret,
  resolveAuthType,
  sealSecret,
  secretFingerprint,
} from "./credentials.js";
import {
  execSsh,
  pipeToSsh,
  probeLocal,
  probeSsh,
  type SshProbe,
  type SshTarget,
} from "./ssh.js";
import { buildBootstrapScript, buildEnvSetupScript, runLocalBootstrap } from "./bootstrap.js";
import { ensureRuntimeBundle } from "./runtime-bundle.js";
import { resolveCapability, type CapabilityDetail } from "./capability.js";
import { query, tx, type Client } from "./db.js";
import {
  ADMIN_AUDIENCE,
  ADMIN_SCOPES,
  HOST_SCOPES,
  ISSUER,
  RUNTIME_AUDIENCE,
  SCHEDULER_AUDIENCE,
  requireClaimScope,
  signJwt,
  verifyJwt,
  type JwtClaims,
} from "./jwt.js";

export type HostRow = {
  host_id: string;
  hostname: string;
  os: string;
  arch: string;
  fingerprint: string;
  status: string;
  labels: Record<string, unknown>;
  resources: Record<string, unknown>;
  devices: unknown[];
  tools: unknown[];
  enrolled_at: string | null;
  last_seen_at: string | null;
  /** The host it is merged into; empty means it is the root of the federation tree (each host still has its own root scheduler internally). */
  parent_host_id?: string | null;
  /** containers = container host; builder / scheduler = the host itself is that role (not a container). */
  role_mode?: "containers" | "builder" | "scheduler";
  created_at: string;
  updated_at: string;
};

/** Host access mode. Private-key ciphertext is deliberately not in this type, to avoid it being returned to callers by accident. */
export type HostCredentialRow = {
  host_id: string;
  transport: "local" | "ssh";
  address: string | null;
  ssh_port: number;
  ssh_user: string | null;
  /** key = private-key auth, password = password auth; the actual credential is never echoed. */
  auth_type?: "key" | "password" | null;
  key_fingerprint: string | null;
  last_probe: Record<string, unknown> | null;
  last_probe_at: string | null;
};

export type DeploymentRow = {
  deployment_id: string;
  instance_id: string;
  host_id: string;
  role_id: string;
  display_name: string | null;
  /** container = Docker container; native = a role process on the host machine. */
  execution?: "container" | "native";
  image: string;
  desired_state: string;
  actual_state: string;
  config_version: string | number;
  generation: string | number;
  resource_profile: ResourceProfile;
  env: Record<string, string>;
  volumes: Array<{ name: string; mount: string }>;
  ports: PortMapping[];
  network_policy: string;
  command: string[] | null;
  status: string;
  observed: Record<string, unknown>;
  /** Builder capability score W (0–1000); 0 for schedulers / non-builders. */
  capability_score?: number;
  capability_detail?: CapabilityDetail;
  /** Scheduler identity: at most one root per host; a node hangs under one of the same host's schedulers. */
  scheduler_role?: "root" | "node" | null;
  /** The parent scheduler of a node scheduler (deployment_id); empty for a root scheduler. */
  parent_deployment_id?: string | null;
  /** This scheduler's API address; builders and child nodes use it to register/report. */
  scheduler_url?: string | null;
  /** Which scheduler the builder registered with (deployment_id); for legacy rows that are empty, fall back to the host config. */
  scheduler_deployment_id?: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
};

export type CommandRow = {
  command_id: string;
  host_id: string;
  deployment_id: string | null;
  instance_id: string | null;
  command_type: CommandType;
  generation: string | number | null;
  payload: CommandPayload;
  expires_at: string;
  state: string;
  attempts: number;
  result: unknown;
  created_at: string;
  delivered_at: string | null;
  acked_at: string | null;
};

const newId = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 24)}`;

/** The task attachment limit must cover a packaged code directory; see http.ts for the request body limit. */
const MAX_TASK_ATTACHMENT_BYTES = 24 * 1024 * 1024;
const TASK_ATTACHMENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const hashToken = (raw: string) => createHash("sha256").update(raw).digest("hex");
const iso = (ms: number) => new Date(ms).toISOString();
const nowMs = () => Date.now();

/** Canonical JSON: sorted keys, undefined removed, used as input to the plan digest. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .filter((k) => obj[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
    .join(",")}}`;
}

/** Accept only a hostname or IP; reject values starting with - (to prevent ssh argument injection), protocols, paths, and whitespace. */
function isSafeHost(value: string): boolean {
  if (!value || value.length > 253 || value.startsWith("-")) return false;
  if (/\s/.test(value) || value.includes("/")) return false;
  return /^[A-Za-z0-9._:\-\[\]]+$/.test(value);
}

function planDigest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

export type AgentProfileRow = {
  agent_profile_id: string;
  role_id: string;
  name: string;
  version: string;
  adapter: "stdio-jsonrpc" | "http-local";
  artifact_image: string;
  entrypoint: string[];
  args: string[];
  model_api_profile_id: string | null;
  tool_api_profile_ids: string[];
  limits: Record<string, unknown>;
  capabilities: string[];
  allowed_tools: string[];
  task_types: string[];
  /** One-line description for panel identification; not included in the prompt. */
  description: string;
  system_prompt: string;
  persona: string;
  tone: string;
  goals: string;
  enabled: boolean;
  created_at: string;
  updated_at: string;
};

export type ApiProfileRow = {
  api_profile_id: string;
  name: string;
  kind: "llm" | "http" | "tool" | "storage";
  base_url: string;
  auth_type: "bearer" | "api_key" | "oauth2_client" | "mtls";
  secret_ref: string;
  scopes: string[];
  quota: { rpm?: number; daily_calls?: number };
  timeout_seconds: number;
  egress: string | null;
  fallback: string[];
  enabled: boolean;
  created_at: string;
  updated_at: string;
};

export interface CreateAgentProfileInput {
  agent_profile_id?: string;
  role_id: string;
  name: string;
  version: string;
  adapter: string;
  artifact_image: string;
  entrypoint?: string[];
  args?: string[];
  model_api_profile_id?: string | null;
  tool_api_profile_ids?: string[];
  limits?: Record<string, unknown>;
  capabilities?: string[];
  allowed_tools?: string[];
  task_types?: string[];
  description?: string;
  system_prompt?: string;
  persona?: string;
  tone?: string;
  goals?: string;
  enabled?: boolean;
}

export interface CreateApiProfileInput {
  api_profile_id?: string;
  name: string;
  kind: string;
  base_url: string;
  auth_type: string;
  secret_ref: string;
  scopes?: string[];
  quota?: { rpm?: number; daily_calls?: number };
  timeout_seconds?: number;
  egress?: string | null;
  fallback?: string[];
  enabled?: boolean;
}

export interface ResolvedInstance {
  host_id: string;
  instance_id: string;
  role_id: string;
  agent: AgentProfileRow;
  api_profiles: ApiProfileRow[];
}

/**
 * v4 allowed matrix: only builder and scheduler; both can bind stdio / localhost HTTP Agents.
 * Deterministic shell work is done directly by the executor and needs no Agent Profile.
 */
const AGENT_ADAPTERS: Record<string, string[]> = {
  builder: ["stdio-jsonrpc", "http-local"],
  scheduler: ["stdio-jsonrpc", "http-local"],
};

const SECRET_REF = /^secret:\/\/[A-Za-z0-9._\-\/]{1,200}$/;

function unique(values: string[]): string[] {
  return [...new Set(values.map((v) => String(v).trim()).filter(Boolean))];
}

/** Prompt-like fields: trim whitespace and cap length uniformly, to avoid stuffing an entire knowledge base into a Profile. */
function promptField(value: unknown, field: string, max: number): string {
  const text = String(value ?? "").trim();
  if (text.length > max) {
    throw new PcsError(400, "INVALID_PROFILE", `${field} exceeds ${max} characters`);
  }
  return text;
}

/** Runtime limits; unspecified keys are left as-is, unknown keys pass through. */
function normalizeLimits(input?: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(input ?? {}) };
  const bounds: Record<string, number> = {
    max_turns: 200,
    max_wall_seconds: 86_400,
    max_output_tokens: 1_000_000,
  };
  for (const [key, max] of Object.entries(bounds)) {
    const raw = out[key];
    if (raw === undefined || raw === null || raw === "") {
      delete out[key];
      continue;
    }
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > max) {
      throw new PcsError(400, "INVALID_LIMITS", `${key} must be an integer in 1–${max}`);
    }
    out[key] = n;
  }
  return out;
}

/** Naming as `<role>-<letter>`; on conflict keep advancing the letter, and only as a last resort append a short random string. */
function uniqueInstanceName(roleId: string, used: Set<string>): string {
  const prefix = roleId.replace(/_/g, "-");
  for (let i = 0; i < 26 * 3; i++) {
    const letter =
      i < 26
        ? String.fromCharCode(97 + i)
        : `${String.fromCharCode(97 + (i % 26))}${Math.floor(i / 26)}`;
    const name = `${prefix}-${letter}`;
    if (!used.has(name)) return name;
  }
  return `${prefix}-${Date.now().toString(36).slice(-5)}`;
}

/**
 * Name (display name) → instance id.
 *
 * Display names may be Chinese, but the instance id is used to derive container names / volume names / node ids / database names,
 * so it may contain only lowercase letters, digits, and hyphens. ASCII alphanumerics are kept as-is, spaces and common
 * separators become `-`, and other characters are expanded by code point: 「测试机」→ `27979-35797-26426`.
 */
function instanceIdFromName(raw: string): string {
  let out = "";
  for (const ch of raw.trim().toLowerCase()) {
    if (/^[a-z0-9]$/.test(ch)) out += ch;
    else if (/^[\s._/-]$/.test(ch)) out += "-";
    else out += `-${ch.codePointAt(0) ?? 0}-`;
  }
  out = out.replace(/-+/g, "-").replace(/^-+|-+$/g, "");
  if (!out) out = "instance";
  if (out.length > 48) {
    // Code-point expansion may exceed the container naming limit: keep the prefix and end with a name digest, so identical names map to identical ids.
    const digest = createHash("sha256").update(raw.trim()).digest("hex").slice(0, 8);
    out = `${out.slice(0, 39).replace(/-+$/, "")}-${digest}`;
  }
  return out;
}

/** Port mappings allow only TCP, 1–65535; container ports and host ports must each be unique. */
function normalizePorts(input?: PortMapping[]): PortMapping[] {
  if (!input?.length) return [];
  if (!Array.isArray(input) || input.length > 8) {
    throw new PcsError(400, "INVALID_PORTS", "at most 8 port mappings are allowed");
  }
  const seenContainer = new Set<number>();
  const seenHost = new Set<number>();
  return input.map((p) => {
    const container = Number(p?.container);
    const host = Number(p?.host);
    if (
      !Number.isInteger(container) ||
      !Number.isInteger(host) ||
      container < 1 ||
      container > 65535 ||
      host < 1 ||
      host > 65535
    ) {
      throw new PcsError(400, "INVALID_PORTS", `port must be an integer between 1 and 65535: ${JSON.stringify(p)}`);
    }
    if (seenContainer.has(container) || seenHost.has(host)) {
      throw new PcsError(400, "INVALID_PORTS", `duplicate port: ${JSON.stringify(p)}`);
    }
    seenContainer.add(container);
    seenHost.add(host);
    return { container, host };
  });
}

function normalizeQuota(quota?: { rpm?: number; daily_calls?: number }): Record<string, number> {
  const out: Record<string, number> = {};
  if (quota?.rpm !== undefined) {
    const n = Number(quota.rpm);
    if (!Number.isInteger(n) || n <= 0) throw new PcsError(400, "INVALID_QUOTA", "rpm must be a positive integer");
    out.rpm = n;
  }
  if (quota?.daily_calls !== undefined) {
    const n = Number(quota.daily_calls);
    if (!Number.isInteger(n) || n <= 0) throw new PcsError(400, "INVALID_QUOTA", "daily_calls must be a positive integer");
    out.daily_calls = n;
  }
  return out;
}

function normalizeAgentProfile(row: any): AgentProfileRow {
  return {
    ...row,
    entrypoint: row.entrypoint ?? [],
    args: row.args ?? [],
    tool_api_profile_ids: row.tool_api_profile_ids ?? [],
    limits: row.limits ?? {},
    capabilities: row.capabilities ?? [],
    allowed_tools: row.allowed_tools ?? [],
    task_types: row.task_types ?? [],
    description: row.description ?? "",
    system_prompt: row.system_prompt ?? "",
    persona: row.persona ?? "",
    tone: row.tone ?? "",
    goals: row.goals ?? "",
  };
}

function normalizeApiProfile(row: any): ApiProfileRow {
  return {
    ...row,
    scopes: row.scopes ?? [],
    quota: row.quota ?? {},
    fallback: row.fallback ?? [],
  };
}

export interface EnrollInput {
  enrollment_token: string;
  hostname: string;
  os: string;
  arch: string;
  fingerprint: string;
  container_runtime: string;
  runtime_version: string;
  resources?: Record<string, unknown>;
  devices?: unknown[];
  tools?: unknown[];
}

export interface CreateDeploymentInput {
  host_id: string;
  instance_id?: string;
  role_id: string;
  display_name?: string;
  /** container = Docker container (default); native = the host runs the role process directly. */
  execution?: "container" | "native";
  /** native deployments have no image, so it may be omitted. */
  image?: string;
  resource_profile?: Partial<ResourceProfile>;
  env?: Record<string, string>;
  volumes?: Array<{ name: string; mount: string }>;
  ports?: PortMapping[];
  network_policy?: string;
  command?: string[];
  config_version?: number;
  /** Config files written into the container before startup; generated by the deployment plan and may be omitted on direct calls. */
  files?: Array<{ path: string; content: string }>;
  /** Variable names filled from the host-local credential file (names only). */
  agent_env?: string[];
  /** Capability score W; computed from capability_detail when not provided. */
  capability_score?: number;
  capability_detail?: CapabilityDetail;
  /** Scheduler identity. When omitted: root if the host has no root scheduler yet, otherwise it must be node. */
  scheduler_role?: "root" | "node";
  /** Root scheduler deployment mode; node schedulers and builders inherit it. */
  scheduling_mode?: "static" | "dynamic";
  /** The deployment_id of the parent scheduler for a node scheduler. */
  parent_scheduler_id?: string;
  /** Which scheduler the builder registers with (deployment_id); defaults to this host's root scheduler when omitted. */
  scheduler_id?: string;
  created_by: string;
}

export interface CreateDeploymentPlanInput {
  host_id: string;
  role_id: string;
  count?: number;
  instance_id?: string;
  display_name?: string;
  image?: string;
  /** Builder base OS, injected as the container env var BUILDER_OS. */
  builder_os?: string;
  agent_profile_id?: string | null;
  api_profile_ids?: string[];
  resource_profile?: Partial<ResourceProfile>;
  env?: Record<string, string>;
  volumes?: Array<{ name: string; mount: string }>;
  ports?: PortMapping[];
  network_policy?: string;
  command?: string[];
  config_version?: number;
  /** Builder capability score; the six detail values are weighted by the creating side, and the PCS only validates and freezes them here. */
  capability_score?: number;
  capability_detail?: CapabilityDetail;
  /** Scheduler identity: root = this host's root scheduler (at most one per host), node = a node hanging under a parent scheduler. */
  scheduler_role?: "root" | "node";
  /** Only meaningful for a root scheduler; node schedulers and builders inherit the root's mode. */
  scheduling_mode?: "static" | "dynamic";
  /** The parent scheduler's deployment_id for a node scheduler (must be on this host). */
  parent_scheduler_id?: string;
  /** The deployment_id of the scheduler the builder is associated with; defaults to this host's root scheduler when omitted. */
  scheduler_id?: string;
}

export interface DeploymentPlanItem {
  instance_id: string;
  display_name: string;
  role_id: string;
  image: string;
  resource_profile: ResourceProfile;
  env: Record<string, string>;
  volumes: Array<{ name: string; mount: string }>;
  ports: PortMapping[];
  network_policy: string;
  command: string[] | null;
  config_version: number;
  generation: number;
  agent_profile_id: string | null;
  api_profile_ids: string[];
  capability_score?: number;
  capability_detail?: CapabilityDetail;
  scheduler_role?: "root" | "node";
  parent_deployment_id?: string | null;
  scheduler_url?: string | null;
  scheduler_deployment_id?: string | null;
  files?: Array<{ path: string; content: string }>;
  agent_env?: string[];
}

export interface DeploymentPlanIntent {
  host_id: string;
  items: DeploymentPlanItem[];
}

export interface DeploymentPlanView {
  plan_id: string;
  plan_digest: string;
  host_id: string;
  host_name: string;
  host_state: string;
  role: string;
  names: string[];
  count: number;
  agent_profile_id: string | null;
  api_profile_ids: string[];
  resource_profile: Partial<ResourceProfile>;
  image: string;
  limits: { cpus: number; mem_mb: number; pids: number };
  network_policy: string;
  config_version: number;
  generation: number;
  budget_remaining_mb: number | null;
  interrupts_running: boolean;
  risk: "LOW" | "MEDIUM" | "HIGH";
  rollback_strategy: string;
  checks: Array<{ id: string; ok: boolean; detail: string }>;
  /** File contents are delivered with the signed command; they are not returned to the browser and do not enter the plan view. */
  items: Array<Omit<DeploymentPlanItem, "files" | "agent_env">>;
  created_at: string;
  expires_at: string;
}

export interface ApprovalTokenInput {
  approval_request_id: string;
  operator_id?: string;
  subject_digest?: string | null;
  action_scope?: string[];
  mfa_code?: string;
  task_id?: string;
}

export class PcsService {
  private readonly jwtPrivateKey: string;
  private readonly jwtPublicKey: string;
  private readonly commandPrivateKey: string;
  /** null when PCS_CREDENTIAL_KEY_FILE is unset: SSH host onboarding fails closed. */
  private readonly credentialKey: Buffer | null;
  /** Shared token schedulers use to report ΣW to each other; when unset, derived from the command signing private key, unchanged across restarts. */
  private readonly federationToken: string;

  constructor(readonly cfg: PcsConfig) {
    this.jwtPrivateKey = readKey(cfg.jwtPrivateKeyFile);
    this.jwtPublicKey = readKey(cfg.jwtPublicKeyFile);
    this.commandPrivateKey = readKey(cfg.commandPrivateKeyFile);
    this.credentialKey = loadCredentialKey(cfg.credentialKeyFile);
    this.federationToken =
      cfg.federationToken ??
      createHmac("sha256", this.commandPrivateKey).update("scheduler-federation").digest("hex");
  }

  // ---------------------------------------------------------------- Task attachments
  /**
   * Upload a task attachment and return a one-time URL the builder can download.
   *
   * Content does not enter the task JSON: the scheduler only forwards the URL, so polling the task list never moves large files repeatedly.
   * Only the token hash is stored; on expiry the token and content are cleaned up together.
   */
  async createTaskAttachment(input: {
    name?: unknown;
    media_type?: unknown;
    data_base64?: unknown;
  }): Promise<{
    attachment_id: string;
    name: string;
    media_type: string;
    size: number;
    url: string;
    expires_at: string;
  }> {
    const name = String(input.name ?? "").trim().slice(0, 200) || "attachment";
    const mediaType =
      String(input.media_type ?? "").trim().slice(0, 120) || "application/octet-stream";
    const raw = String(input.data_base64 ?? "").replace(/^data:[^,]*,/, "");
    if (!raw) throw new PcsError(400, "ATTACHMENT_EMPTY", "attachment content is empty");
    if (!/^[A-Za-z0-9+/=\r\n]+$/.test(raw)) {
      throw new PcsError(400, "ATTACHMENT_INVALID", "attachment must be base64");
    }
    const data = Buffer.from(raw, "base64");
    if (!data.length) throw new PcsError(400, "ATTACHMENT_EMPTY", "attachment content is empty");
    if (data.length > MAX_TASK_ATTACHMENT_BYTES) {
      throw new PcsError(413, "ATTACHMENT_TOO_LARGE", "attachment exceeds 24MiB");
    }

    const attachmentId = newId("att");
    const token = randomBytes(24).toString("base64url");
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const expiresAt = new Date(Date.now() + TASK_ATTACHMENT_TTL_MS);
    await query(
      `INSERT INTO pcs_task_attachments
         (attachment_id, token_hash, name, media_type, size_bytes, data, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [attachmentId, tokenHash, name, mediaType, data.length, data, expiresAt],
    );
    // Clean up expired attachments along the way, so no separate cleanup job is needed between these runs.
    await query(`DELETE FROM pcs_task_attachments WHERE expires_at < now()`);

    const base = (
      this.cfg.runtimeUrl ??
      this.cfg.publicUrl ??
      `http://127.0.0.1:${this.cfg.port}`
    ).replace(/\/+$/, "");
    return {
      attachment_id: attachmentId,
      name,
      media_type: mediaType,
      size: data.length,
      url: `${base}/api/v1/platform/attachments/${encodeURIComponent(attachmentId)}?token=${encodeURIComponent(token)}`,
      expires_at: expiresAt.toISOString(),
    };
  }

  /** The builder fetches attachment content with a one-time token; a wrong or expired token is treated as not found. */
  async getTaskAttachment(
    attachmentId: string,
    token: string,
  ): Promise<{ name: string; media_type: string; data: Buffer }> {
    const row = (
      await query<{
        name: string;
        media_type: string;
        token_hash: string;
        data: Buffer;
      }>(
        `SELECT name, media_type, token_hash, data
           FROM pcs_task_attachments
          WHERE attachment_id = $1 AND expires_at > now()`,
        [attachmentId],
      )
    ).rows[0];
    if (!row) throw notFound("ATTACHMENT_NOT_FOUND", "attachment not found or expired");
    const want = createHash("sha256").update(token).digest("hex");
    const ok =
      row.token_hash.length === want.length &&
      timingSafeEqual(Buffer.from(row.token_hash), Buffer.from(want));
    if (!ok) throw forbidden("ATTACHMENT_TOKEN_INVALID", "invalid attachment token");
    return { name: row.name, media_type: row.media_type, data: row.data };
  }

  // ---------------------------------------------------------------- Identity

  /** Admin tokens are issued by the CLI with the same JWT private key; the PCS only verifies the signature and checks scopes. */
  authenticateAdmin(token: string, scope: string): JwtClaims {
    const claims = verifyJwt(token, this.jwtPublicKey, {
      audience: ADMIN_AUDIENCE,
      typ: "admin",
    });
    requireClaimScope(claims, scope);
    return claims;
  }

  async authenticateHost(token: string): Promise<HostRow> {
    const claims = verifyJwt(token, this.jwtPublicKey, {
      audience: RUNTIME_AUDIENCE,
      typ: "host",
    });
    const host = await this.getHost(String(claims.sub ?? ""));
    if (!host) throw new PcsError(401, "TOKEN_INVALID", "host not found");
    if (host.status === "REVOKED") {
      throw forbidden("HOST_REVOKED", "host has been revoked: all commands and new containers are rejected");
    }
    return host;
  }

  issueHostToken(hostId: string): { host_token: string; expires_at: string } {
    const iat = Math.floor(nowMs() / 1000);
    const exp = iat + this.cfg.hostTokenHours * 3600;
    const host_token = signJwt(
      {
        iss: ISSUER,
        aud: RUNTIME_AUDIENCE,
        sub: hostId,
        host_id: hostId,
        typ: "host",
        scopes: HOST_SCOPES,
        iat,
        exp,
        jti: newId("tok"),
      },
      this.jwtPrivateKey,
    );
    return { host_token, expires_at: iso(exp * 1000) };
  }

  /** The CLI uses the same set of claims, avoiding a second admin authentication scheme. */
  issueAdminToken(operator: string, hours = 8, scopes = ADMIN_SCOPES): string {
    const iat = Math.floor(nowMs() / 1000);
    return signJwt(
      {
        iss: ISSUER,
        aud: ADMIN_AUDIENCE,
        sub: `operator:${operator}`,
        typ: "admin",
        operator_id: operator,
        scopes,
        iat,
        exp: iat + hours * 3600,
        jti: newId("tok"),
      },
      this.jwtPrivateKey,
    );
  }

  // ---------------------------------------------------------------- Hosts

  async createHost(input: { name: string; labels?: Record<string, unknown> }): Promise<{
    host_id: string;
    enrollment_token: string;
    expires_at: string;
  }> {
    if (!input.name?.trim()) throw new PcsError(400, "INVALID_HOST", "host display name is required");
    const hostId = newId("hst");
    const token = `enr_${randomBytes(24).toString("base64url")}`;
    const expiresAt = iso(nowMs() + this.cfg.enrollmentTtlSeconds * 1000);

    await tx(async (c) => {
      await c.query(
        `INSERT INTO pcs_hosts (host_id, hostname, status, labels)
         VALUES ($1,$2,'PENDING',$3)`,
        [hostId, input.name.trim(), JSON.stringify(input.labels ?? {})],
      );
      await c.query(
        `INSERT INTO pcs_enrollment_tokens (token_hash, host_id, expires_at)
         VALUES ($1,$2,$3)`,
        [hashToken(token), hostId, expiresAt],
      );
    });
    return { host_id: hostId, enrollment_token: token, expires_at: expiresAt };
  }

  async enroll(input: EnrollInput): Promise<{
    host_id: string;
    host_token: string;
    expires_at: string;
    command_public_key: string;
  }> {
    if (!input.enrollment_token) throw new PcsError(400, "ENROLLMENT_TOKEN_REQUIRED", "enrollment token is required");
    for (const field of ["hostname", "os", "arch", "fingerprint"] as const) {
      if (!input[field]?.trim()) throw new PcsError(400, "INVALID_HOST", `${field} is required`);
    }

    const hostId = await tx(async (c) => {
      const rows = (
        await c.query(
          `SELECT t.token_hash, t.host_id, t.expires_at, t.used_at
             FROM pcs_enrollment_tokens t
            WHERE t.token_hash = $1
            FOR UPDATE`,
          [hashToken(input.enrollment_token)],
        )
      ).rows;
      const tok = rows[0];
      if (!tok) throw new PcsError(401, "ENROLLMENT_TOKEN_INVALID", "invalid enrollment token");
      if (tok.used_at) throw conflict("ENROLLMENT_TOKEN_USED", "enrollment token has already been used");
      if (new Date(tok.expires_at).getTime() <= nowMs()) {
        throw new PcsError(401, "ENROLLMENT_TOKEN_EXPIRED", "enrollment token has expired");
      }

      await c.query(`UPDATE pcs_enrollment_tokens SET used_at = now() WHERE token_hash = $1`, [
        tok.token_hash,
      ]);
      await c.query(
        `UPDATE pcs_hosts
            SET hostname = CASE WHEN hostname IS NULL OR hostname = '' THEN $2 ELSE hostname END,
                os=$3, arch=$4, fingerprint=$5, status='ENROLLED',
                resources=$6, devices=$7, tools=$8, enrolled_at=now(), updated_at=now()
          WHERE host_id=$1`,
        [
          tok.host_id,
          input.hostname,
          input.os,
          input.arch,
          input.fingerprint,
          JSON.stringify(input.resources ?? {}),
          JSON.stringify(input.devices ?? []),
          JSON.stringify(input.tools ?? []),
        ],
      );
      await c.query(
        `INSERT INTO pcs_host_runtimes (host_id, runtime_version, container_runtime, healthy)
         VALUES ($1,$2,$3,true)
         ON CONFLICT (host_id) DO UPDATE
           SET runtime_version=EXCLUDED.runtime_version,
               container_runtime=EXCLUDED.container_runtime,
               healthy=true, updated_at=now()`,
        [tok.host_id, input.runtime_version, input.container_runtime],
      );
      return tok.host_id as string;
    });

    const token = this.issueHostToken(hostId);
    return {
      host_id: hostId,
      host_token: token.host_token,
      expires_at: token.expires_at,
      command_public_key: readKey(this.cfg.commandPublicKeyFile),
    };
  }

  async getHost(hostId: string): Promise<HostRow | null> {
    const r = await query<HostRow>(`SELECT * FROM pcs_hosts WHERE host_id=$1`, [hostId]);
    return r.rows[0] ?? null;
  }

  /**
   * Add an SSH host: persist it first (along with the encrypted private key), then probe once.
   * A failed probe does not delete the host — if the credential was wrong, the user can fix the address/retry on the detail page instead of re-entering it.
   */
  async createSshHost(input: {
    name?: string;
    address: string;
    port?: number;
    user?: string;
    /** Private-key auth; choose one of this and password. */
    private_key?: string;
    /** Password auth; choose one of this and private_key. */
    password?: string;
    labels?: Record<string, unknown>;
  }): Promise<{
    host_id: string;
    transport: "ssh";
    auth_type: "key" | "password";
    key_fingerprint: string | null;
    probe: SshProbe;
  }> {
    const key = this.requireCredentialKey();
    const address = String(input.address ?? "").trim();
    const user = String(input.user ?? "root").trim();
    const port = Number(input.port ?? 22);
    const name = String(input.name ?? "").trim() || address;

    if (!isSafeHost(address)) {
      throw new PcsError(400, "INVALID_HOST_ADDRESS", "the address must be a hostname or IP without scheme, path, or spaces");
    }
    if (!/^[a-z_][a-z0-9_-]{0,31}$/i.test(user)) {
      throw new PcsError(400, "INVALID_SSH_USER", "invalid SSH username");
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new PcsError(400, "INVALID_SSH_PORT", "SSH port must be between 1 and 65535");
    }
    const privateKey = (input.private_key ?? "").trim();
    const password = input.password ?? "";
    const authType = resolveAuthType(privateKey, password);

    const sealed = sealSecret(
      key,
      authType === "key" ? privateKey + "\n" : password,
    );
    const fingerprint = authType === "key" ? secretFingerprint(privateKey) : null;

    // When a host previously removed from the list (REVOKED) is onboarded again, reuse the original record:
    // its containers, deployments, and data are still there, and it can continue after re-bootstrapping without redeploying.
    const prior = await query<{ host_id: string }>(
      `SELECT c.host_id FROM pcs_host_credentials c
         JOIN pcs_hosts h ON h.host_id = c.host_id
        WHERE c.transport='ssh' AND c.address=$1 AND c.ssh_port=$2 AND c.ssh_user=$3
          AND h.status='REVOKED'
        ORDER BY h.updated_at DESC
        LIMIT 1`,
      [address, port, user],
    );
    if (prior.rows[0]) {
      const hostId = prior.rows[0].host_id;
      await tx(async (c) => {
        await c.query(
          `UPDATE pcs_hosts
              SET hostname=$2, status='PENDING', labels = labels || $3::jsonb, updated_at=now()
            WHERE host_id=$1`,
          [hostId, name, JSON.stringify(input.labels ?? {})],
        );
        await c.query(
          `UPDATE pcs_host_credentials
              SET auth_type=$2, key_ciphertext=$3, key_iv=$4, key_tag=$5,
                  key_fingerprint=$6, updated_at=now()
            WHERE host_id=$1`,
          [hostId, authType, sealed.ciphertext, sealed.iv, sealed.tag, fingerprint],
        );
      });
      return {
        host_id: hostId,
        transport: "ssh",
        auth_type: authType,
        key_fingerprint: fingerprint,
        probe: await this.probeHost(hostId),
      };
    }

    const hostId = newId("hst");

    await tx(async (c) => {
      await c.query(
        `INSERT INTO pcs_hosts (host_id, hostname, status, labels)
         VALUES ($1,$2,'PENDING',$3)`,
        [hostId, name, JSON.stringify(input.labels ?? {})],
      );
      await c.query(
        `INSERT INTO pcs_host_credentials
           (host_id, transport, address, ssh_port, ssh_user, auth_type,
            key_ciphertext, key_iv, key_tag, key_fingerprint)
         VALUES ($1,'ssh',$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          hostId,
          address,
          port,
          user,
          authType,
          sealed.ciphertext,
          sealed.iv,
          sealed.tag,
          fingerprint,
        ],
      );
    });

    const probe = await this.probeHost(hostId);
    return {
      host_id: hostId,
      transport: "ssh",
      auth_type: authType,
      key_fingerprint: fingerprint,
      probe,
    };
  }

  /**
   * Update host access info: display name, address, port, user, private key.
   * Leaving the private key blank means no change; address, port, and user are also updated only when provided.
   * Used to correct a wrong key or a changed address in place, without deleting and re-adding.
   */
  async updateHost(
    hostId: string,
    input: {
      name?: string;
      address?: string;
      port?: number;
      user?: string;
      private_key?: string;
      password?: string;
      /** The host's own role: container host / bare-metal builder / bare-metal scheduler, one of three. */
      role_mode?: "containers" | "builder" | "scheduler";
    },
    operator = "system",
  ): Promise<{
    host_id: string;
    transport: "local" | "ssh";
    auth_type: "key" | "password" | null;
    key_fingerprint: string | null;
    probe: SshProbe;
    role_mode?: "containers" | "builder" | "scheduler";
    native_builder?: { deployment_id: string; created: boolean; status: string };
    warning?: string;
  }> {
    const cred = await this.getHostCredential(hostId);
    if (!cred) throw notFound("HOST_NOT_FOUND", "host not found");
    const before = await this.getHost(hostId);
    const previousRole = before?.role_mode ?? "containers";

    if (input.role_mode !== undefined) {
      if (!["containers", "builder", "scheduler"].includes(input.role_mode)) {
        throw new PcsError(400, "INVALID_HOST_ROLE", "role_mode must be one of containers / builder / scheduler");
      }
      // Bare-metal roles and containers are mutually exclusive: if containers are still running, have the user resolve that first, avoiding silently killing working instances.
      if (input.role_mode !== previousRole) {
        const active = await query<{ instance_id: string; role_id: string; execution: string }>(
          `SELECT instance_id, role_id, execution FROM pcs_deployments
            WHERE host_id=$1 AND status <> 'REMOVED'
            ORDER BY created_at DESC`,
          [hostId],
        );
        if (input.role_mode === "builder") {
          const containers = active.rows.filter((d) => d.execution !== "native");
          if (containers.length) {
            throw conflict(
              "HOST_HAS_CONTAINER_DEPLOYMENTS",
              "the host still has container instances; remove them before switching to a bare-metal builder",
              { deployments: containers.map((d) => `${d.instance_id} (${d.role_id})`) },
            );
          }
        }
        if (input.role_mode === "scheduler") {
          throw conflict(
            "NATIVE_SCHEDULER_NOT_SUPPORTED",
            "bare-metal schedulers have no execution path yet; only bare-metal builders are supported",
          );
        }
      }
      await query(`UPDATE pcs_hosts SET role_mode=$2, updated_at=now() WHERE host_id=$1`, [
        hostId,
        input.role_mode,
      ]);
    }

    const name = typeof input.name === "string" ? input.name.trim() : "";
    const address = typeof input.address === "string" ? input.address.trim() : "";
    const user = typeof input.user === "string" ? input.user.trim() : "";
    const privateKey =
      typeof input.private_key === "string" ? input.private_key.trim() : "";
    const password = typeof input.password === "string" ? input.password : "";

    if (cred.transport === "local") {
      if (address || user || privateKey || password || input.port !== undefined) {
        throw new PcsError(400, "HOST_NOT_SSH", "the local host does not need an address, port, or credentials");
      }
      if (name) {
        await query(`UPDATE pcs_hosts SET hostname=$2, updated_at=now() WHERE host_id=$1`, [
          hostId,
          name,
        ]);
      }
      const probe = await this.probeHost(hostId);
      return {
        host_id: hostId,
        transport: "local",
        auth_type: null,
        key_fingerprint: cred.key_fingerprint,
        probe,
        ...(input.role_mode ? { role_mode: input.role_mode } : {}),
        ...(await this.afterRoleModeChange(hostId, previousRole, input.role_mode, operator)),
      };
    }

    const nextAddress = address || cred.address || "";
    const nextUser = user || cred.ssh_user || "root";
    const nextPort = input.port === undefined ? cred.ssh_port : Number(input.port);

    if (!isSafeHost(nextAddress)) {
      throw new PcsError(400, "INVALID_HOST_ADDRESS", "the address must be a hostname or IP without scheme, path, or spaces");
    }
    if (!/^[a-z_][a-z0-9_-]{0,31}$/i.test(nextUser)) {
      throw new PcsError(400, "INVALID_SSH_USER", "invalid SSH username");
    }
    if (!Number.isInteger(nextPort) || nextPort < 1 || nextPort > 65535) {
      throw new PcsError(400, "INVALID_SSH_PORT", "SSH port must be between 1 and 65535");
    }
    const nextAuth = resolveAuthType(privateKey, password, { optional: true });
    const sealed = nextAuth
      ? sealSecret(
          this.requireCredentialKey(),
          nextAuth === "key" ? privateKey + "\n" : password,
        )
      : null;
    const fingerprint = !nextAuth
      ? cred.key_fingerprint
      : nextAuth === "key"
        ? secretFingerprint(privateKey)
        : null;

    await tx(async (c) => {
      if (name) {
        await c.query(`UPDATE pcs_hosts SET hostname=$2, updated_at=now() WHERE host_id=$1`, [
          hostId,
          name,
        ]);
      }
      if (sealed && nextAuth) {
        await c.query(
          `UPDATE pcs_host_credentials
              SET address=$2, ssh_port=$3, ssh_user=$4, auth_type=$5,
                  key_ciphertext=$6, key_iv=$7, key_tag=$8, key_fingerprint=$9,
                  updated_at=now()
            WHERE host_id=$1`,
          [
            hostId,
            nextAddress,
            nextPort,
            nextUser,
            nextAuth,
            sealed.ciphertext,
            sealed.iv,
            sealed.tag,
            fingerprint,
          ],
        );
      } else {
        await c.query(
          `UPDATE pcs_host_credentials
              SET address=$2, ssh_port=$3, ssh_user=$4, updated_at=now()
            WHERE host_id=$1`,
          [hostId, nextAddress, nextPort, nextUser],
        );
      }
    });

    const probe = await this.probeHost(hostId);
    return {
      host_id: hostId,
      transport: "ssh",
      auth_type: nextAuth ?? cred.auth_type ?? "key",
      key_fingerprint: fingerprint,
      probe,
      ...(input.role_mode ? { role_mode: input.role_mode } : {}),
      ...(await this.afterRoleModeChange(hostId, previousRole, input.role_mode, operator)),
    };
  }

  /**
   * Follow-up after a role switch: when switching to a bare-metal builder, ensure the host has a builder process;
   * when switching back to container host, remove the bare-metal builder. Failures return only a warning and do not roll back the role itself.
   */
  private async afterRoleModeChange(
    hostId: string,
    previous: "containers" | "builder" | "scheduler",
    next: "containers" | "builder" | "scheduler" | undefined,
    operator: string,
  ): Promise<{
    native_builder?: { deployment_id: string; created: boolean; status: string };
    warning?: string;
  }> {
    if (!next || next === previous) return {};
    if (next === "builder") {
      try {
        return { native_builder: await this.ensureNativeBuilder(hostId, operator) };
      } catch (e) {
        return { warning: e instanceof Error ? e.message : String(e) };
      }
    }
    if (previous === "builder") {
      try {
        await this.removeNativeBuilders(hostId, operator);
      } catch (e) {
        return { warning: e instanceof Error ? e.message : String(e) };
      }
    }
    return {};
  }

  private async activeNativeBuilders(hostId: string): Promise<DeploymentRow[]> {
    const r = await query<DeploymentRow>(
      `SELECT * FROM pcs_deployments
        WHERE host_id=$1 AND role_id='builder' AND execution='native' AND status <> 'REMOVED'
        ORDER BY created_at DESC`,
      [hostId],
    );
    return r.rows;
  }

  /**
   * Connect a host already marked as a "bare-metal builder" to scheduling: ensure there is exactly one native
   * builder deployment. Repeated calls are idempotent; when the host is offline, the command waits for it to rejoin.
   */
  async ensureNativeBuilder(
    hostId: string,
    operator: string,
  ): Promise<{ deployment_id: string; created: boolean; status: string }> {
    const host = await this.getHost(hostId);
    if (!host) throw notFound("HOST_NOT_FOUND", "host not found");
    if (host.role_mode !== "builder") {
      throw conflict("HOST_NOT_NATIVE_BUILDER", "first set the host role to bare-metal builder");
    }
    const existing = (await this.activeNativeBuilders(hostId))[0];
    if (existing && existing.status !== "FAILED" && existing.actual_state !== "MISSING") {
      if (existing.desired_state === "STOPPED") {
        await this.enqueueAction(existing.deployment_id, "start", operator).catch(() => undefined);
      }
      return {
        deployment_id: existing.deployment_id,
        created: false,
        status: existing.status,
      };
    }
    // FAILED / MISSING: the local desired state may be gone after a host reinstall or rebuild, and RESTART does not carry
    // an InstanceSpec, so a full DEPLOY must be sent again. createDeployment marks the old record for the same
    // instance as REMOVED, and the new deployment takes over.

    const active = await this.activeSchedulers(hostId);
    const schedulerRef =
      active.find((d) => (d.scheduler_role ?? "root") === "root") ?? active[0] ?? null;
    const schedulerUrl =
      schedulerRef?.scheduler_url ??
      this.cfg.schedulerUrls[hostId] ??
      this.cfg.schedulerUrl;
    if (!schedulerUrl) {
      throw new PcsError(
        409,
        "SCHEDULER_URL_MISSING",
        "a bare-metal builder needs a scheduler address: deploy a scheduler first, or set PCS_SCHEDULER_URL",
      );
    }

    // Bind a builder Agent that can be delivered with the deployment; deterministic subtasks can still run when no Profile is available.
    let agent: AgentProfileRow | null = null;
    let delivery: ReturnType<PcsService["agentDelivery"]> | null = null;
    for (const candidate of await this.listAgentProfiles()) {
      if (candidate.role_id !== "builder" || !candidate.enabled) continue;
      try {
        const out = this.agentDelivery(candidate, "builder", "native-builder");
        agent = candidate;
        delivery = out;
        break;
      } catch {
        // A Profile that references the Secret Store cannot be delivered with the deployment, so try the next one.
      }
    }

    const resources = (host.resources ?? {}) as Record<string, any>;
    const disks = Array.isArray(resources.disk) ? resources.disk : [];
    const disk = disks.find((d: any) => d.fs === "root") ?? disks[0] ?? {};
    const memTotal = Number(resources.mem_total_bytes) || 2 * 1024 ** 3;
    const detail: CapabilityDetail = {
      cores: Math.max(1, Number(resources.cpu_count) || 1),
      mem_gb: Math.round(memTotal / 1024 ** 3),
      ...(Number(disk.total_bytes) > 0
        ? { disk_gb: Math.round(Number(disk.total_bytes) / 1024 ** 3) }
        : {}),
    };
    const capability = resolveCapability({ capability_detail: detail });
    const cpu = Math.max(1, Number(resources.cpu_count) || 1);
    // Bare-metal processes cannot be hard-capped like containers; use half a host as the admission budget, so the whole machine is not fully booked.
    const memoryLimit = Math.max(
      2 * 1024 ** 3,
      Math.min(Math.round(memTotal * 0.5), 16 * 1024 ** 3),
    );

    const env: Record<string, string> = {
      INSTANCE_ID: "native-builder",
      ROLE_ID: "builder",
      HOST_ID: hostId,
      BUILDER_OS: host.os || "linux",
      SCHEDULER_URL: schedulerUrl,
      CAPABILITY_SCORE: String(capability.score),
      ...(Object.keys(capability.detail).length
        ? { CAPABILITY_DETAIL: JSON.stringify(capability.detail) }
        : {}),
      // Native processes have no cgroup pool, so they always run in static mode; the budget below is
      // enforced by the builder's own admission rather than by the kernel.
      SCHEDULING_MODE: "static",
      RESOURCE_CPU_MILLICORES: String(Math.round(cpu * 1000)),
      RESOURCE_MEMORY_BYTES: String(memoryLimit),
      MAX_CONCURRENCY: "1",
      ...(delivery?.env ?? {}),
    };
    const files = [
      ...(delivery?.files ?? []),
      ...this.roleAppFiles("builder"),
    ];

    const { deployment } = await this.createDeployment({
      host_id: hostId,
      instance_id: "native-builder",
      role_id: "builder",
      display_name: host.hostname || "native-builder",
      execution: "native",
      resource_profile: {
        cpu_limit: cpu,
        memory_limit_bytes: memoryLimit,
        pids_limit: 4096,
      },
      env,
      ports: [],
      volumes: [],
      network_policy: "default",
      files,
      ...(delivery ? { agent_env: delivery.agent_env } : {}),
      scheduler_id: schedulerRef?.deployment_id,
      capability_score: capability.score,
      capability_detail: capability.detail,
      config_version: 1,
      created_by: operator,
    });

    if (agent && delivery) {
      await this.bindAgent(hostId, "native-builder", agent.agent_profile_id, "builder", operator)
        .catch(() => undefined);
    }
    await this.audit(operator, "host.native_builder.ensure", deployment.deployment_id, "native-builder", {
      host_id: hostId,
      scheduler_url: schedulerUrl,
      agent_profile_id: agent?.agent_profile_id ?? null,
    });
    console.log(`[audit] native builder ${hostId}/${deployment.deployment_id} by ${operator}`);
    return {
      deployment_id: deployment.deployment_id,
      created: true,
      status: deployment.status,
    };
  }

  /** Remove the bare-metal builder when the role switches back to container host; delete only this deployment layer and leave other files on the host untouched. */
  private async removeNativeBuilders(hostId: string, operator: string): Promise<void> {
    for (const dep of await this.activeNativeBuilders(hostId)) {
      if (dep.desired_state === "REMOVED") continue;
      await this.enqueueAction(dep.deployment_id, "remove", operator);
    }
  }

  /** Local host: the machine running the PCS; no SSH or private key needed. */
  async createLocalHost(input: { name?: string } = {}): Promise<{
    host_id: string;
    transport: "local";
    probe: SshProbe;
    created: boolean;
  }> {
    const existing = await query<{ host_id: string }>(
      `SELECT host_id FROM pcs_host_credentials WHERE transport='local' LIMIT 1`,
    );
    if (existing.rows[0]) {
      const hostId = existing.rows[0].host_id;
      // Removing from the list is only a revocation; re-adding the local host revives the original record, and its containers and data keep working.
      await query(
        `UPDATE pcs_hosts SET status='PENDING', updated_at=now()
          WHERE host_id=$1 AND status='REVOKED'`,
        [hostId],
      );
      const probe = await this.probeHost(hostId);
      return { host_id: hostId, transport: "local", probe, created: false };
    }
    const hostId = newId("hst");
    const name = String(input.name ?? "").trim() || "local host";
    await tx(async (c) => {
      await c.query(
        `INSERT INTO pcs_hosts (host_id, hostname, status, labels)
         VALUES ($1,$2,'PENDING',$3)`,
        [hostId, name, JSON.stringify({ local: true })],
      );
      await c.query(
        `INSERT INTO pcs_host_credentials (host_id, transport, address, ssh_port)
         VALUES ($1,'local','127.0.0.1',22)`,
        [hostId],
      );
    });
    return { host_id: hostId, transport: "local", probe: await this.probeHost(hostId), created: true };
  }

  /** Probe connectivity and record the result; the result is also written into the UI's last_probe. */
  async probeHost(hostId: string): Promise<SshProbe> {
    const cred = await this.getHostCredential(hostId);
    if (!cred) throw notFound("HOST_TRANSPORT_UNKNOWN", "host has no access information");
    let probe: SshProbe;
    if (cred.transport === "local") {
      probe = await probeLocal();
    } else {
      probe = await probeSsh(await this.sshTarget(hostId));
    }
    await query(
      `UPDATE pcs_host_credentials
          SET last_probe=$2, last_probe_at=now(), updated_at=now()
        WHERE host_id=$1`,
      [hostId, JSON.stringify(probe)],
    );
    return probe;
  }

  async getHostCredential(hostId: string): Promise<HostCredentialRow | null> {
    const r = await query<HostCredentialRow>(
      `SELECT host_id, transport, address, ssh_port, ssh_user, auth_type,
              key_fingerprint, last_probe, last_probe_at
         FROM pcs_host_credentials WHERE host_id=$1`,
      [hostId],
    );
    return r.rows[0] ?? null;
  }

  /**
   * Target of the interactive terminal: which host the instance is on and what the container is called.
   *
   * The terminal is a root shell used directly by administrators and bypasses the scheduling queue; this only resolves
   * (host_id, instance_id) into a container endpoint, while the caller (admin token + one-time ticket) handles
   * authentication and no command review is performed.
   */
  async terminalTarget(
    hostId: string,
    instanceId: string,
  ): Promise<{
    transport: "local" | "ssh";
    container: string;
    ssh?: SshTarget;
    /** native instances have no container; the terminal lands directly in the host shell. */
    native?: boolean;
  }> {
    const r = await query<{ desired_state: string; status: string; execution: string | null }>(
      `SELECT desired_state, status, execution FROM pcs_deployments
        WHERE host_id=$1 AND instance_id=$2
        ORDER BY generation DESC, created_at DESC LIMIT 1`,
      [hostId, instanceId],
    );
    const dep = r.rows[0];
    if (!dep) throw notFound("DEPLOYMENT_NOT_FOUND", "no such instance on this host");
    if (dep.desired_state === "REMOVED" || dep.status === "REMOVED") {
      throw notFound("DEPLOYMENT_REMOVED", "instance has been removed");
    }
    if (
      dep.desired_state !== "RUNNING" ||
      dep.status === "STOPPED" ||
      dep.status === "ROLLED_BACK"
    ) {
      throw conflict("INSTANCE_STOPPED", "instance is not running; start it before opening a terminal");
    }
    // Keep in sync with containerName in host-runtime/src/container-spec.ts.
    const container = `platform-${instanceId.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 48)}`;
    const native = dep.execution === "native";
    const cred = await this.getHostCredential(hostId);
    if (cred?.transport === "ssh") {
      return { transport: "ssh", container, native, ssh: await this.sshTarget(hostId) };
    }
    return { transport: "local", container, native };
  }

  /** Host detail: the host row + access mode (without key plaintext) + the deployments on that host. */
  async getHostDetail(hostId: string): Promise<{
    host: unknown;
    credential: HostCredentialRow | null;
    deployments: unknown[];
  } | null> {
    const rows = await query(
      `SELECT h.*,
              rt.runtime_version, rt.container_runtime, rt.healthy AS runtime_healthy,
              rt.updated_at AS runtime_updated_at,
              rep.payload AS last_report, rep.received_at AS last_report_at
         FROM pcs_hosts h
         LEFT JOIN pcs_host_runtimes rt USING (host_id)
         LEFT JOIN pcs_host_reports rep USING (host_id)
        WHERE h.host_id=$1`,
      [hostId],
    );
    const host = rows.rows[0];
    if (!host) return null;
    return {
      host,
      credential: await this.getHostCredential(hostId),
      deployments: await this.listDeployments(hostId),
    };
  }

  /**
   * SSH bootstrap: write host-runtime to the host and start it, then wait for it to join.
   * Local hosts use the PCS's own node process; remote hosts require node >= 22.
   */
  async bootstrapHost(
    hostId: string,
    operator: string,
  ): Promise<{
    host_id: string;
    transport: "local" | "ssh";
    status: string;
    online: boolean;
    log?: string;
    native_builder?: { deployment_id: string; created: boolean; status: string };
    warning?: string;
  }> {
    const host = await this.getHost(hostId);
    if (!host) throw notFound("HOST_NOT_FOUND", "host not found");
    if (host.status === "REVOKED") throw forbidden("HOST_REVOKED", "host has been revoked and cannot be bootstrapped");
    const cred = await this.getHostCredential(hostId);
    if (!cred) throw notFound("HOST_TRANSPORT_UNKNOWN", "host has no access information");
    const dockerRequired = (host.role_mode ?? "containers") === "containers";

    const pcsUrl =
      cred.transport === "local" ? `http://127.0.0.1:${this.cfg.port}` : this.cfg.runtimeUrl;
    if (!pcsUrl) {
      throw new PcsError(
        409,
        "RUNTIME_URL_MISSING",
        "remote hosts require PCS_RUNTIME_URL; set it to a PCS address this host can reach",
      );
    }

    // For SSH hosts, provision Node 22 / Docker first: the user provides credentials once, and the platform installs the environment.
    const nodePath =
      cred.transport === "local"
        ? process.execPath
        : await this.ensureRemoteEnvironment(
            await this.sshTarget(hostId),
            this.cfg.runtimeNode,
            dockerRequired,
          );

    const [bundle, enrollmentToken] = await Promise.all([
      ensureRuntimeBundle(),
      this.mintEnrollmentToken(hostId),
    ]);
    const script = buildBootstrapScript({
      hostId,
      nodePath,
      pcsUrl,
      enrollmentToken,
      commandPublicKey: readKey(this.cfg.commandPublicKeyFile),
      imageAllowlist: this.cfg.imageAllowlist,
      networkPolicies: this.cfg.networkPolicies,
      networkPolicyMap: this.cfg.networkPolicyMap,
      runtimeBundle: { runtime: bundle.runtime, watchdog: bundle.watchdog },
      agentEnvContent: this.readAgentEnvFile(),
      agentEnvSource: this.cfg.agentEnvFile ?? undefined,
      dockerRequired,
    });

    const result =
      cred.transport === "local"
        ? await runLocalBootstrap(script, 45_000)
        // The bootstrap script embeds the runtime bundle and exceeds the single-argv length limit (E2BIG);
        // pass it to the remote sh via stdin. Password auth goes through SSH_ASKPASS and does not occupy stdin.
        : await execSsh(await this.sshTarget(hostId), "sh -s", {
            input: script,
            timeoutMs: 45_000,
          });
    if (result.code !== 0) {
      const detail = (result.stderr || result.stdout).trim().slice(-800);
      throw new PcsError(
        502,
        "BOOTSTRAP_FAILED",
        detail || `bootstrap script exited with code ${result.code}`,
      );
    }

    // Joining is asynchronous: runtime enrolls immediately after startup, and the first heartbeat then pushes the status to ONLINE.
    const deadline = nowMs() + 20_000;
    let latest = host;
    while (nowMs() < deadline) {
      await new Promise((r) => setTimeout(r, 1000));
      const cur = await this.getHost(hostId);
      if (!cur) break;
      latest = cur;
      if (cur.status === "ONLINE" || cur.status === "DEGRADED") break;
    }
    const online = latest.status === "ONLINE" || latest.status === "DEGRADED";
    console.log(`[audit] bootstrap host ${hostId} by ${operator}: ${latest.status}`);
    let native:
      | { native_builder?: { deployment_id: string; created: boolean; status: string }; warning?: string }
      | undefined;
    if (online && latest.role_mode === "builder") {
      try {
        native = { native_builder: await this.ensureNativeBuilder(hostId, operator) };
      } catch (e) {
        native = { warning: e instanceof Error ? e.message : String(e) };
      }
    }
    return {
      host_id: hostId,
      transport: cred.transport,
      status: latest.status,
      online,
      log: online ? undefined : await this.bootstrapLog(hostId, cred.transport),
      ...(native ?? {}),
    };
  }

  /** Carry model credentials to the target host during bootstrap; skip if the file does not exist, and deployment reports exactly which variable is missing. */
  private readAgentEnvFile(): string | undefined {
    const file = this.cfg.agentEnvFile;
    if (!file) return undefined;
    if (!fs.existsSync(file)) {
      console.log(`[bootstrap] No host credential file ${file}: instances bound to a model will refuse to start without a key`);
      return undefined;
    }
    return fs.readFileSync(file, "utf8");
  }

  /**
   * Remote environment setup: install Node 22 into $HOME/opt if missing, and install docker.io with the same password
   * (passed to sudo -S via stdin) if Docker is missing. Returns the Node path the bootstrap script will use.
   */
  private async ensureRemoteEnvironment(
    target: SshTarget,
    configuredNode: string,
    dockerRequired = true,
  ): Promise<string> {
    const script = buildEnvSetupScript({ nodePath: configuredNode, dockerRequired });
    const result = await execSsh(target, script, {
      // The password goes only through stdin: never in argv or logs; with no password, the script explicitly reports what is missing.
      input: target.password ? `${target.password}\n` : undefined,
      timeoutMs: 600_000,
    });
    const out = `${result.stdout}\n${result.stderr}`;
    const failure = /^PCS_ENV_ERROR=(.+)$/m.exec(out);
    if (failure) {
      throw new PcsError(502, "BOOTSTRAP_ENV_FAILED", failure[1].trim());
    }
    if (result.code === 124) {
      throw new PcsError(
        502,
        "BOOTSTRAP_ENV_FAILED",
        "remote environment setup timed out (10 minutes): check the target host network and apt sources",
      );
    }
    const node = /^PCS_NODE_PATH=(.+)$/m.exec(out);
    if (result.code !== 0 || !node) {
      const detail = out.trim().split(/\r?\n/).slice(-6).join("\n").slice(-800);
      throw new PcsError(
        502,
        "BOOTSTRAP_ENV_FAILED",
        detail || `environment setup script exited with code ${result.code}`,
      );
    }
    return node[1].trim();
  }

  private async bootstrapLog(
    hostId: string,
    transport: "local" | "ssh",
  ): Promise<string | undefined> {
    try {
      if (transport === "local") {
        const file = path.join(
          os.homedir(),
          ".platform",
          "host-runtime",
          hostId,
          "logs",
          "runtime.log",
        );
        if (!fs.existsSync(file)) return undefined;
        return fs.readFileSync(file, "utf8").split(/\r?\n/).slice(-20).join("\n").slice(-2000);
      }
      const out = await execSsh(
        await this.sshTarget(hostId),
        `tail -n 20 "$HOME/.platform/host-runtime/${hostId}/logs/runtime.log" 2>/dev/null || true`,
        { timeoutMs: 10_000 },
      );
      return out.stdout.trim().slice(-2000) || undefined;
    } catch {
      return undefined;
    }
  }

  private async mintEnrollmentToken(hostId: string): Promise<string> {
    const token = `enr_${randomBytes(24).toString("base64url")}`;
    const expiresAt = iso(nowMs() + this.cfg.enrollmentTtlSeconds * 1000);
    await query(
      `INSERT INTO pcs_enrollment_tokens (token_hash, host_id, expires_at) VALUES ($1,$2,$3)`,
      [hashToken(token), hostId, expiresAt],
    );
    return token;
  }

  private async sshTarget(hostId: string): Promise<SshTarget> {
    const cred = await this.getHostCredential(hostId);
    if (!cred || cred.transport !== "ssh") {
      throw notFound("HOST_TRANSPORT_UNKNOWN", "host is not connected over SSH");
    }
    const key = this.requireCredentialKey();
    const raw = await query<{
      auth_type: string | null;
      key_ciphertext: string | null;
      key_iv: string;
      key_tag: string;
    }>(
      `SELECT auth_type, key_ciphertext, key_iv, key_tag
         FROM pcs_host_credentials WHERE host_id=$1`,
      [hostId],
    );
    const sealed = raw.rows[0];
    if (!sealed?.key_ciphertext) {
      throw notFound("HOST_CREDENTIAL_MISSING", "no SSH credential is stored for this host");
    }
    const secret = openSecret(key, {
      ciphertext: sealed.key_ciphertext,
      iv: sealed.key_iv,
      tag: sealed.key_tag,
    });
    const base = {
      address: String(cred.address ?? ""),
      port: cred.ssh_port,
      user: String(cred.ssh_user ?? "root"),
    };
    return sealed.auth_type === "password"
      ? { ...base, password: secret }
      : { ...base, privateKey: secret };
  }

  private requireCredentialKey(): Buffer {
    if (!this.credentialKey) {
      throw new PcsError(
        503,
        "CREDENTIAL_KEY_MISSING",
        "PCS_CREDENTIAL_KEY_FILE is not configured; cannot encrypt and store SSH passwords or private keys",
      );
    }
    return this.credentialKey;
  }

  async listHosts(): Promise<unknown[]> {
    const r = await query(
      `SELECT h.*,
              rt.runtime_version, rt.container_runtime, rt.healthy AS runtime_healthy,
              rt.updated_at AS runtime_updated_at,
              rep.payload AS last_report, rep.received_at AS last_report_at,
              cred.transport, cred.address, cred.ssh_port, cred.ssh_user, cred.auth_type,
              cred.key_fingerprint, cred.last_probe, cred.last_probe_at
         FROM pcs_hosts h
         LEFT JOIN pcs_host_runtimes rt USING (host_id)
         LEFT JOIN pcs_host_reports rep USING (host_id)
         LEFT JOIN pcs_host_credentials cred USING (host_id)
        ORDER BY h.created_at`,
    );
    return r.rows;
  }

  /**
   * Host merge (architecture rule 2): hostId's root scheduler becomes a node scheduler in parentHostId's tree.
   *
   * Only the control plane's tree changes; no scheduler is restarted: the identity of the root scheduler inside hostId stays the same;
   * cross-host reporting is enabled by configuring SCHEDULER_PARENT_URL / TOKEN on the host's scheduler.
   */
  async mergeHost(
    hostId: string,
    parentHostId: string,
    operator: string,
  ): Promise<{ host_id: string; parent_host_id: string | null; role_mode: string }> {
    if (!parentHostId?.trim()) throw new PcsError(400, "PARENT_REQUIRED", "parent_host_id is required");
    if (hostId === parentHostId) {
      throw new PcsError(400, "HOST_MERGE_SELF", "a host cannot be merged into itself");
    }
    const child = await this.getHost(hostId);
    if (!child) throw notFound("HOST_NOT_FOUND", "host not found");
    const parent = await this.getHost(parentHostId);
    if (!parent) throw notFound("PARENT_HOST_NOT_FOUND", "parent host not found");
    if (child.status === "REVOKED" || parent.status === "REVOKED") {
      throw forbidden("HOST_REVOKED", "host has been revoked and cannot be merged");
    }
    const hasScheduler = async (id: string) =>
      Boolean(
        (
          await query(
            `SELECT 1 FROM pcs_deployments
              WHERE host_id=$1 AND role_id='scheduler'
                AND COALESCE(scheduler_role, 'root') = 'root'
                AND status <> 'REMOVED' LIMIT 1`,
            [id],
          )
        ).rowCount,
      );
    // Merging is allowed even if the child has no root scheduler: bare-metal builders can exist independently,
    // and once a scheduler is deployed there later, syncFederationParent in the host report adds federation reporting.
    if (!(await hasScheduler(parentHostId))) {
      throw conflict("PARENT_SCHEDULER_MISSING", "the parent host has no root scheduler yet and cannot accept nodes");
    }

    // Walk up the parent chain: hitting yourself means the target is in your own subtree, which would form a cycle.
    let cursor: string | null = parentHostId;
    const seen = new Set<string>();
    while (cursor) {
      if (cursor === hostId) {
        throw conflict("HOST_MERGE_CYCLE", "cannot merge into one of your own descendant hosts");
      }
      if (seen.has(cursor)) break;
      seen.add(cursor);
      const next: { rows: Array<{ parent_host_id: string | null }> } = await query(
        `SELECT parent_host_id FROM pcs_hosts WHERE host_id=$1`,
        [cursor],
      );
      cursor = next.rows[0]?.parent_host_id ?? null;
    }

    const out = await query<{ host_id: string; parent_host_id: string | null; role_mode: string }>(
      `UPDATE pcs_hosts SET parent_host_id=$2, updated_at=now()
        WHERE host_id=$1
        RETURNING host_id, parent_host_id, role_mode`,
      [hostId, parentHostId],
    );
    await this.audit(operator, "host.merge", hostId, null, {
      parent_host_id: parentHostId,
    });
    // Push the parent root scheduler's address to this host's root scheduler: no container restart; reporting starts on the next federation cycle.
    await this.syncFederationParent(hostId);
    return out.rows[0];
  }

  async unmergeHost(
    hostId: string,
    operator: string,
  ): Promise<{ host_id: string; parent_host_id: null }> {
    const host = await this.getHost(hostId);
    if (!host) throw notFound("HOST_NOT_FOUND", "host not found");
    await query(
      `UPDATE pcs_hosts SET parent_host_id=NULL, updated_at=now() WHERE host_id=$1`,
      [hostId],
    );
    await this.audit(operator, "host.unmerge", hostId, null, {});
    await this.syncFederationParent(hostId);
    return { host_id: hostId, parent_host_id: null };
  }

  /**
   * Federation tree + recursive ΣW.
   *
   * Each host first computes the sum of W for its local builders, then accumulates upward along parent_host_id;
   * every returned node carries subtree_score, and the root node's value is the ΣW of the whole tree.
   */
  async getFleetTree(): Promise<{
    hosts: Array<Record<string, unknown>>;
    roots: string[];
    total_score: number;
    generated_at: string;
  }> {
    const rows = (
      await query<any>(
        `SELECT h.host_id, h.hostname, h.status, h.parent_host_id, h.role_mode,
                h.resources,
                -- Only builders that are actually running count toward dispatchable capacity: FAILED / stopping instances are excluded from ΣW.
                COALESCE(SUM(d.capability_score)
                  FILTER (WHERE d.role_id='builder'
                            AND d.status IN ('STARTING','HEALTHY')), 0)::int AS local_score,
                COUNT(d.deployment_id)
                  FILTER (WHERE d.role_id='builder'
                            AND d.status IN ('STARTING','HEALTHY'))::int AS builder_count,
                COALESCE(BOOL_OR(d.role_id='scheduler'
                                 AND COALESCE(d.scheduler_role, 'root') = 'root'
                                 AND d.status <> 'REMOVED'), false) AS has_scheduler
           FROM pcs_hosts h
           LEFT JOIN pcs_deployments d ON d.host_id = h.host_id
          GROUP BY h.host_id
          ORDER BY h.created_at`,
      )
    ).rows;

    const byId = new Map<string, any>(rows.map((r) => [r.host_id, { ...r }]));
    const children = new Map<string, string[]>();
    for (const row of rows) {
      if (!row.parent_host_id || !byId.has(row.parent_host_id)) continue;
      const list = children.get(row.parent_host_id) ?? [];
      list.push(row.host_id);
      children.set(row.parent_host_id, list);
    }

    const memo = new Map<string, { score: number; builders: number; depth: number }>();
    const visiting = new Set<string>();
    const aggregate = (hostId: string, depth = 0): { score: number; builders: number; depth: number } => {
      if (memo.has(hostId)) return memo.get(hostId)!;
      if (visiting.has(hostId)) {
        // FK + merge validation normally prevent cycles; if one does occur, cut it off to avoid infinite recursion.
        return { score: 0, builders: 0, depth };
      }
      visiting.add(hostId);
      const row = byId.get(hostId)!;
      let score = Number(row.local_score ?? 0);
      let builders = Number(row.builder_count ?? 0);
      let maxDepth = depth;
      for (const childId of children.get(hostId) ?? []) {
        const agg = aggregate(childId, depth + 1);
        score += agg.score;
        builders += agg.builders;
        maxDepth = Math.max(maxDepth, agg.depth);
      }
      visiting.delete(hostId);
      const out = { score, builders, depth: maxDepth };
      memo.set(hostId, out);
      return out;
    };

    const hosts = rows.map((row) => {
      const agg = aggregate(row.host_id);
      return {
        ...row,
        local_score: Number(row.local_score ?? 0),
        subtree_score: agg.score,
        subtree_builder_count: agg.builders,
        depth: agg.depth,
        child_host_ids: children.get(row.host_id) ?? [],
        is_root: !row.parent_host_id,
      };
    });
    const roots = hosts.filter((h) => h.is_root).map((h) => h.host_id as string);
    const total = hosts
      .filter((h) => h.is_root)
      .reduce((sum, h) => sum + Number(h.subtree_score ?? 0), 0);
    return { hosts, roots, total_score: total, generated_at: iso(nowMs()) };
  }

  async revokeHost(hostId: string, operator: string): Promise<{ host_id: string; status: string }> {
    const r = await query<{ host_id: string; status: string }>(
      `UPDATE pcs_hosts SET status='REVOKED', updated_at=now()
        WHERE host_id=$1 RETURNING host_id, status`,
      [hostId],
    );
    if (!r.rowCount) throw notFound("HOST_NOT_FOUND", "host not found");
    console.log(`[audit] revoke host ${hostId} by ${operator}`);
    return r.rows[0];
  }

  /**
   * Delete the host record outright.
   *
   * Containers must first be actually removed on the host; reject as long as any deployment is not REMOVED,
   * so the PCS never deletes the record while leaving unmanaged containers on the machine.
   */
  async deleteHost(hostId: string, operator: string): Promise<{ host_id: string; deleted: true }> {
    await tx(async (c) => {
      const host = await c.query(`SELECT host_id FROM pcs_hosts WHERE host_id=$1 FOR UPDATE`, [hostId]);
      if (!host.rowCount) throw notFound("HOST_NOT_FOUND", "host not found");
      const active = await c.query(
        `SELECT count(*)::int AS n FROM pcs_deployments
          WHERE host_id=$1 AND status <> 'REMOVED'`,
        [hostId],
      );
      if (Number(active.rows[0]?.n ?? 0) > 0) {
        throw conflict("HOST_HAS_DEPLOYMENTS", "the host still has containers that have not been removed; remove them first");
      }
      // These two tables have no foreign keys, so this host's bindings must be deleted first.
      await c.query(`DELETE FROM role_agent_bindings WHERE host_id=$1`, [hostId]);
      await c.query(`DELETE FROM role_api_bindings WHERE host_id=$1`, [hostId]);
      await c.query(`DELETE FROM pcs_commands WHERE host_id=$1`, [hostId]);
      await c.query(`DELETE FROM pcs_deployments WHERE host_id=$1`, [hostId]);
      // The remaining credentials / runtimes / reports / enrollment tokens are deleted by foreign-key cascade.
      await c.query(`DELETE FROM pcs_hosts WHERE host_id=$1`, [hostId]);
    });
    await this.audit(operator, "host.delete", hostId, null, {});
    console.log(`[audit] delete host ${hostId} by ${operator}`);
    return { host_id: hostId, deleted: true };
  }

  async renewHostToken(host: HostRow): Promise<{ host_token: string; expires_at: string }> {
    return this.issueHostToken(host.host_id);
  }

  async heartbeat(
    host: HostRow,
    body: Record<string, any>,
  ): Promise<{
    ok: true;
    server_time: string;
    schedulers: Array<{
      deployment_id: string;
      role: string;
      url: string;
      scheduling_mode: string;
    }>;
  }> {
    const state = String(body.host_state ?? "NORMAL");
    await tx(async (c) => {
      await c.query(
        `UPDATE pcs_hosts
            SET last_seen_at=now(), updated_at=now(),
                status = CASE WHEN $2 = 'NORMAL' THEN 'ONLINE' ELSE 'DEGRADED' END
          WHERE host_id=$1 AND status <> 'REVOKED'`,
        [host.host_id, state],
      );
      await this.upsertRuntime(c, host.host_id, body.runtime ?? {});
    });
    // The host-runtime pulls dynamic grants from the scheduler directly; it learns the addresses here
    // because schedulers may be deployed after the host was bootstrapped.
    const schedulers = (
      await query<{
        deployment_id: string;
        instance_id: string;
        scheduler_role: string | null;
        scheduler_url: string | null;
        env: Record<string, string> | null;
      }>(
        `SELECT deployment_id, instance_id, scheduler_role, scheduler_url, env
           FROM pcs_deployments
          WHERE host_id=$1 AND role_id='scheduler' AND status IN ('STARTING','HEALTHY')
            AND scheduler_url IS NOT NULL
          ORDER BY CASE WHEN scheduler_role = 'root' THEN 0 ELSE 1 END, created_at`,
        [host.host_id],
      )
    ).rows.map((r) => ({
      deployment_id: r.deployment_id,
      role: r.scheduler_role ?? "root",
      url: String(r.scheduler_url ?? ""),
      scheduling_mode: String(r.env?.SCHEDULING_MODE ?? this.cfg.schedulingMode),
    }));
    return { ok: true, server_time: iso(nowMs()), schedulers: schedulers.filter((s) => s.url) };
  }

  private async upsertRuntime(
    c: import("pg").PoolClient,
    hostId: string,
    runtime: Record<string, any>,
  ): Promise<void> {
    await c.query(
      `INSERT INTO pcs_host_runtimes
         (host_id, runtime_version, container_runtime, capabilities, healthy, updated_at)
       VALUES ($1,$2,$3,$4,$5,now())
       ON CONFLICT (host_id) DO UPDATE
         SET runtime_version=EXCLUDED.runtime_version,
             container_runtime=EXCLUDED.container_runtime,
             capabilities=EXCLUDED.capabilities,
             healthy=EXCLUDED.healthy, updated_at=now()`,
      [
        hostId,
        String(runtime.version ?? "unknown"),
        String(runtime.container_runtime ?? "unknown"),
        JSON.stringify(runtime.capabilities ?? {}),
        runtime.healthy !== false,
      ],
    );
  }

  // ---------------------------------------------------------------- Scheduler topology

  /** The host's LAN address (SSH access info); returns null when a local host has no address. */
  private async hostAddress(hostId: string): Promise<string | null> {
    const r = await query<{ address: string | null }>(
      `SELECT address FROM pcs_host_credentials WHERE host_id=$1`,
      [hostId],
    );
    const address = String(r.rows[0]?.address ?? "").trim();
    return address || null;
  }

  /**
   * The scheduler's external API address. It listens on 8443 inside the container, and the host port is determined by the deployment's ports;
   * prefer "host address + host port", falling back to the control plane config when no SSH address is configured.
   */
  private async schedulerUrlFor(hostId: string, ports: PortMapping[]): Promise<string | null> {
    const mapping = ports.find((p) => Number(p.container) === 8443);
    const address = await this.hostAddress(hostId);
    if (address && mapping) {
      const base = /^https?:\/\//.test(address) ? address : `http://${address}`;
      return `${base.replace(/\/+$/, "")}:${mapping.host}`;
    }
    return this.cfg.schedulerUrls[hostId] ?? this.cfg.schedulerUrl;
  }

  /**
   * Each scheduler gets its own database: the root scheduler uses the host config, and a node scheduler appends an instance suffix to the database name.
   * The scheduler creates the database and migrates automatically on startup (see scheduler/src/migrate.ts).
   */
  private schedulerDatabaseUrlFor(
    hostId: string,
    instanceId: string,
    role: "root" | "node",
  ): string | null {
    const base = this.cfg.schedulerDatabaseUrls[hostId] ?? this.cfg.schedulerDatabaseUrl;
    if (!base) return null;
    if (role === "root") return base;
    const url = new URL(base);
    const baseName = decodeURIComponent(url.pathname.replace(/^\//, "")) || "scheduler";
    const suffix =
      instanceId
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "") || "node";
    const name = `${baseName}_${suffix}`.slice(0, 63);
    url.pathname = `/${name}`;
    return url.toString();
  }

  /** Active schedulers on this host; the root scheduler comes first. */
  private async activeSchedulers(hostId: string): Promise<DeploymentRow[]> {
    const r = await query<DeploymentRow>(
      `SELECT * FROM pcs_deployments
        WHERE host_id=$1 AND role_id='scheduler' AND status <> 'REMOVED'
        ORDER BY CASE WHEN scheduler_role = 'root' THEN 0 ELSE 1 END, created_at`,
      [hostId],
    );
    return r.rows;
  }

  /**
   * Resolve a new scheduler's position in the tree.
   * When no identity is specified, the first one defaults to root; once a root exists, a parent scheduler must be specified.
   * Redeploying the same instance keeps its original identity, so a rolling update is not mistaken for a new root.
   */
  /**
   * Resolve a scheduler reference from the UI into a running deployment.
   *
   * The normal reference is a deployment_id; but instance names are unique within a host, and older UIs send an instance name,
   * so fall back to name lookup, avoiding a front-end release that forces all clients to upgrade in sync. When the same instance has been redeployed,
   * active is ordered by creation time descending, landing on the instance's newest deployment.
   */
  private resolveSchedulerRef(
    active: DeploymentRow[],
    ref: string,
  ): DeploymentRow | undefined {
    const hit =
      active.find((d) => d.deployment_id === ref) ??
      active.find((d) => d.instance_id === ref);
    if (!hit) return undefined;
    return active.find((d) => d.instance_id === hit.instance_id) ?? hit;
  }

  private resolveSchedulerPlacement(
    hostId: string,
    instanceId: string,
    active: DeploymentRow[],
    input: { scheduler_role?: "root" | "node"; parent_scheduler_id?: string },
  ): { role: "root" | "node"; parent: DeploymentRow | null } {
    const existing = active.find((d) => d.instance_id === instanceId);
    const root = active.find((d) => (d.scheduler_role ?? "root") === "root");
    let role = input.scheduler_role ?? (existing?.scheduler_role as "root" | "node" | undefined);
    let parentId = input.parent_scheduler_id ?? existing?.parent_deployment_id ?? undefined;
    role ??= root && root.instance_id !== instanceId ? "node" : "root";

    if (role === "root") {
      if (root && root.instance_id !== instanceId) {
        throw conflict("ROOT_SCHEDULER_EXISTS", `host ${hostId} already has root scheduler ${root.instance_id}`, {
          existing_instance_id: root.instance_id,
        });
      }
      return { role, parent: null };
    }

    if (!parentId) {
      throw conflict(
        "SCHEDULER_PARENT_REQUIRED",
        "this host already has a root scheduler; a node scheduler must select a parent scheduler",
        { host_id: hostId },
      );
    }
    const parent = this.resolveSchedulerRef(active, parentId);
    if (!parent) {
      throw notFound(
        "PARENT_SCHEDULER_NOT_FOUND",
        `parent scheduler does not exist or is stopped (reference ${parentId})`,
      );
    }
    // Walk up the parent chain: the new position must not appear in your own descendants.
    const seen = new Set<string>();
    let cursor: string | null | undefined = parent.deployment_id;
    while (cursor) {
      if (seen.has(cursor)) break;
      seen.add(cursor);
      if (cursor === existing?.deployment_id) {
        throw conflict("SCHEDULER_TREE_CYCLE", "cannot attach a scheduler under one of its own descendants");
      }
      cursor = active.find((d) => d.deployment_id === cursor)?.parent_deployment_id ?? null;
    }
    return { role, parent };
  }

  // ---------------------------------------------------------------- Deployments

  /**
   * The host role and the deployment execution mode must match:
   *   containers → only container deployments; builder → only builder processes on the host machine;
   *   scheduler → bare-metal scheduler (execution path not implemented yet), which no longer accepts any container deployments.
   */
  private assertExecutionAllowed(
    host: HostRow,
    roleId: string,
    execution: "container" | "native",
  ): void {
    if (execution === "native") {
      if (roleId !== "builder") {
        throw conflict("NATIVE_ROLE_NOT_SUPPORTED", "only bare-metal builders can currently run directly on the host");
      }
      if (host.role_mode !== "builder") {
        throw conflict(
          "HOST_NOT_NATIVE_BUILDER",
          "this host is not a bare-metal builder: first change its role in host settings to bare-metal builder",
        );
      }
      return;
    }
    if (host.role_mode === "builder") {
      throw conflict(
        "HOST_ROLE_CONFLICT",
        "this host is a bare-metal builder and cannot deploy containers; to restore it as a container host, change the host role back first",
      );
    }
    if (host.role_mode === "scheduler") {
      throw conflict("HOST_ROLE_CONFLICT", "this host is a bare-metal scheduler and cannot deploy containers");
    }
  }

  async createDeployment(
    input: CreateDeploymentInput,
    opts: { expected_generation?: number } = {},
  ): Promise<{
    deployment: DeploymentRow;
    command_id: string;
  }> {
    const host = await this.getHost(input.host_id);
    if (!host) throw notFound("HOST_NOT_FOUND", "target host not found");
    if (host.status === "REVOKED") throw forbidden("HOST_REVOKED", "target host has been revoked");
    if (!input.role_id?.trim()) throw new PcsError(400, "INVALID_ROLE", "role_id is required");
    const execution = input.execution ?? "container";
    this.assertExecutionAllowed(host, input.role_id, execution);
    const image = input.image ?? "";

    const instanceId = input.instance_id?.trim() || newId("ins");
    const ports = normalizePorts(input.ports);
    if (execution === "container") assertPinnedImage(image, this.cfg.imageAllowlist);
    // The scheduler's position (root/node) and the scheduler a builder registers with must both resolve against existing deployments on this host.
    const active = await this.activeSchedulers(host.host_id);
    const placement =
      input.role_id === "scheduler"
        ? this.resolveSchedulerPlacement(host.host_id, instanceId, active, input)
        : null;
    const schedulerRef =
      input.role_id === "builder"
        ? input.scheduler_id
          ? active.find((d) => d.deployment_id === input.scheduler_id) ?? null
          : active.find((d) => (d.scheduler_role ?? "root") === "root") ?? active[0] ?? null
        : null;
    if (input.role_id === "builder" && input.scheduler_id && !schedulerRef) {
      throw notFound("SCHEDULER_NOT_FOUND", "the selected scheduler does not exist or is stopped");
    }
    const schedulerUrl =
      input.role_id === "scheduler"
        ? await this.schedulerUrlFor(host.host_id, ports)
        : (schedulerRef?.scheduler_url ??
          this.cfg.schedulerUrls[host.host_id] ??
          this.cfg.schedulerUrl);

    const env = { ...(input.env ?? {}) };
    const capability =
      input.role_id === "builder" ? resolveCapability(input) : { score: 0, detail: {} };
    if (input.role_id === "builder") {
      if (env.CAPABILITY_SCORE === undefined) env.CAPABILITY_SCORE = String(capability.score);
      if (env.CAPABILITY_DETAIL === undefined && Object.keys(capability.detail).length) {
        env.CAPABILITY_DETAIL = JSON.stringify(capability.detail);
      }
      if (schedulerUrl) env.SCHEDULER_URL ??= schedulerUrl;
    }
    if (input.role_id === "scheduler" && placement) {
      env.SCHEDULER_NODE_ID ??= `${host.host_id}:${instanceId}`;
      env.SCHEDULER_HOST_ID ??= host.host_id;
      env.SCHEDULER_ROLE ??= placement.role;
      // The root needs a token too: it validates child-node reports; a node also needs to know where to report.
      env.SCHEDULER_FEDERATION_TOKEN ??= this.federationToken;
      // The parent node must be able to call back to this machine when relaying tasks; the address is computed by the control plane as "host address + host port".
      if (schedulerUrl) env.SCHEDULER_ADVERTISE_URL ??= schedulerUrl;
      if (placement.role === "node" && placement.parent) {
        const parentUrl =
          placement.parent.scheduler_url ??
          this.cfg.schedulerUrls[placement.parent.host_id] ??
          this.cfg.schedulerUrl;
        if (parentUrl) env.SCHEDULER_PARENT_URL ??= parentUrl;
      }
      if (!env.DATABASE_URL) {
        const dbUrl = this.schedulerDatabaseUrlFor(host.host_id, instanceId, placement.role);
        if (dbUrl) env.DATABASE_URL = dbUrl;
      }
    }
    assertNoSecretsInEnv(env);
    const volumes = (input.volumes ?? []).map((v) => this.validateVolume(v));
    const profile = normalizeResourceProfile(input.resource_profile ?? {});
    const policy = input.network_policy ?? "default";
    if (!this.cfg.networkPolicies.includes(policy)) {
      throw new PcsError(400, "NETWORK_POLICY_NOT_ALLOWED", `network policy is not in the allowlist: ${policy}`, {
        allowlist: this.cfg.networkPolicies,
      });
    }
    const command = input.command ? this.validateCommand(input.command) : undefined;
    validateFilesAndAgentEnv(input.files, input.agent_env, env);
    // When the target host does not have the image, the control plane syncs it first; during sync the deployment status is SYNCING,
    // and the command is dispatched after sync completes. Bare-metal roles have no image and are dispatched immediately.
    const imageReady =
      execution === "native" ? true : await this.isImageReady(host.host_id, image);

    const { deployment, commandRow, payload, issuedExpiry } = await tx(async (c) => {
      // A given instance's generation increases monotonically, so concurrent deployments never get the same number
      // Instance names are unique only within a host: only same-named instances on the same host need serial generation allocation.
      await c.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
        `${host.host_id}/${instanceId}`,
      ]);
      const max = (
        await c.query(
          `SELECT COALESCE(MAX(generation),0) AS g
             FROM pcs_deployments
            WHERE host_id=$1 AND instance_id=$2`,
          [host.host_id, instanceId],
        )
      ).rows[0];
      const generation = Number(max.g) + 1;
      if (opts.expected_generation !== undefined && generation !== opts.expected_generation) {
        throw conflict("PLAN_CHANGED", "instance generation has changed; the deployment plan is stale, please preview again", {
          expected_generation: opts.expected_generation,
          current_generation: generation,
        });
      }
      // Redeploying the same instance on the same host: the old deployment yields to the new generation, and the new deployment takes over the container name.
      // If not marked, the old record remains an "active deployment" and the host side rejects the new deployment with a container-name conflict.
      // Scoped by host_id: one scheduler per host, so same-named instances on different hosts do not affect each other.
      await c.query(
        `UPDATE pcs_deployments
            SET status='REMOVED', actual_state='MISSING', updated_at=now()
          WHERE instance_id=$1 AND host_id=$2 AND status <> 'REMOVED'`,
        [instanceId, host.host_id],
      );
      const deploymentId = newId("dep");
      const grantId = newId("rgr");
      const now = nowMs();
      const issuedAt = iso(now);
      // Extend the command's validity when an image sync is needed: a multi-GB transfer may exceed the default TTL.
      const ttlSeconds = imageReady ? this.cfg.commandTtlSeconds : Math.max(this.cfg.commandTtlSeconds, 1800);
      const expiresAt = iso(now + ttlSeconds * 1000);

      const spec: InstanceSpec = {
        instance_id: instanceId,
        role_id: input.role_id,
        display_name: input.display_name ?? null,
        ...(execution === "native" ? { execution } : {}),
        image,
        resource_profile: profile,
        env,
        volumes,
        ports,
        network_policy: policy,
        config_version: input.config_version ?? 1,
        command,
        ...(input.files ? { files: input.files } : {}),
        ...(input.agent_env ? { agent_env: input.agent_env } : {}),
      };
      const payload = signCommand(
        {
          command_id: newId("cmd"),
          command_type: "DEPLOY",
          host_id: host.host_id,
          deployment_id: deploymentId,
          instance_id: instanceId,
          generation,
          issued_at: issuedAt,
          expires_at: expiresAt,
          resource_grant: {
            grant_id: grantId,
            kind: "DEPLOYMENT",
            cpu_limit: profile.cpu_limit,
            memory_limit_bytes: profile.memory_limit_bytes,
          },
          instance: spec,
        },
        this.commandPrivateKey,
      );

      const dep = (
        await c.query(
          `INSERT INTO pcs_deployments
             (deployment_id, instance_id, host_id, role_id, display_name, image,
              desired_state, actual_state, config_version, generation,
              resource_profile, env, volumes, ports, network_policy, command,
              capability_score, capability_detail, status, created_by,
              scheduler_role, parent_deployment_id, scheduler_url, scheduler_deployment_id,
              execution)
           VALUES ($1,$2,$3,$4,$5,$6,'RUNNING','PENDING',$7,$8,$9,$10,$11,$12,$13,$14,
                   $17,$18::jsonb,$16,$15,$19,$20,$21,$22,$23)
           RETURNING *`,
          [
            deploymentId,
            instanceId,
            host.host_id,
            input.role_id,
            input.display_name ?? null,
            image,
            input.config_version ?? 1,
            generation,
            JSON.stringify(profile),
            JSON.stringify(env),
            JSON.stringify(volumes),
            JSON.stringify(ports),
            policy,
            command ? JSON.stringify(command) : null,
            input.created_by,
            imageReady ? "PLANNED" : "SYNCING",
            capability.score,
            JSON.stringify(capability.detail),
            placement?.role ?? null,
            placement?.parent?.deployment_id ?? null,
            input.role_id === "scheduler" ? schedulerUrl : null,
            schedulerRef?.deployment_id ?? null,
            execution,
          ],
        )
      ).rows[0];

      // Dispatch the command immediately only if the image is already on the target host; otherwise insert it after sync completes.
      if (imageReady) {
        await c.query(
          `INSERT INTO pcs_commands
             (command_id, host_id, deployment_id, instance_id, command_type, generation,
              payload, expires_at, state)
           VALUES ($1,$2,$3,$4,'DEPLOY',$5,$6,$7,'PENDING')`,
          [payload.command_id, host.host_id, deploymentId, instanceId, generation, JSON.stringify(payload), expiresAt],
        );
      }

      return {
        deployment: dep as DeploymentRow,
        commandRow: payload.command_id,
        payload,
        issuedExpiry: expiresAt,
      };
    });

    if (!imageReady) {
      void this.syncImageThenEnqueue({
        deploymentId: deployment.deployment_id,
        hostId: host.host_id,
        image,
        payload,
        expiresAt: issuedExpiry,
      });
    }

    return { deployment, command_id: commandRow };
  }

  /** Whether the target host already has the image; on probe failure treat it as "already present" and keep the original pull behavior. */
  private async isImageReady(hostId: string, image: string): Promise<boolean> {
    try {
      const cred = await this.getHostCredential(hostId);
      if (!cred) return true;
      if (cred.transport === "local") {
        return (await runCommand("docker", ["image", "inspect", image])).code === 0;
      }
      const r = await execSsh(
        await this.sshTarget(hostId),
        `docker image inspect ${shq(image)} >/dev/null 2>&1`,
        { timeoutMs: 15_000 },
      );
      return r.code === 0;
    } catch {
      return true;
    }
  }

  /**
   * Push the image from the control plane host to the target host (docker save | ssh docker load),
   * then dispatch the deployment command once the transfer is complete. Large images take several minutes, during which the deployment status stays SYNCING.
   */
  private async syncImageThenEnqueue(input: {
    deploymentId: string;
    hostId: string;
    image: string;
    payload: CommandPayload;
    expiresAt: string;
  }): Promise<void> {
    const started = Date.now();
    try {
      await this.transferImageToHost(input.hostId, input.image);
      await query(
        `INSERT INTO pcs_commands
           (command_id, host_id, deployment_id, instance_id, command_type, generation,
            payload, expires_at, state)
         VALUES ($1,$2,$3,$4,'DEPLOY',$5,$6,$7,'PENDING')
         ON CONFLICT (command_id) DO NOTHING`,
        [
          input.payload.command_id,
          input.hostId,
          input.deploymentId,
          input.payload.instance_id,
          input.payload.generation,
          JSON.stringify(input.payload),
          input.expiresAt,
        ],
      );
      await query(
        `UPDATE pcs_deployments SET status='PLANNED', updated_at=now()
          WHERE deployment_id=$1 AND status='SYNCING'`,
        [input.deploymentId],
      );
      console.log(
        `[image-sync] ${input.image} → ${input.hostId} complete (${Math.round((Date.now() - started) / 1000)}s)`,
      );
    } catch (e) {
      await query(
        `UPDATE pcs_deployments SET status='FAILED', actual_state='FAILED', updated_at=now()
          WHERE deployment_id=$1`,
        [input.deploymentId],
      ).catch(() => undefined);
      console.warn(`[image-sync] ${input.image} → ${input.hostId} failed: ${(e as Error).message}`);
    }
  }

  private async transferImageToHost(hostId: string, image: string): Promise<void> {
    const cred = await this.getHostCredential(hostId);
    if (!cred) throw notFound("HOST_TRANSPORT_UNKNOWN", "host has no access information");
    // The source image is on the control plane's host; save it as repo:tag so the target can resolve the repo digest after loading.
    const src = await runCommand("docker", ["image", "inspect", image, "--format", "{{index .RepoTags 0}}"]);
    const repoTag = src.code === 0 ? src.stdout.trim() : "";
    if (!repoTag) {
      throw new PcsError(
        409,
        "IMAGE_NOT_ON_CONTROL_PLANE",
        `the control-plane host does not have image ${image}; cannot sync to the target host: docker load the image on the control-plane host and retry`,
      );
    }
    if (cred.transport === "local") return;

    const target = await this.sshTarget(hostId);
    const save = spawn("docker", ["save", repoTag], { stdio: ["ignore", "pipe", "pipe"] });
    let saveErr = "";
    save.stderr.on("data", (d: Buffer) => {
      saveErr += d.toString("utf8");
    });
    let saveCode: number | null = null;
    const saveDone = new Promise<void>((resolve) => {
      save.on("close", (code) => {
        saveCode = code ?? 1;
        resolve();
      });
      save.on("error", () => {
        saveCode = 1;
        resolve();
      });
    });
    const loaded = await pipeToSsh(target, "docker load", save.stdout, 20 * 60_000);
    if (saveCode !== 0) {
      try {
        save.kill("SIGKILL");
      } catch {
        /* already exited */
      }
    }
    await saveDone;
    if (saveCode !== 0) {
      throw new PcsError(502, "IMAGE_SAVE_FAILED", saveErr.trim().slice(-400) || "docker save failed");
    }
    if (loaded.code !== 0) {
      const detail = (loaded.stderr || loaded.stdout).trim().slice(-400);
      throw new PcsError(502, "IMAGE_TRANSFER_FAILED", detail || `docker load exited with code ${loaded.code}`);
    }
    // A locally built image may have only a tag and no repo digest after loading; tag it once so digest references resolve.
    const fixed = await execSsh(
      target,
      [
        `docker tag "$(docker image inspect ${shq(repoTag)} --format '{{.Id}}' 2>/dev/null)" ${shq(repoTag)} >/dev/null 2>&1 || true`,
        `docker image inspect ${shq(image)} >/dev/null 2>&1`,
      ].join("\n"),
      { timeoutMs: 60_000 },
    );
    if (fixed.code !== 0) {
      // When the tar from docker load has no repo digest, digest references cannot be resolved on the target machine.
      // If the target can reach the registry, a single pull by digest is enough (official ubuntu is only a hundred-plus MB).
      const pulled = await execSsh(target, `docker pull ${shq(image)}`, {
        timeoutMs: 15 * 60_000,
      });
      const resolved =
        pulled.code === 0
          ? await execSsh(target, `docker image inspect ${shq(image)} >/dev/null 2>&1`, {
              timeoutMs: 60_000,
            })
          : pulled;
      if (resolved.code !== 0) {
        throw new PcsError(
          502,
          "IMAGE_TRANSFER_INCOMPLETE",
          `the image was transferred to the target host but cannot be resolved by digest: ${image}`,
        );
      }
    }
  }

  private validateVolume(v: { name: string; mount: string }): { name: string; mount: string } {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,40}$/.test(v.name ?? "")) {
      throw new PcsError(400, "INVALID_VOLUME", `invalid volume name: ${v.name}`);
    }
    if (!v.mount?.startsWith("/opt/platform/") || v.mount.includes("..")) {
      throw new PcsError(400, "INVALID_VOLUME", `volume mount point must be under /opt/platform/: ${v.mount}`);
    }
    return { name: v.name, mount: v.mount };
  }

  private validateCommand(command: string[]): string[] {
    if (!Array.isArray(command) || command.length === 0 || command.length > 64) {
      throw new PcsError(400, "INVALID_COMMAND", "command must be a non-empty array of strings (≤64 items)");
    }
    for (const part of command) {
      if (typeof part !== "string" || part.length > 4096 || part.includes("\0")) {
        throw new PcsError(400, "INVALID_COMMAND", "command contains an invalid argument");
      }
    }
    return command;
  }

  async enqueueAction(
    deploymentId: string,
    action: "start" | "stop" | "restart" | "remove",
    operator: string,
  ): Promise<{ command_id: string; deployment_id: string; generation: number }> {
    const type: CommandType = ({
      start: "START",
      stop: "STOP",
      restart: "RESTART",
      remove: "REMOVE",
    } as const)[action];
    const desired = action === "stop" ? "STOPPED" : action === "remove" ? "REMOVED" : "RUNNING";

    return tx(async (c) => {
      const dep = (
        await c.query(`SELECT * FROM pcs_deployments WHERE deployment_id=$1 FOR UPDATE`, [
          deploymentId,
        ])
      ).rows[0] as DeploymentRow | undefined;
      if (!dep) throw notFound("DEPLOYMENT_NOT_FOUND", "deployment not found");
      // Removing is idempotent. A REMOVE whose acknowledgement failed or timed out leaves the deployment
      // with desired_state='REMOVED' but status!='REMOVED'; rejecting retries would strand the container
      // in the UI forever, so a repeated remove is re-dispatched instead of answered with 409.
      if (dep.status === "REMOVED") {
        if (action === "remove") {
          return { command_id: "", deployment_id: deploymentId, generation: Number(dep.generation) };
        }
        throw conflict("DEPLOYMENT_REMOVED", "deployment has been removed");
      }
      if (dep.desired_state === "REMOVED" && action !== "remove") {
        throw conflict("DEPLOYMENT_REMOVED", "deployment has been removed");
      }
      const hostStatus = (
        await c.query(`SELECT status FROM pcs_hosts WHERE host_id=$1`, [dep.host_id])
      ).rows[0]?.status;
      if (hostStatus === "REVOKED") {
        throw forbidden("HOST_REVOKED", "host has been revoked: no further commands will be dispatched");
      }
      if (action === "start" && dep.actual_state === "RUNNING") {
        throw conflict("ALREADY_RUNNING", "container is already running");
      }

      const generation = Number(dep.generation) + 1;
      const now = nowMs();
      const payload = signCommand(
        {
          command_id: newId("cmd"),
          command_type: type,
          host_id: dep.host_id,
          deployment_id: dep.deployment_id,
          instance_id: dep.instance_id,
          generation,
          issued_at: iso(now),
          expires_at: iso(now + this.cfg.commandTtlSeconds * 1000),
          resource_grant: null,
          instance: null,
        },
        this.commandPrivateKey,
      );

      await c.query(
        `UPDATE pcs_deployments
            SET desired_state=$2, generation=$3, status='PLANNED', updated_at=now()
          WHERE deployment_id=$1`,
        [deploymentId, desired, generation],
      );
      await c.query(
        `INSERT INTO pcs_commands
           (command_id, host_id, deployment_id, instance_id, command_type, generation,
            payload, expires_at, state)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'PENDING')`,
        [
          payload.command_id,
          dep.host_id,
          dep.deployment_id,
          dep.instance_id,
          type,
          generation,
          JSON.stringify(payload),
          payload.expires_at,
        ],
      );
      console.log(`[audit] ${type} ${deploymentId} by ${operator}`);
      return { command_id: payload.command_id, deployment_id: deploymentId, generation };
    });
  }

  async getDeployment(deploymentId: string): Promise<DeploymentRow | null> {
    const r = await query<DeploymentRow>(`SELECT * FROM pcs_deployments WHERE deployment_id=$1`, [
      deploymentId,
    ]);
    return r.rows[0] ?? null;
  }

  async listDeployments(hostId?: string): Promise<DeploymentRow[]> {
    const r = hostId
      ? await query<DeploymentRow>(
          `SELECT * FROM pcs_deployments WHERE host_id=$1 ORDER BY created_at DESC`,
          [hostId],
        )
      : await query<DeploymentRow>(`SELECT * FROM pcs_deployments ORDER BY created_at DESC`);
    return r.rows;
  }

  /**
   * Forward the admin app's task requests to "the scheduler that owns the instance".
   *
   * A host can have a root + multiple node schedulers, each with its own database; the admin app connects only to the control plane by default
   * and cannot know node addresses directly. The control plane resolves scheduler_url from the deployment record and forwards,
   * so neither the admin app nor the browser touches internal addresses or needs extra scheduler credentials.
   */
  async proxySchedulerDeployment(
    deploymentId: string,
    method: "GET" | "POST",
    pathname: string,
    search: string,
    body: unknown,
  ): Promise<unknown> {
    const dep = await this.getDeployment(deploymentId);
    if (!dep) throw notFound("DEPLOYMENT_NOT_FOUND", "deployment not found");
    if (dep.role_id !== "scheduler") {
      throw new PcsError(400, "NOT_A_SCHEDULER", "only scheduler deployments can use this proxy");
    }
    const base =
      String(dep.scheduler_url ?? "").trim() ||
      this.cfg.schedulerUrls[dep.host_id] ||
      this.cfg.schedulerUrl;
    if (!base) throw new PcsError(503, "SCHEDULER_URL_MISSING", "no scheduler address is available");
    const pathPart = pathname.startsWith("/") ? pathname : `/${pathname}`;
    const qs = search ? (search.startsWith("?") ? search : `?${search}`) : "";
    const target = `${base.replace(/\/+$/, "")}${pathPart}${qs}`;

    let res: Response;
    try {
      res = await fetch(target, {
        method,
        headers: body === undefined ? {} : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (e) {
      throw new PcsError(
        502,
        "SCHEDULER_UNREACHABLE",
        `scheduler unreachable: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    const text = await res.text();
    let data: any = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    if (!res.ok) {
      const err = data?.error ?? {};
      throw new PcsError(
        res.status,
        String(err.code ?? "SCHEDULER_ERROR"),
        String(err.message ?? `scheduler returned ${res.status}`),
        err.detail,
      );
    }
    return data;
  }

  /**
   * The Agent Profile view and credential variable names delivered to the container with the deployment.
   *
   * The Profile file contains only the bound Agent and instance bindings, not API Profiles: model calls go through
   * cli-agent to a Claude-compatible endpoint, with keys injected from the host-local credential file. Including API
   * Profiles would make host-runtime require a Secret Store instance JWT, which the container does not have,
   * so the instance would fail closed.
   */
  private agentDelivery(
    agent: AgentProfileRow,
    roleId: string,
    instanceId: string,
  ): { files: Array<{ path: string; content: string }>; agent_env: string[]; env: Record<string, string> } {
    const declared = [
      ...(agent.model_api_profile_id ? [agent.model_api_profile_id] : []),
      ...(agent.tool_api_profile_ids ?? []),
    ];
    if (declared.length) {
      throw new PcsError(
        409,
        "AGENT_REQUIRES_SECRET_STORE",
        `Agent ${agent.agent_profile_id} references API Profiles (${declared.join(", ")}), but the container has no Secret Store instance identity yet; unbind the API Profiles before deploying`,
      );
    }
    const file = JSON.stringify(
      {
        agent_profiles: [
          {
            agent_profile_id: agent.agent_profile_id,
            role_id: agent.role_id,
            name: agent.name,
            version: agent.version,
            adapter: agent.adapter,
            artifact_image: agent.artifact_image,
            entrypoint: agent.entrypoint,
            args: agent.args,
            allowed_tools: agent.allowed_tools,
            task_types: agent.task_types,
            model_api_profile_id: agent.model_api_profile_id,
            tool_api_profile_ids: agent.tool_api_profile_ids,
            limits: agent.limits,
            capabilities: agent.capabilities,
            enabled: agent.enabled,
            description: agent.description,
            system_prompt: agent.system_prompt,
            persona: agent.persona,
            tone: agent.tone,
            goals: agent.goals,
          },
        ],
        bindings: {
          [instanceId]: { agent_profile_id: agent.agent_profile_id, api_profile_ids: [] },
        },
      },
      null,
      2,
    );
    const env: Record<string, string> = {
      PROFILES_FILE: "/opt/platform/profiles.json",
      // Two-level allowlist: container env → Agent adapter → cli-agent.
      PLATFORM_AGENT_PASS_ENV: "ANTHROPIC_API_KEY,ANTHROPIC_BASE_URL",
    };
    // The scheduler entry point only reads SCHEDULER_* vars; the builder entry point reads AGENT_PROFILE_ID.
    if (roleId === "scheduler") {
      env.SCHEDULER_INSTANCE_ID = instanceId;
      env.SCHEDULER_AGENT_PROFILE_ID = agent.agent_profile_id;
    } else {
      env.AGENT_PROFILE_ID = agent.agent_profile_id;
    }
    return {
      files: [{ path: "/opt/platform/profiles.json", content: file }],
      agent_env: ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL"],
      env,
    };
  }

  /**
   * Deployment payload for built-in roles: the scheduler's service/SQL and the builder's instance runtime are both delivered by the control plane with the deployment.
   * The image stays official ubuntu; code updates only replace these files, with no image rebuild or transfer.
   */
  private roleAppFiles(role: "scheduler" | "builder"): Array<{ path: string; content: string }> {
    const dir = role === "scheduler" ? this.cfg.schedulerAppDir : this.cfg.builderAppDir;
    const code = role === "scheduler" ? "SCHEDULER_APP_MISSING" : "BUILDER_APP_MISSING";
    const label = role === "scheduler" ? "scheduler" : "builder";
    if (!fs.existsSync(dir)) {
      throw new PcsError(
        409,
        code,
        `${label} deployment payload does not exist: ${dir} (run scripts/build-app-payload.mjs and sync it to the control plane first)`,
      );
    }
    const files: Array<{ path: string; content: string }> = [];
    const walk = (abs: string, rel: string): void => {
      for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
        if (entry.name.startsWith(".")) continue;
        const childRel = rel ? `${rel}/${entry.name}` : entry.name;
        const childAbs = path.join(abs, entry.name);
        if (entry.isDirectory()) {
          walk(childAbs, childRel);
        } else {
          files.push({
            // The Agent Profile's entry point is fixed at /opt/platform/agents/cli-agent.mjs.
            path: childRel === "cli-agent.mjs"
              ? "/opt/platform/agents/cli-agent.mjs"
              // Codex's config directory is fixed at /opt/platform/codex (CODEX_HOME).
              : childRel.startsWith("codex/")
                ? `/opt/platform/${childRel}`
                : `/opt/platform/app/${childRel}`,
            content: fs.readFileSync(childAbs, "utf8"),
          });
        }
      }
    };
    walk(dir, "");
    if (!files.length) {
      throw new PcsError(409, code, `${label} deployment payload directory is empty: ${dir}`);
    }
    // The deployment channel's hard limits (≤16 files, 1MiB each) are validated here first, so a preview does not pass and then fail only on apply.
    validateFilesAndAgentEnv(files, undefined, {});
    return files;
  }

  // ---------------------------------------------------------------- Deployment plans (§4.6)

  /**
   * Preview a deployment plan and bind the digest.
   *
   * The plan performs no writes (other than recording the preview); apply rebuilds from the same intent, and any change
   * to host status, instance generation, or the number of active deployments on the host yields a different digest.
   */
  async previewDeploymentPlan(
    input: CreateDeploymentPlanInput,
    operator: string,
  ): Promise<DeploymentPlanView> {
    const host = await this.getHost(input.host_id);
    if (!host) throw notFound("HOST_NOT_FOUND", "target host not found");
    if (host.status === "REVOKED") throw forbidden("HOST_REVOKED", "target host has been revoked");
    if (!input.role_id?.trim()) throw new PcsError(400, "INVALID_ROLE", "role_id is required");

    // Deployment plans describe containers only; bare-metal roles are created directly from host settings and do not go through a plan.
    this.assertExecutionAllowed(host, input.role_id, "container");

    // Capability score is meaningful only for builders; schedulers and ordinary roles record 0.
    const capability =
      input.role_id === "builder"
        ? resolveCapability(input)
        : { score: 0, detail: {} };

    const count = Math.max(1, Math.min(Number(input.count ?? 1), 4));
    if (!Number.isInteger(count)) throw new PcsError(400, "INVALID_COUNT", "count must be between 1 and 4");

    // Names may be Chinese and are stored as display_name; the instance id is derived from it (container names/volume names/node id/database names all use the id).
    // Callers that pass instance_id directly are accepted in both forms: an already valid ASCII id is used as-is,
    // and everything else (including Chinese) is expanded via instanceIdFromName.
    const rawDisplayName = (input.display_name ?? "").trim();
    const rawInstanceId = (input.instance_id ?? "").trim();
    if (rawDisplayName.length > 32 || rawInstanceId.length > 64) {
      throw new PcsError(400, "INVALID_INSTANCE_NAME", "name must be at most 32 characters");
    }
    if (/[\u0000-\u001f\u007f]/.test(rawDisplayName) || /[\u0000-\u001f\u007f]/.test(rawInstanceId)) {
      throw new PcsError(400, "INVALID_INSTANCE_NAME", "name must not contain control characters");
    }
    const explicitName = rawInstanceId
      ? /^[a-z0-9][a-z0-9-]{0,47}$/.test(rawInstanceId)
        ? rawInstanceId
        : instanceIdFromName(rawInstanceId)
      : rawDisplayName
        ? instanceIdFromName(rawDisplayName)
        : "";

    const agent = input.agent_profile_id
      ? await this.getAgentProfile(String(input.agent_profile_id))
      : null;
    if (input.agent_profile_id && !agent) {
      throw notFound("AGENT_PROFILE_NOT_FOUND", "Agent Profile not found");
    }
    if (agent) {
      if (!agent.enabled) throw conflict("AGENT_PROFILE_DISABLED", "Agent Profile is disabled");
      if (agent.role_id !== input.role_id) {
        throw forbidden("AGENT_PROFILE_NOT_ALLOWED", "Agent Profile does not match the instance role", {
          agent_role: agent.role_id,
          instance_role: input.role_id,
        });
      }
    }

    const apiIds = unique((input.api_profile_ids ?? []).map(String));
    const apis: ApiProfileRow[] = [];
    for (const id of apiIds) {
      const p = await this.getApiProfile(id);
      if (!p) throw notFound("API_PROFILE_NOT_FOUND", `API Profile not found: ${id}`);
      if (!p.enabled) throw conflict("API_PROFILE_DISABLED", `API Profile is disabled: ${id}`);
      apis.push(p);
    }

    // Both built-in roles' images are decided by the system: the scheduler uses PCS_SCHEDULER_IMAGE, and the builder uses
    // PCS_BUILDER_IMAGES per OS (official ubuntu). Images in the UI/Profile serve only as a fallback.
    const osImage =
      input.role_id === "builder" && input.builder_os
        ? this.cfg.builderImages[input.builder_os]
        : undefined;
    const image =
      osImage ||
      input.image?.trim() ||
      (input.role_id === "scheduler" ? this.cfg.schedulerImage : null) ||
      agent?.artifact_image;
    if (!image) {
      throw new PcsError(
        400,
        "IMAGE_REQUIRED",
        input.role_id === "scheduler"
          ? "scheduler image is required: set artifact_image on the Agent Profile, or set PCS_SCHEDULER_IMAGE"
          : input.builder_os && Object.keys(this.cfg.builderImages).length
            ? `no image is configured for builder OS ${input.builder_os}: set PCS_BUILDER_IMAGES=${input.builder_os}=<ubuntu@sha256:…>`
            : "image is required, and the selected Agent Profile has no image",
      );
    }
    assertPinnedImage(image, this.cfg.imageAllowlist);
    // Built-in roles' apps are not in the image: the payload is written into the container with the deployment, and the image is just official ubuntu.
    const builtinRole =
      input.role_id === "scheduler" ? "scheduler" : input.role_id === "builder" ? "builder" : null;
    const appFiles = builtinRole ? this.roleAppFiles(builtinRole) : [];

    const active = (
      await query<{
        deployment_id: string;
        instance_id: string;
        display_name: string | null;
        role_id: string;
        generation: number | string;
        actual_state: string;
        desired_state: string;
        status: string;
        scheduler_role: "root" | "node" | null;
        parent_deployment_id: string | null;
        scheduler_url: string | null;
        scheduler_deployment_id: string | null;
        env: Record<string, string> | null;
      }>(
        `SELECT deployment_id, instance_id, display_name, role_id, generation,
                actual_state, desired_state, status, scheduler_role,
                parent_deployment_id, scheduler_url, scheduler_deployment_id, env
           FROM pcs_deployments
          WHERE host_id=$1 AND status <> 'REMOVED'
          ORDER BY created_at DESC`,
        [host.host_id],
      )
    ).rows;

    // Only one scheduler can be added at a time: the root is unique, and each node gets its own container.
    if (input.role_id === "scheduler" && count !== 1) {
      throw new PcsError(400, "INVALID_COUNT", "only one scheduler can be deployed at a time");
    }

    const used = new Set(active.map((r) => r.instance_id));
    const names: string[] = [];
    const itemInputs: Array<{ instance_id: string; display_name: string; existing: boolean }> = [];
    for (let i = 0; i < count; i++) {
      const explicit = i === 0 ? explicitName || undefined : undefined;
      const name = explicit || uniqueInstanceName(input.role_id, used);
      used.add(name);
      names.push(name);
      itemInputs.push({
        instance_id: name,
        // The first one uses the user-provided name (may be Chinese); the remaining instances in a batch deployment keep auto-generated ids.
        display_name: i === 0 && (rawDisplayName || rawInstanceId)
          ? rawDisplayName || rawInstanceId
          : name,
        existing: active.some((r) => r.instance_id === name),
      });
    }

    const ports = normalizePorts(input.ports);
    if (ports.some((p) => p.host + count - 1 > 65535)) {
      throw new PcsError(400, "INVALID_PORTS", "host ports allocated for multiple instances are out of range");
    }

    // Position resolution: the root scheduler is unique; a node hangs under an existing scheduler on the same host.
    const activeSchedulers = active.filter((r) => r.role_id === "scheduler");
    const schedulerPlacement =
      input.role_id === "scheduler"
        ? this.resolveSchedulerPlacement(host.host_id, itemInputs[0].instance_id, activeSchedulers as any, input)
        : null;
    const builderScheduler =
      input.role_id === "builder"
        ? input.scheduler_id
          ? this.resolveSchedulerRef(activeSchedulers as any, input.scheduler_id) ?? null
          : activeSchedulers.find((r) => (r.scheduler_role ?? "root") === "root") ??
            activeSchedulers[0] ??
            null
        : null;
    if (input.role_id === "builder" && input.scheduler_id && !builderScheduler) {
      throw notFound("SCHEDULER_NOT_FOUND", "the selected scheduler does not exist or is stopped");
    }
    const builderSchedulerUrl =
      builderScheduler?.scheduler_url ??
      this.cfg.schedulerUrls[host.host_id] ??
      this.cfg.schedulerUrl;
    const plannedSchedulerUrl =
      input.role_id === "scheduler"
        ? await this.schedulerUrlFor(host.host_id, ports)
        : null;

    // Scheduling mode is chosen once, on the root scheduler, and inherited by node schedulers and builders
    // on the same host. A builder without a scheduler falls back to the control-plane default.
    const modeOf = (d: any): "static" | "dynamic" | null => {
      const raw = String(d?.env?.SCHEDULING_MODE ?? "").toLowerCase();
      return raw === "dynamic" ? "dynamic" : raw === "static" ? "static" : null;
    };
    const rootScheduler = activeSchedulers.find((r) => (r.scheduler_role ?? "root") === "root") ?? null;
    const inheritedSchedulingMode: "static" | "dynamic" =
      input.role_id === "scheduler"
        ? schedulerPlacement?.role === "root"
          ? (input.scheduling_mode ?? this.cfg.schedulingMode)
          : (modeOf(schedulerPlacement?.parent) ??
            modeOf(rootScheduler) ??
            this.cfg.schedulingMode)
        : input.role_id === "builder"
          ? (modeOf(builderScheduler) ?? modeOf(rootScheduler) ?? this.cfg.schedulingMode)
          : this.cfg.schedulingMode;

    const env: Record<string, string> = { ...(input.env ?? {}) };
    assertNoSecretsInEnv(env);
    const volumes = (input.volumes ?? []).map((v) => this.validateVolume(v));
    const profile = normalizeResourceProfile(input.resource_profile ?? {});
    const policy = input.network_policy ?? "default";
    if (!this.cfg.networkPolicies.includes(policy)) {
      throw new PcsError(400, "NETWORK_POLICY_NOT_ALLOWED", `network policy is not in the allowlist: ${policy}`, {
        allowlist: this.cfg.networkPolicies,
      });
    }
    // The official ubuntu image has no ENTRYPOINT; the entry script comes from the deployment payload.
    const command = input.command
      ? this.validateCommand(input.command)
      : builtinRole
        ? ["/bin/bash", "/opt/platform/app/entrypoint.sh"]
        : undefined;
    const configVersion = input.config_version ?? 1;

    const maxRows = (
      await query<{ instance_id: string; max_generation: number | string }>(
        `SELECT instance_id, COALESCE(MAX(generation),0) AS max_generation
           FROM pcs_deployments
          WHERE host_id = $1 AND instance_id = ANY($2::text[])
          GROUP BY instance_id`,
        [host.host_id, itemInputs.map((x) => x.instance_id)],
      )
    ).rows;
    const maxByInstance = new Map(maxRows.map((r) => [r.instance_id, Number(r.max_generation)]));

    const items: DeploymentPlanItem[] = itemInputs.map((x, index) => {
      // The container entry point uses these env vars to build the instance config; the control plane injects them uniformly, so callers need not fill them in again.
      const instanceEnv: Record<string, string> = {
        INSTANCE_ID: x.instance_id,
        ROLE_ID: input.role_id,
        HOST_ID: host.host_id,
      };
      if (input.role_id === "builder") {
        if (input.builder_os) instanceEnv.BUILDER_OS = input.builder_os;
        // W enters the container with the deployment env, and the builder reports it verbatim on registration; the scheduler uses it to filter by task difficulty.
        instanceEnv.CAPABILITY_SCORE = String(capability.score);
        if (Object.keys(capability.detail).length) {
          instanceEnv.CAPABILITY_DETAIL = JSON.stringify(capability.detail);
        }
        // The builder registers with the selected scheduler; if none is selected, use this host's root scheduler, falling back to the control plane config.
        if (builderSchedulerUrl) instanceEnv.SCHEDULER_URL = builderSchedulerUrl;
        // Dynamic mode needs the instance cap and the inherited mode; static builders ignore both at runtime.
        instanceEnv.SCHEDULING_MODE = inheritedSchedulingMode;
        instanceEnv.RESOURCE_CPU_MILLICORES = String(
          Math.max(0, Math.round(Number(profile.cpu_limit) * 1000)),
        );
        instanceEnv.RESOURCE_MEMORY_BYTES = String(Math.max(0, Number(profile.memory_limit_bytes)));
      }
      if (input.role_id === "scheduler" && schedulerPlacement) {
        // The entry script registers agent-runtime with the instance id; names may be Chinese, so this must be the derived ASCII id.
        instanceEnv.SCHEDULER_INSTANCE_ID = x.instance_id;
        // Node identity must be at the instance level: the root and nodes on the same host must each have a distinct node_id.
        instanceEnv.SCHEDULER_NODE_ID = `${host.host_id}:${x.instance_id}`;
        instanceEnv.SCHEDULER_HOST_ID = host.host_id;
        instanceEnv.SCHEDULER_ROLE = schedulerPlacement.role;
        instanceEnv.SCHEDULING_MODE = inheritedSchedulingMode;
        if (this.cfg.dynamicPolicyJson) {
          instanceEnv.DYNAMIC_POLICY = this.cfg.dynamicPolicyJson;
        }
        // The root needs a token too: it validates child-node reports; a node also needs to know where to report.
        instanceEnv.SCHEDULER_FEDERATION_TOKEN = this.federationToken;
        // The parent node must be able to call back to this machine when relaying tasks.
        if (plannedSchedulerUrl) instanceEnv.SCHEDULER_ADVERTISE_URL = plannedSchedulerUrl;
        if (schedulerPlacement.role === "node" && schedulerPlacement.parent) {
          const parentUrl =
            schedulerPlacement.parent.scheduler_url ??
            this.cfg.schedulerUrls[schedulerPlacement.parent.host_id] ??
            this.cfg.schedulerUrl;
          if (parentUrl) instanceEnv.SCHEDULER_PARENT_URL = parentUrl;
        }
        if (!env.DATABASE_URL) {
          const dbUrl = this.schedulerDatabaseUrlFor(
            host.host_id,
            x.instance_id,
            schedulerPlacement.role,
          );
          if (!dbUrl) {
            throw new PcsError(
              400,
              "SCHEDULER_DATABASE_MISSING",
              "scheduler database is not configured: set PCS_SCHEDULER_DATABASE_URL or PCS_SCHEDULER_DATABASE_URLS",
            );
          }
          instanceEnv.DATABASE_URL = dbUrl;
        }
      }
      if (agent?.agent_profile_id) instanceEnv.AGENT_PROFILE_ID = agent.agent_profile_id;
      // When an Agent is bound, deliver the Profile view together with the credential variable names; with no binding, keep the original behavior.
      const delivery = agent ? this.agentDelivery(agent, input.role_id, x.instance_id) : null;
      const files = [...(delivery?.files ?? []), ...appFiles];
      return {
        instance_id: x.instance_id,
        display_name: x.display_name,
        role_id: input.role_id,
        image,
        resource_profile: profile,
        env: { ...instanceEnv, ...(delivery?.env ?? {}), ...env },
        volumes,
        // With multiple instances, host ports increment sequentially to avoid port conflicts on the same host.
        ports: ports.map((p) => ({ container: p.container, host: p.host + index })),
        network_policy: policy,
        command: command ?? null,
        config_version: configVersion,
        generation: (maxByInstance.get(x.instance_id) ?? 0) + 1,
        agent_profile_id: agent?.agent_profile_id ?? null,
        api_profile_ids: apiIds,
        capability_score: capability.score,
        capability_detail: capability.detail,
        scheduler_role: input.role_id === "scheduler" ? schedulerPlacement!.role : undefined,
        parent_deployment_id: schedulerPlacement?.parent?.deployment_id ?? null,
        scheduler_url: plannedSchedulerUrl,
        scheduler_deployment_id: builderScheduler?.deployment_id ?? null,
        ...(files.length ? { files } : {}),
        ...(delivery ? { agent_env: delivery.agent_env } : {}),
      };
    });

    const interrupt = active.some(
      (r) =>
        itemInputs.some((x) => x.instance_id === r.instance_id) &&
        r.actual_state === "RUNNING" &&
        r.desired_state === "RUNNING",
    );

    const resources = (host.resources ?? {}) as Record<string, unknown>;
    const availableBytes = Number(resources.mem_available_bytes);
    const requiredBytes = profile.memory_limit_bytes * items.length;
    const checks: Array<{ id: string; ok: boolean; detail: string }> = [
      {
        id: "host_online",
        ok: host.status === "ONLINE" || host.status === "DEGRADED",
        detail: `host status ${host.status}`,
      },
      {
        id: "image_pinned",
        ok: /@sha256:[a-f0-9]{64}$/i.test(image),
        detail: `image ${image}`,
      },
      {
        id: "network_policy",
        ok: this.cfg.networkPolicies.includes(policy),
        detail: `network policy ${policy}`,
      },
      {
        id: "agent_binding",
        ok: !agent || agent.role_id === input.role_id,
        detail: agent ? `Agent ${agent.agent_profile_id} → ${input.role_id}` : "no Agent bound",
      },
      {
        id: "api_bindings",
        ok: apis.every((p) => p.enabled),
        detail: apiIds.length ? `API ${apiIds.join(", ")}` : "no API bound",
      },
    ];
    if (input.role_id === "builder") {
      const schedulerUrl = env.SCHEDULER_URL || this.cfg.schedulerUrl;
      checks.push({
        id: "scheduler_url",
        ok: Boolean(schedulerUrl),
        detail: schedulerUrl ? `scheduler ${schedulerUrl}` : "scheduler address is required: set PCS_SCHEDULER_URL",
      });
    }
    if (Number.isFinite(availableBytes) && availableBytes > 0) {
      checks.push({
        id: "memory_budget",
        ok: requiredBytes <= availableBytes,
        detail: `requires ${Math.round(requiredBytes / 1024 ** 2)}MiB, available ${Math.round(
          availableBytes / 1024 ** 2,
        )}MiB`,
      });
    } else {
      checks.push({
        id: "memory_budget",
        ok: false,
        detail: "the host has not reported available memory yet; resource admission cannot complete",
      });
    }
    const failed = checks.filter((c) => !c.ok);
    if (failed.length) {
      throw new PcsError(409, "DEPLOYMENT_CHECK_FAILED", "pre-deployment checks failed", { checks });
    }

    // v4 has no reviewer role; only deployments that "would interrupt a running build" raise the risk warning.
    const risk: "LOW" | "MEDIUM" | "HIGH" = interrupt ? "HIGH" : "MEDIUM";
    const intent: DeploymentPlanIntent = { host_id: host.host_id, items };
    const digestInput = this.planDigestInput(host, active.length, intent);
    const digest = planDigest(digestInput);
    const planId = newId("plan");
    const now = nowMs();
    const createdAt = iso(now);
    const expiresAt = iso(now + 10 * 60 * 1000);
    const view: DeploymentPlanView = {
      plan_id: planId,
      plan_digest: digest,
      host_id: host.host_id,
      host_name: host.hostname,
      host_state: host.status,
      role: input.role_id,
      names,
      count,
      agent_profile_id: agent?.agent_profile_id ?? null,
      api_profile_ids: apiIds,
      resource_profile: profile,
      image,
      limits: {
        cpus: profile.cpu_limit,
        mem_mb: Math.round(profile.memory_limit_bytes / 1024 ** 2),
        pids: profile.pids_limit ?? 512,
      },
      network_policy: policy,
      config_version: configVersion,
      generation: Math.max(...items.map((x) => x.generation)),
      budget_remaining_mb: Number.isFinite(availableBytes)
        ? Math.round(availableBytes / 1024 ** 2)
        : null,
      interrupts_running: interrupt,
      risk,
      rollback_strategy: interrupt
        ? "keep the previous generation; on health-check failure, stop the new instance and roll back to the previous image digest"
        : "no previous version; on failure, keep the deployment record and stop the new container",
      checks,
      // The browser only needs to know what is being deployed; values like DATABASE_URL in env must not leave the control plane,
      // and the app bundle in files should not be stuffed into the plan view either.
      items: items.map(({ files, agent_env, ...item }) => ({
        ...item,
        env: redactEnvForView(item.env),
      })),
      created_at: createdAt,
      expires_at: expiresAt,
    };

    await query(
      `INSERT INTO deployment_plans (plan_id, plan_digest, intent, plan, created_by, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [planId, digest, JSON.stringify(intent), JSON.stringify(view), operator, expiresAt],
    );
    await this.audit(operator, "deployment.plan.preview", planId, null, {
      host_id: host.host_id,
      role_id: input.role_id,
      count,
      plan_digest: digest,
      expires_at: expiresAt,
    });
    return view;
  }

  private planDigestInput(host: HostRow, activeDeployments: number, intent: DeploymentPlanIntent) {
    return {
      host_id: host.host_id,
      host_state: host.status,
      active_deployments: activeDeployments,
      items: intent.items.map((item) => ({
        instance_id: item.instance_id,
        display_name: item.display_name,
        role_id: item.role_id,
        image: item.image,
        resource_profile: item.resource_profile,
        env: item.env,
        volumes: item.volumes,
        ports: item.ports,
        network_policy: item.network_policy,
        command: item.command,
        config_version: item.config_version,
        generation: item.generation,
        agent_profile_id: item.agent_profile_id,
        api_profile_ids: item.api_profile_ids,
        capability_score: item.capability_score,
        capability_detail: item.capability_detail,
        scheduler_role: item.scheduler_role,
        parent_deployment_id: item.parent_deployment_id,
        scheduler_url: item.scheduler_url,
        scheduler_deployment_id: item.scheduler_deployment_id,
        files: item.files,
        agent_env: item.agent_env,
      })),
    };
  }

  async applyDeploymentPlan(
    planId: string,
    input: { plan_digest: string },
    operator: string,
  ): Promise<{ plan: DeploymentPlanView; deployments: DeploymentRow[] }> {
    const row = (
      await query<{
        plan_id: string;
        plan_digest: string;
        intent: DeploymentPlanIntent;
        plan: DeploymentPlanView;
        applied_at: string | null;
        expires_at: string;
      }>(`SELECT * FROM deployment_plans WHERE plan_id=$1`, [planId])
    ).rows[0];
    if (!row) throw notFound("PLAN_NOT_FOUND", "deployment plan not found");
    if (row.applied_at) throw conflict("PLAN_ALREADY_APPLIED", "deployment plan has already been applied");
    if (new Date(row.expires_at).getTime() <= nowMs()) {
      throw new PcsError(410, "PLAN_EXPIRED", "deployment plan has expired; please preview again");
    }
    if (input.plan_digest !== row.plan_digest) {
      throw conflict("PLAN_CHANGED", "plan_digest does not match the preview record; please preview again", {
        expected: row.plan_digest,
        got: input.plan_digest,
      });
    }

    const host = await this.getHost(row.intent.host_id);
    if (!host) throw notFound("HOST_NOT_FOUND", "target host not found");
    if (host.status === "REVOKED") throw forbidden("HOST_REVOKED", "target host has been revoked");

    // Recompute: changes to host status / active deployment count / generation all change the digest.
    const activeCount = Number(
      (
        await query<{ n: number }>(
          `SELECT count(*)::int AS n FROM pcs_deployments
            WHERE host_id=$1 AND status <> 'REMOVED'`,
          [host.host_id],
        )
      ).rows[0]?.n ?? 0,
    );
    const currentDigest = planDigest(this.planDigestInput(host, activeCount, row.intent));
    if (currentDigest !== row.plan_digest) {
      throw conflict("PLAN_CHANGED", "the host state the deployment plan depends on has changed; please preview again", {
        expected: row.plan_digest,
        current: currentDigest,
      });
    }

    const resources = (host.resources ?? {}) as Record<string, unknown>;
    const availableBytes = Number(resources.mem_available_bytes);
    const requiredBytes = row.intent.items.reduce(
      (sum, item) => sum + item.resource_profile.memory_limit_bytes,
      0,
    );
    if (Number.isFinite(availableBytes) && availableBytes > 0 && requiredBytes > availableBytes) {
      throw new PcsError(409, "DEPLOYMENT_CHECK_FAILED", "the host does not have enough available memory; please preview again", {
        required_bytes: requiredBytes,
        available_bytes: availableBytes,
      });
    }

    const deploymentIds: string[] = [];
    const deployments: DeploymentRow[] = [];
    try {
      for (const item of row.intent.items) {
        const out = await this.createDeployment(
          {
            host_id: host.host_id,
            instance_id: item.instance_id,
            role_id: item.role_id,
            display_name: item.display_name,
            image: item.image,
            resource_profile: item.resource_profile,
            env: item.env,
            volumes: item.volumes,
            ports: item.ports,
            network_policy: item.network_policy,
            command: item.command ?? undefined,
            config_version: item.config_version,
            capability_score: item.capability_score,
            capability_detail: item.capability_detail,
            scheduler_role: item.scheduler_role,
            parent_scheduler_id: item.parent_deployment_id ?? undefined,
            scheduler_id: item.scheduler_deployment_id ?? undefined,
            files: item.files,
            agent_env: item.agent_env,
            created_by: operator,
          },
          { expected_generation: item.generation },
        );
        deploymentIds.push(out.deployment.deployment_id);
        deployments.push(out.deployment);
        if (item.agent_profile_id) {
          await this.bindAgent(
            host.host_id,
            item.instance_id,
            item.agent_profile_id,
            item.role_id,
            operator,
          );
        }
        for (const apiId of item.api_profile_ids) {
          await this.bindApi(host.host_id, item.instance_id, apiId, operator);
        }
      }
    } catch (e) {
      await query(
        `UPDATE deployment_plans
            SET applied_at=now(), deployment_ids=$2
          WHERE plan_id=$1`,
        [planId, deploymentIds],
      );
      if (e instanceof PcsError) throw e;
      throw new PcsError(500, "PLAN_APPLY_PARTIAL", "deployment was interrupted; the plan is void, please preview again", {
        deployment_ids: deploymentIds,
        error: e instanceof Error ? e.message : String(e),
      });
    }

    await query(
      `UPDATE deployment_plans
          SET applied_at=now(), deployment_ids=$2
        WHERE plan_id=$1`,
      [planId, deploymentIds],
    );
    await this.audit(operator, "deployment.plan.apply", planId, null, {
      host_id: host.host_id,
      plan_digest: row.plan_digest,
      deployment_ids: deploymentIds,
    });
    // Older plans may still contain unredacted env; redact it once more uniformly in the receipt.
    const planView = row.plan && Array.isArray(row.plan.items)
      ? { ...row.plan, items: row.plan.items.map((item) => ({ ...item, env: redactEnvForView(item.env ?? {}) })) }
      : row.plan;
    return { plan: planView, deployments };
  }

  // ---------------------------------------------------------------- Approval tokens

  /**
   * The admin app issues a one-time approval token.
   *
   * The token binds only the request/digest/action_scope supplied by the caller; when deciding, the scheduler compares it
   * item by item against the pending request in decideApproval, and any tampering yields 403/409. Fails closed when MFA is not configured.
   */
  issueApprovalToken(
    input: ApprovalTokenInput,
    claims: JwtClaims,
  ): {
    approval_token: string;
    expires_at: string;
    operator_id: string;
    approval_request_id: string;
    subject_digest: string | null;
    action_scope: string[];
  } {
    if (!this.cfg.approvalMfaCode) {
      throw new PcsError(503, "MFA_NOT_CONFIGURED", "approval MFA is not configured on the PCS; refusing to issue an approval token");
    }
    if (!input.approval_request_id?.trim()) {
      throw new PcsError(400, "BAD_REQUEST", "approval_request_id is required");
    }
    if (!input.mfa_code || input.mfa_code !== this.cfg.approvalMfaCode) {
      throw new PcsError(403, "MFA_REQUIRED", "MFA verification failed; refusing to issue an approval token");
    }
    const operator = String(claims.operator_id ?? claims.sub ?? "");
    if (input.operator_id && input.operator_id !== operator) {
      throw forbidden("ROLE_NOT_ALLOWED", "the approver must be the currently logged-in operator", {
        token_operator: operator,
        requested: input.operator_id,
      });
    }
    const actionScope = unique((input.action_scope ?? []).map(String));
    const subjectDigest = input.subject_digest ?? null;
    const iat = Math.floor(nowMs() / 1000);
    const exp = iat + 10 * 60;
    const approval_token = signJwt(
      {
        iss: ISSUER,
        aud: SCHEDULER_AUDIENCE,
        sub: `operator:${operator}`,
        typ: "approval",
        approval_request_id: input.approval_request_id,
        operator_id: operator,
        subject_digest: subjectDigest,
        action_scope: actionScope,
        scopes: ["approval:decide"],
        iat,
        exp,
        jti: newId("tok"),
      },
      this.jwtPrivateKey,
    );
    void this.audit(operator, "approval_token.issue", input.approval_request_id, null, {
      task_id: input.task_id ?? null,
      subject_digest: subjectDigest,
      action_scope: actionScope,
      expires_at: iso(exp * 1000),
    }).catch((e) => console.error("[audit] approval_token.issue", e));
    return {
      approval_token,
      expires_at: iso(exp * 1000),
      operator_id: operator,
      approval_request_id: input.approval_request_id,
      subject_digest: subjectDigest,
      action_scope: actionScope,
    };
  }

  // ---------------------------------------------------------------- Command channel

  /**
   * Long-poll for commands. A DELIVERED command past the redelivery window returns to PENDING; once retries are exhausted it becomes FAILED.
   * Commands are idempotent by command_id, and Host Runtime deduplicates repeated deliveries.
   */
  async nextCommand(
    hostId: string,
    waitSeconds: number,
    signal?: AbortSignal,
  ): Promise<CommandRow | null> {
    const deadline = nowMs() + Math.max(0, Math.min(waitSeconds, 60)) * 1000;
    while (!signal?.aborted) {
      const cmd = await this.claimOnce(hostId);
      if (cmd) return cmd;
      if (nowMs() >= deadline) return null;
      await sleep(400, signal);
    }
    return null;
  }

  private async claimOnce(hostId: string): Promise<CommandRow | null> {
    return tx(async (c) => {
      const redeliver = this.cfg.commandRedeliverSeconds;
      await c.query(
        `UPDATE pcs_commands
            SET state='PENDING', delivered_at=NULL
          WHERE host_id=$1 AND state='DELIVERED'
            AND delivered_at < now() - make_interval(secs => $2)
            AND attempts < $3 AND expires_at > now()`,
        [hostId, redeliver, this.cfg.commandMaxAttempts],
      );
      await c.query(
        `UPDATE pcs_commands
            SET state='FAILED', result='{"code":"COMMAND_TIMEOUT"}', acked_at=now()
          WHERE host_id=$1 AND state='DELIVERED'
            AND delivered_at < now() - make_interval(secs => $2)
            AND attempts >= $3 AND expires_at > now()`,
        [hostId, redeliver, this.cfg.commandMaxAttempts],
      );
      await c.query(
        `UPDATE pcs_commands SET state='EXPIRED'
          WHERE host_id=$1 AND state IN ('PENDING','DELIVERED') AND expires_at <= now()`,
        [hostId],
      );

      const r = await c.query(
        `WITH candidate AS (
           SELECT command_id FROM pcs_commands
            WHERE host_id=$1 AND state='PENDING' AND expires_at > now()
            ORDER BY created_at ASC
            LIMIT 1
            FOR UPDATE SKIP LOCKED
         )
         UPDATE pcs_commands c
            SET state='DELIVERED', attempts=c.attempts+1, delivered_at=now()
           FROM candidate
          WHERE c.command_id=candidate.command_id
          RETURNING c.*`,
        [hostId],
      );
      return (r.rows[0] as CommandRow | undefined) ?? null;
    });
  }

  async ackCommand(
    hostId: string,
    commandId: string,
    ok: boolean,
    result: Record<string, unknown>,
  ): Promise<{ command_id: string; state: string; idempotent?: boolean }> {
    return tx(async (c) => {
      const cmd = (
        await c.query(
          `SELECT * FROM pcs_commands WHERE command_id=$1 AND host_id=$2 FOR UPDATE`,
          [commandId, hostId],
        )
      ).rows[0] as CommandRow | undefined;
      if (!cmd) throw notFound("COMMAND_NOT_FOUND", "command not found or does not belong to this host");
      if (cmd.state === "ACKED") {
        return { command_id: commandId, state: "ACKED", idempotent: true };
      }
      if (cmd.state === "EXPIRED") throw conflict("COMMAND_EXPIRED", "command has expired; refusing to execute");
      if (cmd.state === "FAILED" && ok) {
        throw conflict("COMMAND_ALREADY_FAILED", "command already failed due to timeout and can no longer be acknowledged as successful");
      }

      const state = ok ? "ACKED" : "FAILED";
      await c.query(
        `UPDATE pcs_commands SET state=$2, result=$3, acked_at=now() WHERE command_id=$1`,
        [commandId, state, JSON.stringify(result ?? {})],
      );

      if (cmd.deployment_id) {
        // Generation guard: a superseded command may be acknowledged after a newer one was enqueued.
        // Applying its result would overwrite the newer desired state (for example, a late failure ack
        // for a retried REMOVE would flip the deployment back to FAILED).
        if (!ok) {
          await c.query(
            `UPDATE pcs_deployments
                SET status='FAILED', actual_state='FAILED', observed=$2, updated_at=now()
              WHERE deployment_id=$1 AND generation <= $3`,
            [cmd.deployment_id, JSON.stringify({ error: result }), cmd.generation],
          );
        } else {
          const update =
            cmd.command_type === "STOP"
              ? `status='STOPPED', actual_state='STOPPED'`
              : cmd.command_type === "REMOVE"
                ? `status='REMOVED', actual_state='REMOVED', desired_state='REMOVED'`
                : `status='STARTING', actual_state='STARTING'`;
          const applied = await c.query(
            `UPDATE pcs_deployments SET ${update}, observed=$2, updated_at=now()
              WHERE deployment_id=$1 AND generation <= $3`,
            [cmd.deployment_id, JSON.stringify({ ack: result }), cmd.generation],
          );
          // A removed instance cannot use its profiles any more. Keeping the bindings would silently
          // reconfigure a later deployment with the same name and would block profile deletion forever.
          // Skip when another live deployment still owns the instance name on this host (superseded remove).
          if (cmd.command_type === "REMOVE" && cmd.instance_id && applied.rowCount) {
            const live = await c.query(
              `SELECT 1 FROM pcs_deployments
                WHERE host_id=$1 AND instance_id=$2 AND status <> 'REMOVED'
                LIMIT 1`,
              [cmd.host_id, cmd.instance_id],
            );
            if (!live.rowCount) {
              await c.query(`DELETE FROM role_agent_bindings WHERE host_id=$1 AND instance_id=$2`, [
                cmd.host_id,
                cmd.instance_id,
              ]);
              await c.query(`DELETE FROM role_api_bindings WHERE host_id=$1 AND instance_id=$2`, [
                cmd.host_id,
                cmd.instance_id,
              ]);
            }
          }
        }
      }

      return { command_id: commandId, state };
    });
  }

  // ---------------------------------------------------------------- Reports

  async storeReport(host: HostRow, body: Record<string, any>): Promise<{ ok: true }> {
    const containers: Array<Record<string, any>> = Array.isArray(body.containers)
      ? body.containers
      : [];
    const state = String(body.host_state ?? "NORMAL");

    await tx(async (c) => {
      await c.query(
        `INSERT INTO pcs_host_reports (host_id, payload, received_at)
         VALUES ($1,$2,now())
         ON CONFLICT (host_id) DO UPDATE SET payload=EXCLUDED.payload, received_at=now()`,
        [host.host_id, JSON.stringify(body)],
      );
      await c.query(
        `UPDATE pcs_hosts
            SET last_seen_at=now(), updated_at=now(), resources=$2,
                status = CASE WHEN $3 = 'NORMAL' THEN 'ONLINE' ELSE 'DEGRADED' END
          WHERE host_id=$1 AND status <> 'REVOKED'`,
        [host.host_id, JSON.stringify(body.resources ?? {}), state],
      );
      await this.upsertRuntime(c, host.host_id, body.runtime ?? {});

      const seen: string[] = [];
      for (const ct of containers) {
        if (!ct?.instance_id) continue;
        seen.push(String(ct.instance_id));
        const running = ct.state === "running";
        const actual = running
          ? "RUNNING"
          : ct.state === "exited" || ct.state === "dead"
            ? "STOPPED"
            : "STARTING";
        await c.query(
          `UPDATE pcs_deployments
              SET actual_state=$2,
                  status = CASE
                    WHEN status = 'REMOVED' THEN status
                    WHEN $2 = 'RUNNING' AND $3 <> 'unhealthy' THEN 'HEALTHY'
                    WHEN $2 = 'STOPPED' AND desired_state = 'STOPPED' THEN 'STOPPED'
                    ELSE status END,
                  observed=$4, updated_at=now()
            WHERE deployment_id = COALESCE(
              NULLIF($6,''),
              (SELECT deployment_id FROM pcs_deployments
                WHERE instance_id=$1 AND host_id=$5 AND status <> 'REMOVED'
                ORDER BY created_at DESC LIMIT 1))`,
          [
            ct.instance_id,
            actual,
            String(ct.health ?? "none"),
            JSON.stringify(ct),
            host.host_id,
            // When the container carries a deployment_id, match by it: an instance name may be reused by the previous deployment generation,
            // and updating by instance_id would attribute an old container's state to the new deployment (showing HEALTHY although nothing is running).
            String(ct.deployment_id ?? ""),
          ],
        );
      }

      // Containers expected to run but absent from this report: mark them MISSING first, hand them to the reconciler, and do not declare them dead immediately
      await c.query(
        `UPDATE pcs_deployments
            SET actual_state='MISSING', updated_at=now()
          WHERE host_id=$1 AND desired_state='RUNNING'
            AND status IN ('STARTING','HEALTHY','PENDING','PLANNED')
            AND instance_id <> ALL($2::text[])`,
        [host.host_id, seen],
      );
    });

    // The scheduler maintains its own host roster, and instance registration requires the host to already be in it.
    // A failed push does not affect the report (the next heartbeat retries), and the PCS does not stall just because a scheduler is unavailable.
    void this.pushHostToScheduler(host.host_id, state);
    // After a scheduler restart or a parent address change, the heartbeat pushes the federation parent again.
    void this.syncFederationParent(host.host_id);

    return { ok: true };
  }

  /**
   * Host merge is just one reference row in `pcs_hosts.parent_host_id`:
   * here we push "the parent root scheduler's address" to this host's root scheduler so it starts reporting ΣW upward;
   * on detach, push null. Containers are not restarted, and the scheduler's reporting cycle takes effect automatically.
   */
  private async syncFederationParent(hostId: string): Promise<void> {
    try {
      const child = (
        await query<{ parent_host_id: string | null }>(
          `SELECT parent_host_id FROM pcs_hosts WHERE host_id=$1`,
          [hostId],
        )
      ).rows[0];
      if (!child) return;
      const parentHostId = child.parent_host_id;
      let parentUrl: string | null = null;
      if (parentHostId) {
        const parent = (
          await query<{ scheduler_url: string | null }>(
            `SELECT scheduler_url FROM pcs_deployments
              WHERE host_id=$1 AND role_id='scheduler'
                AND COALESCE(scheduler_role, 'root') = 'root'
                AND status IN ('STARTING','HEALTHY')
                AND scheduler_url IS NOT NULL
              ORDER BY created_at DESC LIMIT 1`,
            [parentHostId],
          )
        ).rows[0];
        parentUrl = String(parent?.scheduler_url ?? "").trim() || null;
        if (!parentUrl) {
          // The parent's root scheduler is not deployed yet: keep the status quo and push again on the next heartbeat.
          return;
        }
      }
      const roots = (
        await query<{ scheduler_url: string | null }>(
          `SELECT DISTINCT scheduler_url FROM pcs_deployments
            WHERE host_id=$1 AND role_id='scheduler'
              AND COALESCE(scheduler_role, 'root') = 'root'
              AND status IN ('STARTING','HEALTHY')
              AND scheduler_url IS NOT NULL`,
          [hostId],
        )
      ).rows;
      await Promise.all(
        roots.map(async (r) => {
          const base = String(r.scheduler_url ?? "").trim();
          if (!base) return;
          try {
            const resp = await fetch(`${base.replace(/\/+$/, "")}/v1/federation/parent`, {
              method: "POST",
              headers: {
                "content-type": "application/json",
                "x-federation-token": this.federationToken,
              },
              body: JSON.stringify({ parent_url: parentUrl }),
              signal: AbortSignal.timeout(3000),
            });
            if (!resp.ok) {
              console.warn(`[federation-sync] ${hostId} ${base} HTTP ${resp.status}`);
            }
          } catch (e) {
            console.warn(`[federation-sync] ${hostId} ${base} ${(e as Error).message}`);
          }
        }),
      );
    } catch (e) {
      console.warn(`[federation-sync] ${hostId} ${(e as Error).message}`);
    }
  }

  /** Push host status and resources to the scheduler, for admission and budget decisions when claiming tasks. */
  private async pushHostToScheduler(hostId: string, hostState: string): Promise<void> {
    // Each scheduler has its own database, so the host roster is pushed to every scheduler on this host (root + nodes);
    // otherwise a builder registering with a node reports HOST_UNKNOWN. Falls back to the control plane config when no scheduler is registered.
    const r = await query<{ hostname: string; os: string; arch: string; resources: any }>(
      `SELECT hostname, os, arch, resources FROM pcs_hosts WHERE host_id=$1`,
      [hostId],
    );
    const row = r.rows[0];
    if (!row) return;
    const active = await query<{ scheduler_url: string | null }>(
      `SELECT DISTINCT scheduler_url FROM pcs_deployments
        WHERE host_id=$1 AND role_id='scheduler' AND scheduler_url IS NOT NULL
          AND status IN ('STARTING','HEALTHY')`,
      [hostId],
    );
    const bases = new Set<string>(
      active.rows.map((x) => String(x.scheduler_url ?? "").trim()).filter(Boolean),
    );
    const fallback =
      this.cfg.schedulerUrls[hostId] ?? this.cfg.schedulerSyncUrl ?? this.cfg.schedulerUrl;
    if (bases.size === 0 && fallback) bases.add(fallback);
    if (bases.size === 0) return;
    const res = (row.resources ?? {}) as Record<string, any>;
    const body = JSON.stringify({
      host_id: hostId,
      name: row.hostname,
      os: row.os,
      arch: row.arch,
      host_state: hostState,
      cpu_total: Number(res.cpu_count ?? 0) || undefined,
      mem_total_bytes: Number(res.mem_total_bytes ?? 0),
      mem_available_bytes: Number(res.mem_available_bytes ?? 0),
      // Dynamic scheduling: the host-runtime's cgroup pool snapshot drives grants and pressure.
      resource_pool:
        res.pool && typeof res.pool === "object" && !Array.isArray(res.pool)
          ? res.pool
          : undefined,
    });
    await Promise.all(
      [...bases].map(async (base) => {
        try {
          const resp = await fetch(`${base.replace(/\/+$/, "")}/v1/hosts`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body,
            signal: AbortSignal.timeout(3000),
          });
          if (!resp.ok) console.warn(`[scheduler-sync] ${hostId} ${base} HTTP ${resp.status}`);
        } catch (e) {
          console.warn(`[scheduler-sync] ${hostId} ${base} ${(e as Error).message}`);
        }
      }),
    );
  }

  // ---------------------------------------------------------------- Agent / API Profile (P4)

  /**
   * Entry point for creating an Agent Profile.
   *
   * Only the PCS can define "which role allows which Adapter, and which tools this Agent can use".
   * Neither the task payload nor the Agent's own output can expand these two sets.
   */
  async createAgentProfile(input: CreateAgentProfileInput, operator: string): Promise<AgentProfileRow> {
    const roleId = String(input.role_id ?? "").trim();
    const adapter = String(input.adapter ?? "").trim();
    if (!roleId) throw new PcsError(400, "INVALID_PROFILE", "role_id is required");
    if (!AGENT_ADAPTERS[roleId]) {
      throw new PcsError(400, "ROLE_AGENT_NOT_ALLOWED", `role ${roleId} is not allowed to run an Agent`);
    }
    if (!AGENT_ADAPTERS[roleId].includes(adapter)) {
      throw new PcsError(
        400,
        "ADAPTER_NOT_ALLOWED",
        `role ${roleId} does not allow ${adapter || "(empty)"}; allowed: ${AGENT_ADAPTERS[roleId].join(",")}`,
      );
    }
    const version = String(input.version ?? "").trim();
    if (!version) throw new PcsError(400, "INVALID_PROFILE", "version is required");
    const name = String(input.name ?? "").trim();
    if (!name) throw new PcsError(400, "INVALID_PROFILE", "name is required");
    const image = String(input.artifact_image ?? "").trim();
    // Allowing no Agent image: adapters such as http-local run directly in the instance image.
    if (image) assertPinnedImage(image, this.cfg.imageAllowlist);

    const profileId = String(input.agent_profile_id ?? "").trim() || newId("agp");
    const modelApiId = input.model_api_profile_id ? String(input.model_api_profile_id).trim() : null;
    if (modelApiId) {
      const modelApi = await this.getApiProfile(modelApiId);
      if (!modelApi) notFound("MODEL_API_NOT_FOUND", `model API Profile not found: ${modelApiId}`);
      if (modelApi.kind !== "llm") {
        throw new PcsError(400, "MODEL_API_NOT_LLM", "model_api_profile_id must reference an API Profile of kind llm");
      }
    }
    const allowedTools = unique(input.allowed_tools ?? []);
    if (allowedTools.some((t) => !/^[a-z][a-z0-9_.-]{0,63}$/i.test(t))) {
      throw new PcsError(400, "INVALID_PROFILE", "allowed_tools contains an invalid tool_id");
    }
    const taskTypes = unique(input.task_types ?? []);
    const description = promptField(input.description, "description", 500);
    const systemPrompt = promptField(input.system_prompt, "system_prompt", 20_000);
    const persona = promptField(input.persona, "persona", 2_000);
    const tone = promptField(input.tone, "tone", 2_000);
    const goals = promptField(input.goals, "goals", 2_000);
    const limits = normalizeLimits(input.limits);
    try {
      const r = await query(
        `INSERT INTO agent_profiles
           (agent_profile_id, role_id, name, version, adapter, artifact_image, entrypoint, args,
            model_api_profile_id, tool_api_profile_ids, limits, capabilities, allowed_tools,
            task_types, description, system_prompt, persona, tone, goals, enabled)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10::text[],$11::jsonb,
                 $12::text[],$13::text[],$14::text[],$15,$16,$17,$18,$19,$20)
         RETURNING *`,
        [
          profileId,
          roleId,
          name,
          version,
          adapter,
          image,
          JSON.stringify(input.entrypoint ?? []),
          JSON.stringify(input.args ?? []),
          modelApiId,
          input.tool_api_profile_ids ?? [],
          JSON.stringify(limits),
          input.capabilities ?? [],
          allowedTools,
          taskTypes,
          description,
          systemPrompt,
          persona,
          tone,
          goals,
          input.enabled !== false,
        ],
      );
      await this.audit(operator, "agent_profile.create", profileId, null, {
        role_id: roleId,
        version,
        adapter,
        allowed_tools: allowedTools,
        task_types: taskTypes,
      });
      return normalizeAgentProfile(r.rows[0]);
    } catch (e: any) {
      if (e?.code === "23505") conflict("AGENT_PROFILE_EXISTS", `Agent Profile already exists: ${profileId}`);
      throw e;
    }
  }

  async listAgentProfiles(): Promise<AgentProfileRow[]> {
    const r = await query(`SELECT * FROM agent_profiles ORDER BY created_at DESC`);
    return r.rows.map(normalizeAgentProfile);
  }

  async getAgentProfile(profileId: string): Promise<AgentProfileRow | null> {
    const r = await query(`SELECT * FROM agent_profiles WHERE agent_profile_id = $1`, [profileId]);
    return r.rows[0] ? normalizeAgentProfile(r.rows[0]) : null;
  }

  /** Update an Agent Profile. The role is immutable, to avoid existing bindings suddenly becoming cross-role. */
  async updateAgentProfile(
    profileId: string,
    input: Partial<CreateAgentProfileInput>,
    operator: string,
  ): Promise<AgentProfileRow> {
    const current = await this.getAgentProfile(profileId);
    if (!current) notFound("AGENT_PROFILE_NOT_FOUND", `Agent Profile not found: ${profileId}`);
    if (input.role_id !== undefined && String(input.role_id).trim() !== current.role_id) {
      throw new PcsError(409, "ROLE_IMMUTABLE", "an Agent Profile role cannot be changed; create a new one");
    }
    const adapter = String(input.adapter ?? current.adapter).trim();
    if (!AGENT_ADAPTERS[current.role_id].includes(adapter)) {
      throw new PcsError(
        400,
        "ADAPTER_NOT_ALLOWED",
        `role ${current.role_id} does not allow ${adapter || "(empty)"}; allowed: ${AGENT_ADAPTERS[current.role_id].join(",")}`,
      );
    }
    const name = String(input.name ?? current.name).trim();
    if (!name) throw new PcsError(400, "INVALID_PROFILE", "name is required");
    const version = String(input.version ?? current.version).trim();
    if (!version) throw new PcsError(400, "INVALID_PROFILE", "version is required");
    const image =
      input.artifact_image !== undefined
        ? String(input.artifact_image).trim()
        : current.artifact_image;
    // Validate only the image that actually changed: placeholder images in historical configs should not block a rename / enable-disable.
    if (image && image !== current.artifact_image) {
      assertPinnedImage(image, this.cfg.imageAllowlist);
    }

    let modelApiId = current.model_api_profile_id;
    if (input.model_api_profile_id !== undefined) {
      modelApiId = input.model_api_profile_id ? String(input.model_api_profile_id).trim() : null;
    }
    if (modelApiId && modelApiId !== current.model_api_profile_id) {
      const modelApi = await this.getApiProfile(modelApiId);
      if (!modelApi) notFound("MODEL_API_NOT_FOUND", `model API Profile not found: ${modelApiId}`);
      if (modelApi.kind !== "llm") {
        throw new PcsError(400, "MODEL_API_NOT_LLM", "model_api_profile_id must reference an API Profile of kind llm");
      }
    }
    const allowedTools =
      input.allowed_tools !== undefined ? unique(input.allowed_tools) : current.allowed_tools;
    if (allowedTools.some((t) => !/^[a-z][a-z0-9_.-]{0,63}$/i.test(t))) {
      throw new PcsError(400, "INVALID_PROFILE", "allowed_tools contains an invalid tool_id");
    }
    const taskTypes = input.task_types !== undefined ? unique(input.task_types) : current.task_types;
    const textOf = (key: "description" | "system_prompt" | "persona" | "tone" | "goals", max: number) =>
      input[key] !== undefined ? promptField(input[key], key, max) : current[key];
    const description = textOf("description", 500);
    const systemPrompt = textOf("system_prompt", 20_000);
    const persona = textOf("persona", 2_000);
    const tone = textOf("tone", 2_000);
    const goals = textOf("goals", 2_000);
    const limits =
      input.limits !== undefined ? normalizeLimits(input.limits) : current.limits;
    const r = await query(
      `UPDATE agent_profiles SET
         name=$2, version=$3, adapter=$4, artifact_image=$5, entrypoint=$6::jsonb, args=$7::jsonb,
         model_api_profile_id=$8, tool_api_profile_ids=$9::text[], limits=$10::jsonb,
         capabilities=$11::text[], allowed_tools=$12::text[], task_types=$13::text[],
         description=$14, system_prompt=$15, persona=$16, tone=$17, goals=$18,
         enabled=$19, updated_at=now()
       WHERE agent_profile_id=$1
       RETURNING *`,
      [
        profileId,
        name,
        version,
        adapter,
        image,
        JSON.stringify(input.entrypoint ?? current.entrypoint),
        JSON.stringify(input.args ?? current.args),
        modelApiId,
        input.tool_api_profile_ids ?? current.tool_api_profile_ids,
        JSON.stringify(limits),
        input.capabilities ?? current.capabilities,
        allowedTools,
        taskTypes,
        description,
        systemPrompt,
        persona,
        tone,
        goals,
        input.enabled ?? current.enabled,
      ],
    );
    await this.audit(operator, "agent_profile.update", profileId, null, {
      version,
      adapter,
      enabled: input.enabled ?? current.enabled,
    });
    return normalizeAgentProfile(r.rows[0]);
  }

  /**
   * Drop bindings of a profile that no live deployment can use: the host record is gone or every
   * deployment with that instance name has been removed. No instance can observe these rows, but
   * they would otherwise keep blocking profile deletion forever.
   */
  private async pruneStaleBindings(
    c: Client,
    table: "role_agent_bindings" | "role_api_bindings",
    profileColumn: "agent_profile_id" | "api_profile_id",
    profileId: string,
  ): Promise<void> {
    await c.query(
      `DELETE FROM ${table} b
        WHERE b.${profileColumn} = $1
          AND NOT EXISTS (
            SELECT 1
              FROM pcs_hosts h
              JOIN pcs_deployments d ON d.host_id = h.host_id
             WHERE h.host_id = b.host_id
               AND d.instance_id = b.instance_id
               AND d.status <> 'REMOVED'
          )`,
      [profileId],
    );
  }

  /** Delete an Agent Profile not used by any live instance; bindings left behind by removed deployments or hosts are pruned first. */
  async deleteAgentProfile(profileId: string, operator: string): Promise<{ deleted: boolean }> {
    const current = await this.getAgentProfile(profileId);
    if (!current) notFound("AGENT_PROFILE_NOT_FOUND", `Agent Profile not found: ${profileId}`);
    const used = await tx(async (c) => {
      await this.pruneStaleBindings(c, "role_agent_bindings", "agent_profile_id", profileId);
      return c.query(
        `SELECT b.instance_id, COALESCE(h.hostname, b.host_id) AS host_name
           FROM role_agent_bindings b
           LEFT JOIN pcs_hosts h ON h.host_id = b.host_id
          WHERE b.agent_profile_id = $1
          ORDER BY b.host_id, b.instance_id`,
        [profileId],
      );
    });
    if (used.rowCount) {
      throw conflict(
        "PROFILE_IN_USE",
        `still in use by instances; unbind them first: ${used.rows
          .map((r) => `${r.instance_id} (${r.host_name})`)
          .join(", ")}`,
      );
    }
    await query(`DELETE FROM agent_profiles WHERE agent_profile_id = $1`, [profileId]);
    await this.audit(operator, "agent_profile.delete", profileId, null, {
      name: current.name,
      role_id: current.role_id,
    });
    return { deleted: true };
  }

  async createApiProfile(input: CreateApiProfileInput, operator: string): Promise<ApiProfileRow> {
    const apiId = String(input.api_profile_id ?? "").trim() || newId("api");
    const kind = String(input.kind ?? "").trim();
    if (!["llm", "http", "tool", "storage"].includes(kind)) {
      throw new PcsError(400, "INVALID_PROFILE", `invalid kind: ${kind}`);
    }
    const baseUrl = String(input.base_url ?? "").trim();
    let parsed: URL;
    try {
      parsed = new URL(baseUrl);
    } catch {
      throw new PcsError(400, "INVALID_PROFILE", `base_url is not a valid URL: ${baseUrl}`);
    }
    const loopbackDev =
      this.cfg.allowInsecureApiUrls &&
      parsed.protocol === "http:" &&
      ["127.0.0.1", "localhost", "::1"].includes(parsed.hostname);
    if (parsed.protocol !== "https:" && !loopbackDev) {
      throw new PcsError(400, "INSECURE_API_URL", "API Profiles only allow https (local development must explicitly enable PCS_ALLOW_INSECURE_API_URLS)");
    }
    const authType = String(input.auth_type ?? "").trim();
    if (!["bearer", "api_key", "oauth2_client", "mtls"].includes(authType)) {
      throw new PcsError(400, "INVALID_PROFILE", `invalid auth_type: ${authType}`);
    }
    const secretRef = String(input.secret_ref ?? "").trim();
    if (!SECRET_REF.test(secretRef)) {
      throw new PcsError(400, "INVALID_SECRET_REF", "secret_ref must look like secret://<path> and must not contain secret plaintext");
    }
    const timeout = Number(input.timeout_seconds ?? 60);
    if (!Number.isInteger(timeout) || timeout <= 0 || timeout > 600) {
      throw new PcsError(400, "INVALID_PROFILE", "timeout_seconds must be an integer in 1..600");
    }
    const quota = normalizeQuota(input.quota);
    try {
      const r = await query(
        `INSERT INTO api_profiles
           (api_profile_id, name, kind, base_url, auth_type, secret_ref, scopes, quota,
            timeout_seconds, egress, fallback, enabled)
         VALUES ($1,$2,$3,$4,$5,$6,$7::text[],$8::jsonb,$9,$10,$11::text[],$12)
         RETURNING *`,
        [
          apiId,
          String(input.name ?? apiId),
          kind,
          baseUrl.replace(/\/+$/, ""),
          authType,
          secretRef,
          unique(input.scopes ?? []),
          JSON.stringify(quota),
          timeout,
          input.egress ?? null,
          unique(input.fallback ?? []),
          input.enabled !== false,
        ],
      );
      await this.audit(operator, "api_profile.create", apiId, null, {
        kind,
        base_url: parsed.origin,
        secret_ref: secretRef,
      });
      return normalizeApiProfile(r.rows[0]);
    } catch (e: any) {
      if (e?.code === "23505") conflict("API_PROFILE_EXISTS", `API Profile already exists: ${apiId}`);
      throw e;
    }
  }

  async listApiProfiles(): Promise<ApiProfileRow[]> {
    const r = await query(`SELECT * FROM api_profiles ORDER BY created_at DESC`);
    return r.rows.map(normalizeApiProfile);
  }

  async getApiProfile(apiId: string): Promise<ApiProfileRow | null> {
    const r = await query(`SELECT * FROM api_profiles WHERE api_profile_id = $1`, [apiId]);
    return r.rows[0] ? normalizeApiProfile(r.rows[0]) : null;
  }

  /** Update an API Profile. kind is immutable; secret_ref still stores only a reference and never accepts secret plaintext. */
  async updateApiProfile(
    apiId: string,
    input: Partial<CreateApiProfileInput>,
    operator: string,
  ): Promise<ApiProfileRow> {
    const current = await this.getApiProfile(apiId);
    if (!current) notFound("API_PROFILE_NOT_FOUND", `API Profile not found: ${apiId}`);
    if (input.kind !== undefined && String(input.kind).trim() !== current.kind) {
      throw new PcsError(409, "KIND_IMMUTABLE", "an API Profile kind cannot be changed; create a new one");
    }
    const baseUrl = String(input.base_url ?? current.base_url).trim();
    let parsed: URL;
    try {
      parsed = new URL(baseUrl);
    } catch {
      throw new PcsError(400, "INVALID_PROFILE", `base_url is not a valid URL: ${baseUrl}`);
    }
    const loopbackDev =
      this.cfg.allowInsecureApiUrls &&
      parsed.protocol === "http:" &&
      ["127.0.0.1", "localhost", "::1"].includes(parsed.hostname);
    // When the address is unchanged, keep the existing judgment, so historical config does not block a rename / enable-disable.
    if (baseUrl !== current.base_url && parsed.protocol !== "https:" && !loopbackDev) {
      throw new PcsError(400, "INSECURE_API_URL", "API Profiles only allow https (local development must explicitly enable PCS_ALLOW_INSECURE_API_URLS)");
    }
    const authType = String(input.auth_type ?? current.auth_type).trim();
    if (!["bearer", "api_key", "oauth2_client", "mtls"].includes(authType)) {
      throw new PcsError(400, "INVALID_PROFILE", `invalid auth_type: ${authType}`);
    }
    const secretRef = String(input.secret_ref ?? current.secret_ref).trim();
    if (!SECRET_REF.test(secretRef)) {
      throw new PcsError(400, "INVALID_SECRET_REF", "secret_ref must look like secret://<path> and must not contain secret plaintext");
    }
    const timeout = Number(input.timeout_seconds ?? current.timeout_seconds);
    if (!Number.isInteger(timeout) || timeout <= 0 || timeout > 600) {
      throw new PcsError(400, "INVALID_PROFILE", "timeout_seconds must be an integer in 1..600");
    }
    const quota = input.quota !== undefined ? normalizeQuota(input.quota) : current.quota;
    const r = await query(
      `UPDATE api_profiles SET
         name=$2, base_url=$3, auth_type=$4, secret_ref=$5, scopes=$6::text[], quota=$7::jsonb,
         timeout_seconds=$8, egress=$9, fallback=$10::text[], enabled=$11, updated_at=now()
       WHERE api_profile_id=$1
       RETURNING *`,
      [
        apiId,
        String(input.name ?? current.name).trim() || apiId,
        baseUrl.replace(/\/+$/, ""),
        authType,
        secretRef,
        input.scopes ?? current.scopes,
        JSON.stringify(quota),
        timeout,
        input.egress !== undefined ? input.egress : current.egress,
        input.fallback ?? current.fallback,
        input.enabled ?? current.enabled,
      ],
    );
    await this.audit(operator, "api_profile.update", apiId, null, {
      base_url: parsed.origin,
      enabled: input.enabled ?? current.enabled,
    });
    return normalizeApiProfile(r.rows[0]);
  }

  /** Delete an API Profile that is not referenced; instance bindings, Agent model/tool references, and fallback all count as usage. */
  async deleteApiProfile(apiId: string, operator: string): Promise<{ deleted: boolean }> {
    const current = await this.getApiProfile(apiId);
    if (!current) notFound("API_PROFILE_NOT_FOUND", `API Profile not found: ${apiId}`);
    const used = await tx(async (c) => {
      await this.pruneStaleBindings(c, "role_api_bindings", "api_profile_id", apiId);
      return c.query(
        `SELECT b.instance_id, COALESCE(h.hostname, b.host_id) AS host_name
           FROM role_api_bindings b
           LEFT JOIN pcs_hosts h ON h.host_id = b.host_id
          WHERE b.api_profile_id = $1
          ORDER BY b.host_id, b.instance_id`,
        [apiId],
      );
    });
    const [agents, fallbacks] = await Promise.all([
      query(
        `SELECT agent_profile_id FROM agent_profiles
          WHERE model_api_profile_id = $1 OR $1 = ANY(tool_api_profile_ids)
          ORDER BY agent_profile_id`,
        [apiId],
      ),
      query(`SELECT api_profile_id FROM api_profiles WHERE $1 = ANY(fallback) ORDER BY api_profile_id`, [apiId]),
    ]);
    const refs = [
      ...used.rows.map((r) => `instance ${r.instance_id} (${r.host_name})`),
      ...agents.rows.map((r) => `Agent ${r.agent_profile_id}`),
      ...fallbacks.rows.map((r) => `API ${r.api_profile_id}`),
    ];
    if (refs.length) {
      throw conflict("PROFILE_IN_USE", `still referenced; remove references first: ${refs.join(", ")}`);
    }
    await query(`DELETE FROM api_profiles WHERE api_profile_id = $1`, [apiId]);
    await this.audit(operator, "api_profile.delete", apiId, null, { name: current.name, kind: current.kind });
    return { deleted: true };
  }

  /**
   * Write an API key from the console: the value is forwarded only to the Secret Store; the PCS does not persist, echo, or log it.
   * After writing, instances still resolve via the secret:// reference in the Profile against the Secret Store.
   */
  async setApiProfileSecret(
    apiId: string,
    value: string,
    operator: string,
  ): Promise<{ ok: true; secret_ref: string }> {
    const current = await this.getApiProfile(apiId);
    if (!current) notFound("API_PROFILE_NOT_FOUND", `API Profile not found: ${apiId}`);
    if (!this.cfg.secretStoreUrl) {
      throw new PcsError(
        503,
        "SECRET_STORE_NOT_CONFIGURED",
        "the control plane has no Secret Store configured (PCS_SECRET_STORE_URL); only secret:// references can be used",
      );
    }
    if (typeof value !== "string" || value.length === 0 || value.length > 8192) {
      throw new PcsError(400, "INVALID_SECRET_VALUE", "secret value must be 1..8192 characters");
    }
    if (/[\r\n\0]/.test(value)) {
      throw new PcsError(400, "INVALID_SECRET_VALUE", "secret value must not contain newlines");
    }
    const url = `${this.cfg.secretStoreUrl.replace(/\/+$/, "")}/v1/secrets`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          ...(this.cfg.secretStoreAdminToken
            ? { authorization: `Bearer ${this.cfg.secretStoreAdminToken}` }
            : {}),
        },
        body: JSON.stringify({ secret_ref: current.secret_ref, value, platform_wide: true }),
        signal: AbortSignal.timeout(5000),
      });
    } catch (e) {
      throw new PcsError(
        502,
        "SECRET_STORE_UNAVAILABLE",
        `Secret Store unreachable: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    if (!res.ok) {
      let code = "SECRET_STORE_REJECTED";
      let message = `Secret Store returned ${res.status}`;
      try {
        const body = (await res.json()) as { error?: { code?: string; message?: string } };
        if (body.error?.code) code = body.error.code;
        if (body.error?.message) message = body.error.message;
      } catch {
        // Keep the status code description
      }
      throw new PcsError(502, code, message);
    }
    await this.audit(operator, "api_profile.secret_set", apiId, null, {
      secret_ref: current.secret_ref,
    });
    return { ok: true, secret_ref: current.secret_ref };
  }

  /** Agent / API bindings for all instances, fetched at once by the admin panel. Instance names are unique only within a host, so results are host-scoped. */
  async listBindings(): Promise<
    Array<{
      host_id: string;
      instance_id: string;
      role_id: string | null;
      agent_profile_id: string | null;
      api_profile_ids: string[];
    }>
  > {
    const [agents, apis] = await Promise.all([
      query(`SELECT host_id, instance_id, role_id, agent_profile_id FROM role_agent_bindings`),
      query(
        `SELECT host_id, instance_id, api_profile_id FROM role_api_bindings ORDER BY api_profile_id`,
      ),
    ]);
    const out = new Map<
      string,
      {
        host_id: string;
        instance_id: string;
        role_id: string | null;
        agent_profile_id: string | null;
        api_profile_ids: string[];
      }
    >();
    const keyOf = (hostId: unknown, instanceId: unknown) =>
      `${String(hostId ?? "")}/${String(instanceId ?? "")}`;
    for (const row of agents.rows) {
      out.set(keyOf(row.host_id, row.instance_id), {
        host_id: String(row.host_id),
        instance_id: String(row.instance_id),
        role_id: row.role_id ?? null,
        agent_profile_id: row.agent_profile_id ?? null,
        api_profile_ids: [],
      });
    }
    for (const row of apis.rows) {
      const key = keyOf(row.host_id, row.instance_id);
      const hit = out.get(key) ?? {
        host_id: String(row.host_id),
        instance_id: String(row.instance_id),
        role_id: null,
        agent_profile_id: null,
        api_profile_ids: [],
      };
      hit.api_profile_ids.push(String(row.api_profile_id));
      out.set(key, hit);
    }
    return [...out.values()].sort(
      (a, b) => keyOf(a.host_id, a.instance_id).localeCompare(keyOf(b.host_id, b.instance_id)),
    );
  }

  /** Bind an Agent. Cross-role, disabled, or missing ones are rejected. Instance names are unique only within a host, so bindings are host-scoped. */
  async bindAgent(
    hostId: string,
    instanceId: string,
    agentProfileId: string,
    roleId: string,
    operator: string,
  ): Promise<{ host_id: string; instance_id: string; agent_profile_id: string; role_id: string }> {
    const profile = await this.getAgentProfile(agentProfileId);
    if (!profile) notFound("AGENT_PROFILE_NOT_FOUND", `Agent Profile not found: ${agentProfileId}`);
    if (!profile.enabled) throw new PcsError(409, "AGENT_PROFILE_DISABLED", "Agent Profile is not enabled");
    if (profile.role_id !== roleId) {
      throw new PcsError(
        409,
        "ROLE_AGENT_NOT_ALLOWED",
        `Agent Profile belongs to ${profile.role_id} and cannot be bound to ${roleId}`,
      );
    }
    await query(
      `INSERT INTO role_agent_bindings (host_id, instance_id, role_id, agent_profile_id, bound_by)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (host_id, instance_id) DO UPDATE
         SET role_id = EXCLUDED.role_id,
             agent_profile_id = EXCLUDED.agent_profile_id,
             bound_by = EXCLUDED.bound_by,
             bound_at = now()`,
      [hostId, instanceId, roleId, agentProfileId, operator],
    );
    await this.audit(operator, "role_agent_binding.set", agentProfileId, instanceId, {
      role_id: roleId,
      host_id: hostId,
    });
    return { host_id: hostId, instance_id: instanceId, agent_profile_id: agentProfileId, role_id: roleId };
  }

  /** Remove an instance's Agent binding; after the next restart the instance runs without an Agent (deterministic shell tasks only). */
  async unbindAgent(hostId: string, instanceId: string, operator: string): Promise<{ ok: boolean }> {
    const removed = await query<{ agent_profile_id: string }>(
      `DELETE FROM role_agent_bindings
        WHERE host_id = $1 AND instance_id = $2
        RETURNING agent_profile_id`,
      [hostId, instanceId],
    );
    if (removed.rowCount) {
      await this.audit(
        operator,
        "role_agent_binding.remove",
        removed.rows[0].agent_profile_id,
        instanceId,
        { host_id: hostId, removed: removed.rowCount },
      );
    }
    return { ok: Boolean(removed.rowCount) };
  }

  async bindApi(
    hostId: string,
    instanceId: string,
    apiProfileId: string,
    operator: string,
  ): Promise<{ host_id: string; instance_id: string; api_profile_id: string }> {
    const profile = await this.getApiProfile(apiProfileId);
    if (!profile) notFound("API_PROFILE_NOT_FOUND", `API Profile not found: ${apiProfileId}`);
    if (!profile.enabled) throw new PcsError(409, "API_PROFILE_DISABLED", "API Profile is not enabled");
    await query(
      `INSERT INTO role_api_bindings (host_id, instance_id, api_profile_id, bound_by)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (host_id, instance_id, api_profile_id) DO UPDATE SET bound_by = EXCLUDED.bound_by`,
      [hostId, instanceId, apiProfileId, operator],
    );
    await this.audit(operator, "role_api_binding.add", apiProfileId, instanceId, { host_id: hostId });
    return { host_id: hostId, instance_id: instanceId, api_profile_id: apiProfileId };
  }

  async unbindApi(
    hostId: string,
    instanceId: string,
    apiProfileId: string,
    operator: string,
  ): Promise<{ ok: boolean }> {
    const r = await query(
      `DELETE FROM role_api_bindings
        WHERE host_id = $1 AND instance_id = $2 AND api_profile_id = $3`,
      [hostId, instanceId, apiProfileId],
    );
    await this.audit(operator, "role_api_binding.remove", apiProfileId, instanceId, {
      host_id: hostId,
      removed: r.rowCount,
    });
    return { ok: Boolean(r.rowCount) };
  }

  /**
   * Resolve an instance's Agent/API bindings.
   *
   * The return value is the "runtime view": it contains adapter, entrypoint, base_url, and secret_ref,
   * but never the value behind secret_ref. The scheduler and Host Runtime execute only from this view.
   */
  async resolveInstance(hostId: string, instanceId: string): Promise<ResolvedInstance | null> {
    const b = (
      await query(`SELECT * FROM role_agent_bindings WHERE host_id = $1 AND instance_id = $2`, [
        hostId,
        instanceId,
      ])
    ).rows[0];
    if (!b) return null;
    const agent = await this.getAgentProfile(b.agent_profile_id);
    if (!agent) return null;
    const apis = (
      await query(
        `SELECT p.* FROM role_api_bindings b
           JOIN api_profiles p ON p.api_profile_id = b.api_profile_id
          WHERE b.host_id = $1 AND b.instance_id = $2
          ORDER BY p.api_profile_id`,
        [hostId, instanceId],
      )
    ).rows.map(normalizeApiProfile);
    return {
      host_id: hostId,
      instance_id: instanceId,
      role_id: b.role_id,
      agent,
      api_profiles: apis,
    };
  }

  async audit(
    operator: string,
    action: string,
    subject: string,
    instanceId: string | null,
    detail: Record<string, unknown>,
  ): Promise<void> {
    await query(
      `INSERT INTO pcs_audit_logs (action, operator_id, subject, instance_id, detail)
       VALUES ($1,$2,$3,$4,$5::jsonb)`,
      [action, operator, subject, instanceId, JSON.stringify(detail)],
    );
  }

  async listAudit(limit = 100): Promise<unknown[]> {
    const r = await query(
      `SELECT * FROM pcs_audit_logs ORDER BY audit_id DESC LIMIT $1`,
      [Math.max(1, Math.min(limit, 500))],
    );
    return r.rows;
  }

  // ---------------------------------------------------------------- Cleanup

  async sweep(): Promise<{ offline: string[] }> {
    const r = await query(
      `UPDATE pcs_hosts
          SET status='OFFLINE', updated_at=now()
        WHERE status IN ('ONLINE','DEGRADED')
          AND (last_seen_at IS NULL OR last_seen_at < now() - make_interval(secs => $1))
        RETURNING host_id`,
      [this.cfg.hostOfflineSeconds],
    );
    await query(
      `UPDATE pcs_commands SET state='EXPIRED'
        WHERE state IN ('PENDING','DELIVERED') AND expires_at <= now()`,
    );
    return { offline: r.rows.map((x) => x.host_id) };
  }
}

const shq = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

/** Run a local command on the PCS's host (used for docker save / inspect). */
function runCommand(
  command: string,
  args: string[],
  timeoutMs = 60_000,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString("utf8");
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString("utf8");
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: `${stderr}${(e as Error).message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
}
