import { q, q1, tx } from "../db.js";
import { ApiError } from "../errors.js";
import {
  computeCapabilityScore,
  dynamicGuaranteedScore,
  dynamicLiveScore,
  normalizeCapabilityDetail,
  splitCapability,
  type CapabilityDetail,
} from "../capability.js";

const GIB = 1024 ** 3;
const nonNeg = (value: unknown): number => Math.max(0, Math.trunc(Number(value) || 0));

export interface RegisterInput {
  instance_id: string;
  role_id: string;
  host_id: string;
  agent_profile_id: string;
  /** Actually loaded version of the Agent Profile; task envelopes are matched by it (§2.2) */
  agent_profile_version?: string;
  /** API Profile references bound to the instance; a task may only use a subset of this set */
  api_profile_ids?: string[];
  allowed_task_types: string[];
  capabilities: { healthy: string[]; unhealthy?: string[] };
  /** Capability score 0–1000; omitted means compute from capability_detail, and omitting both keeps the old value */
  capability_score?: number;
  capability_detail?: CapabilityDetail;
  /** Deployment scheduling mode; omitted keeps the recorded mode (new rows default to static). */
  scheduling_mode?: "static" | "dynamic";
  /** Instance cap from the deployment resource profile; omitted falls back to the capability detail. */
  cap_cpu_millicores?: number;
  cap_mem_bytes?: number;
  config_version: number;
  protocol_version?: string;
  payload_schemas?: string[];
}

/**
 * Registration. Host Runtime only calls it for instances "dispatched and locally admitted";
 * the scheduler does not trust the declaration itself: registration only creates a "candidate" record, and it must be ONLINE to claim.
 */
export async function register(input: RegisterInput) {
  if (!input.instance_id || !input.role_id || !input.host_id) {
    throw new ApiError(400, "BAD_REQUEST", "instance_id / role_id / host_id are required");
  }
  const host = await q1("SELECT host_id FROM hosts WHERE host_id = $1", [input.host_id]);
  if (!host) throw new ApiError(409, "HOST_UNKNOWN", `host not registered: ${input.host_id}`);

  // On first registration, freeze the declared capabilities as a ceiling; re-registration does not raise it (§7.3: only narrow)
  const declared = input.capabilities ?? { healthy: [] };
  const ceiling = [...new Set([...(declared.healthy ?? []), ...(declared.unhealthy ?? [])])];

  // Capability score: prefer the score computed by the creator; if only the detail is given, compute locally; if neither, do not overwrite the old value.
  const detail =
    input.capability_detail === undefined ? null : normalizeCapabilityDetail(input.capability_detail);
  const score =
    input.capability_score !== undefined
      ? Math.max(0, Math.min(1000, Math.round(Number(input.capability_score) || 0)))
      : detail
        ? computeCapabilityScore(detail)
        : null;

  const mode =
    input.scheduling_mode === "dynamic"
      ? "dynamic"
      : input.scheduling_mode === "static"
        ? "static"
        : null;
  const capCpu =
    input.cap_cpu_millicores !== undefined
      ? nonNeg(input.cap_cpu_millicores)
      : detail?.cores !== undefined
        ? Math.round(nonNeg(detail.cores) * 1000)
        : null;
  const capMem =
    input.cap_mem_bytes !== undefined
      ? nonNeg(input.cap_mem_bytes)
      : detail?.mem_gb !== undefined
        ? Math.round(nonNeg(detail.mem_gb) * GIB)
        : null;
  // Dynamic mode records the freeze-time split immediately; the allocator refreshes W_live once
  // the host reports real usage. Static rows keep the single legacy W in every score column.
  const split = detail ? splitCapability(detail, {
    cpu_cores: (capCpu ?? Math.round(nonNeg(detail.cores) * 1000)) / 1000,
    mem_gb: (capMem ?? Math.round(nonNeg(detail.mem_gb) * GIB)) / GIB,
  }) : null;
  const isDynamic = mode === "dynamic";
  const scoreCeiling = split ? (isDynamic ? split.ceiling : score) : null;
  const scoreLive = split
    ? (isDynamic ? dynamicLiveScore(split, 1, { scope: "resource" }) : score)
    : null;
  const scoreGuaranteed = split && isDynamic
    ? dynamicGuaranteedScore(split, {
        cpu_cores: (capCpu ?? 0) / 1000,
        mem_gb: (capMem ?? 0) / GIB,
      })
    : scoreCeiling;

  return tx(async (c) => {
    const res = await c.query(
      `INSERT INTO role_instances (
         instance_id, role_id, host_id, state, agent_profile_id, allowed_task_types,
         capabilities, config_version, protocol_version, payload_schemas,
         capability_ceiling, drain_deadline_at, last_heartbeat_at, updated_at,
         agent_profile_version, api_profile_ids, capability_score, capability_detail,
         scheduling_mode, cap_cpu_millicores, cap_mem_bytes,
         capability_static_score, capability_ceiling_score, capability_live_score,
         capability_dispatch_score, capability_guaranteed_score, capability_updated_at)
       VALUES ($1,$2,$3,'STARTING',$4,$5,$6,$7,$8,COALESCE($9, ARRAY['1.0']),
               $10, NULL, app_now(), app_now(), $11, $12::text[],
               COALESCE($13, 0), COALESCE($14::jsonb, '{}'::jsonb),
               COALESCE($15, 'static'), COALESCE($16, 0), COALESCE($17, 0),
               COALESCE($18, 0), COALESCE($19, COALESCE($13, 0)), COALESCE($20, COALESCE($13, 0)),
               COALESCE($20, COALESCE($13, 0)), COALESCE($21, COALESCE($19, COALESCE($13, 0))),
               CASE WHEN $13 IS NULL AND $14 IS NULL THEN NULL ELSE app_now() END)
       ON CONFLICT (instance_id) DO UPDATE SET
         role_id = EXCLUDED.role_id,
         host_id = EXCLUDED.host_id,
         agent_profile_id = EXCLUDED.agent_profile_id,
         agent_profile_version = EXCLUDED.agent_profile_version,
         api_profile_ids = EXCLUDED.api_profile_ids,
         allowed_task_types = EXCLUDED.allowed_task_types,
         capabilities = EXCLUDED.capabilities,
         config_version = EXCLUDED.config_version,
         protocol_version = EXCLUDED.protocol_version,
         payload_schemas = EXCLUDED.payload_schemas,
         capability_score = COALESCE($13, role_instances.capability_score),
         capability_detail = COALESCE($14::jsonb, role_instances.capability_detail),
         scheduling_mode = COALESCE($15, role_instances.scheduling_mode),
         cap_cpu_millicores = COALESCE($16, role_instances.cap_cpu_millicores),
         cap_mem_bytes = COALESCE($17, role_instances.cap_mem_bytes),
         capability_static_score = COALESCE($18, role_instances.capability_static_score),
         capability_ceiling_score = COALESCE($19, role_instances.capability_ceiling_score),
         capability_live_score = COALESCE($20, role_instances.capability_live_score),
         capability_dispatch_score = COALESCE($20, role_instances.capability_dispatch_score),
         capability_guaranteed_score = COALESCE($21, role_instances.capability_guaranteed_score),
         capability_updated_at = CASE WHEN $13 IS NULL AND $14 IS NULL
                                      THEN role_instances.capability_updated_at ELSE app_now() END,
         -- Registration means "a new process has started": the previous process's drain / heartbeat-timeout state is discarded.
         -- Otherwise the DRAINING heartbeat sent when the previous process exits would leave this instance stuck forever.
         state = CASE WHEN role_instances.state IN ('OFFLINE','FAILED','DRAINING','SUSPECT')
                      THEN 'STARTING' ELSE role_instances.state END,
         drain_deadline_at = NULL,
         last_heartbeat_at = app_now(),
         updated_at = app_now()
       RETURNING instance_id, state, config_version, capability_score`,
      [
        input.instance_id,
        input.role_id,
        input.host_id,
        input.agent_profile_id ?? null,
        input.allowed_task_types ?? [],
        JSON.stringify(declared),
        input.config_version ?? 1,
        input.protocol_version ?? "1.0",
        input.payload_schemas ?? null,
        ceiling,
        input.agent_profile_version ?? null,
        input.api_profile_ids ?? [],
        score,
        detail === null ? null : JSON.stringify(detail),
        mode,
        capCpu,
        capMem,
        split?.static_score ?? null,
        scoreCeiling,
        scoreLive,
        scoreGuaranteed,
      ],
    );
    return res.rows[0];
  });
}

export interface HeartbeatInput {
  instance_id: string;
  state?: "ONLINE" | "DRAINING" | "STARTING";
  load?: Record<string, unknown>;
  capabilities?: { healthy: string[]; unhealthy?: string[] };
  config_version?: number;
  /** Optional direct usage report; hosts that report a pool send per-instance usage there instead. */
  usage?: { cpu_millicores?: number; mem_bytes?: number };
}

export async function heartbeat(input: HeartbeatInput) {
  const rows = await q(
    `UPDATE role_instances
        SET last_heartbeat_at = app_now(),
            updated_at = app_now(),
            -- Heartbeats must not overwrite an admin-issued DRAINING back to ONLINE; recovery only goes through resume.
            state = CASE
                      WHEN $2::text IS NULL THEN state
                      WHEN state = 'DRAINING' AND $2::text = 'ONLINE' THEN 'DRAINING'
                      ELSE $2::text
                    END,
            load = COALESCE($3, load),
            capabilities = COALESCE($4, capabilities),
            config_version = COALESCE($5, config_version),
            usage_cpu_millicores = COALESCE($6, usage_cpu_millicores),
            usage_mem_bytes = COALESCE($7::bigint, usage_mem_bytes),
            usage_updated_at = CASE WHEN $6 IS NULL AND $7 IS NULL THEN usage_updated_at ELSE app_now() END
      WHERE instance_id = $1
      RETURNING instance_id, state, config_version, host_id`,
    [
      input.instance_id,
      input.state ?? null,
      input.load === undefined ? null : JSON.stringify(input.load),
      input.capabilities === undefined ? null : JSON.stringify(input.capabilities),
      input.config_version ?? null,
      input.usage?.cpu_millicores === undefined ? null : nonNeg(input.usage.cpu_millicores),
      input.usage?.mem_bytes === undefined ? null : nonNeg(input.usage.mem_bytes),
    ],
  );
  if (!rows.length) throw new ApiError(404, "INSTANCE_UNKNOWN", `instance not registered: ${input.instance_id}`);
  const row = rows[0];

  // The heartbeat response carries host state and config version (§7.2), so the instance can self-throttle and pull config on demand
  const host = await q1<{ host_state: string }>(
    `SELECT host_state FROM hosts WHERE host_id = $1`,
    [row.host_id],
  );
  return {
    instance_id: row.instance_id,
    state: row.state,
    config_version: row.config_version,
    host_id: row.host_id,
    host_state: host?.host_state ?? "UNKNOWN",
    server_time: new Date().toISOString(),
    pending_commands: 0,
  };
}

export async function getInstance(instanceId: string) {
  return q1("SELECT * FROM role_instances WHERE instance_id = $1", [instanceId]);
}

export async function listInstances() {
  return q(
    `SELECT i.*, EXTRACT(EPOCH FROM (app_now() - i.last_heartbeat_at))::int AS heartbeat_age_s
       FROM role_instances i ORDER BY i.instance_id`,
  );
}

/**
 * Heartbeat sweep: 45s without heartbeat → SUSPECT (excluded from new claims; in-flight leases continue)
 *            90s without heartbeat → OFFLINE
 * Only marks state, never reaps leases — reaping belongs to lease cleanup; the two stay out of each other's way.
 */
export async function sweepHeartbeats(opts: {
  suspectAfter: number;
  offlineAfter: number;
}): Promise<{ suspect: string[]; offline: string[] }> {
  const suspect = await q(
    `UPDATE role_instances
        SET state = 'SUSPECT', updated_at = app_now()
      WHERE state = 'ONLINE'
        AND last_heartbeat_at IS NOT NULL
        AND last_heartbeat_at < app_now() - make_interval(secs => $1)
      RETURNING instance_id`,
    [opts.suspectAfter],
  );
  const offline = await q(
    `UPDATE role_instances
        SET state = 'OFFLINE', updated_at = app_now()
      WHERE state IN ('ONLINE','SUSPECT')
        AND last_heartbeat_at IS NOT NULL
        AND last_heartbeat_at < app_now() - make_interval(secs => $1)
      RETURNING instance_id`,
    [opts.offlineAfter],
  );
  return {
    suspect: suspect.map((r) => r.instance_id),
    offline: offline.map((r) => r.instance_id),
  };
}

// ---------------------------------------------------------------- Instance lifecycle (§7.3 / §7.10–7.12)

export interface CapabilitiesInput {
  declared?: {
    capabilities?: string[];
    task_types?: string[];
    devices?: string[];
    tools?: string[];
  };
  config_version?: number;
}

/**
 * Capability declaration (§7.3). Narrow-only:
 *   - task_types must be a subset of allowed_task_types
 *   - capabilities must be a subset of the capability_ceiling frozen at registration
 * Any widening is 403 CAPABILITY_MISMATCH; to widen, change config in PCS and re-register.
 */
export async function setCapabilities(instanceId: string, input: CapabilitiesInput) {
  return tx(async (c) => {
    const inst = (
      await c.query(`SELECT * FROM role_instances WHERE instance_id = $1 FOR UPDATE`, [instanceId])
    ).rows[0];
    if (!inst) throw new ApiError(404, "INSTANCE_UNKNOWN", `instance not registered: ${instanceId}`);

    const declared = input.declared ?? {};
    const allowed: string[] = inst.allowed_task_types ?? [];
    const nextTaskTypes = declared.task_types ?? allowed;
    const extraTypes = nextTaskTypes.filter((t) => !allowed.includes(t));
    if (extraTypes.length) {
      throw new ApiError(403, "CAPABILITY_MISMATCH", "task types can only be narrowed, not expanded", {
        extra: extraTypes,
        allowed,
      });
    }

    const current: { healthy?: string[]; unhealthy?: string[] } = inst.capabilities ?? {};
    const ceiling: string[] = inst.capability_ceiling ?? [
      ...(current.healthy ?? []),
      ...(current.unhealthy ?? []),
    ];
    const nextHealthy = declared.capabilities ?? current.healthy ?? [];
    const extraCaps = nextHealthy.filter((x) => !ceiling.includes(x));
    if (extraCaps.length) {
      throw new ApiError(403, "CAPABILITY_MISMATCH", "capabilities can only be narrowed, not expanded", {
        extra: extraCaps,
        ceiling,
      });
    }

    const nextCaps = {
      healthy: nextHealthy,
      unhealthy: (current.unhealthy ?? []).filter((x) => nextHealthy.includes(x)),
    };

    const row = (
      await c.query(
        `UPDATE role_instances
            SET capabilities = $2::jsonb, allowed_task_types = $3,
                config_version = COALESCE($4, config_version), updated_at = app_now()
          WHERE instance_id = $1
          RETURNING instance_id, state, capabilities, allowed_task_types, config_version`,
        [instanceId, JSON.stringify(nextCaps), nextTaskTypes, input.config_version ?? null],
      )
    ).rows[0];

    return {
      instance_id: row.instance_id,
      state: row.state,
      capabilities: row.capabilities,
      allowed_task_types: row.allowed_task_types,
      config_version: row.config_version,
    };
  });
}

/**
 * drain (§7.10): stop dispatching new tasks while in-flight tasks continue; timeout without completion → OFFLINE.
 * claim only accepts ONLINE, so changing state is equivalent to stopping dispatch.
 */
export async function drain(
  instanceId: string,
  input: { timeout_seconds?: number; reason?: string } = {},
) {
  const seconds = Number(input.timeout_seconds ?? 300);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new ApiError(400, "BAD_REQUEST", "timeout_seconds must be positive");
  }

  return tx(async (c) => {
    const inst = (
      await c.query(`SELECT * FROM role_instances WHERE instance_id = $1 FOR UPDATE`, [instanceId])
    ).rows[0];
    if (!inst) throw new ApiError(404, "INSTANCE_UNKNOWN", `instance not registered: ${instanceId}`);
    if (!["ONLINE", "SUSPECT", "DRAINING"].includes(inst.state)) {
      throw new ApiError(409, "INSTANCE_NOT_ELIGIBLE", `instance state is ${inst.state}; cannot drain`);
    }

    // Idempotent: if already draining, keep the original deadline; repeated calls do not extend it
    const row = (
      await c.query(
        `UPDATE role_instances
            SET state = 'DRAINING',
                drain_deadline_at = COALESCE(drain_deadline_at,
                                             app_now() + make_interval(secs => $2)),
                updated_at = app_now()
          WHERE instance_id = $1
          RETURNING instance_id, state, drain_deadline_at`,
        [instanceId, seconds],
      )
    ).rows[0];

    const active = await c.query(
      `SELECT count(*)::int AS n FROM leases
        WHERE instance_id = $1 AND released_at IS NULL AND expires_at > app_now()`,
      [instanceId],
    );

    return {
      instance_id: row.instance_id,
      state: row.state,
      drain_deadline_at: row.drain_deadline_at,
      reason: input.reason ?? null,
      active_attempts: active.rows[0].n,
    };
  });
}

/** Cancel drain: only DRAINING needs recovery; already ONLINE returns idempotently */
export async function resume(instanceId: string) {
  return tx(async (c) => {
    const inst = (
      await c.query(`SELECT * FROM role_instances WHERE instance_id = $1 FOR UPDATE`, [instanceId])
    ).rows[0];
    if (!inst) throw new ApiError(404, "INSTANCE_UNKNOWN", `instance not registered: ${instanceId}`);
    if (inst.state === "ONLINE") return { instance_id: instanceId, state: "ONLINE", idempotent: true };
    if (inst.state !== "DRAINING") {
      throw new ApiError(409, "STATE_CONFLICT", `instance state is ${inst.state}; cannot resume`);
    }
    const row = (
      await c.query(
        `UPDATE role_instances
            SET state = 'ONLINE', drain_deadline_at = NULL, updated_at = app_now()
          WHERE instance_id = $1
          RETURNING instance_id, state`,
        [instanceId],
      )
    ).rows[0];
    return { instance_id: row.instance_id, state: row.state };
  });
}

/**
 * Deregister (§7.12). force=false with an in-flight lease → 409.
 * Deregistration only sets the instance OFFLINE; in-flight leases are reaped by the reaper on expiry, not raced here.
 */
export async function deregister(
  instanceId: string,
  input: { reason?: string; force?: boolean } = {},
) {
  return tx(async (c) => {
    const inst = (
      await c.query(`SELECT * FROM role_instances WHERE instance_id = $1 FOR UPDATE`, [instanceId])
    ).rows[0];
    if (!inst) throw new ApiError(404, "INSTANCE_UNKNOWN", `instance not registered: ${instanceId}`);

    const active = await c.query(
      `SELECT count(*)::int AS n FROM leases
        WHERE instance_id = $1 AND released_at IS NULL AND expires_at > app_now()`,
      [instanceId],
    );
    const activeAttempts = active.rows[0].n;
    if (activeAttempts > 0 && !input.force) {
      throw new ApiError(409, "STATE_CONFLICT", "there are still in-flight tasks; cannot deregister", {
        active_attempts: activeAttempts,
      });
    }

    await c.query(
      `UPDATE role_instances
          SET state = 'OFFLINE', drain_deadline_at = NULL, updated_at = app_now()
        WHERE instance_id = $1`,
      [instanceId],
    );

    return {
      instance_id: instanceId,
      state: "OFFLINE",
      active_attempts: activeAttempts,
      reason: input.reason ?? null,
    };
  });
}

/**
 * Config sync (§7.11). Returns null when the version is unchanged; the HTTP layer responds 304.
 * Only sync references (Agent Profile id/version, API Profile id list) and allowlists/policy;
 * Profile implementations, addresses and secrets are managed by PCS and the local Secret Store and never enter config or envelopes.
 */
export async function syncConfig(instanceId: string, version?: number | null) {
  const inst = await q1<any>(`SELECT * FROM role_instances WHERE instance_id = $1`, [instanceId]);
  if (!inst) throw new ApiError(404, "INSTANCE_UNKNOWN", `instance not registered: ${instanceId}`);

  const current = Number(inst.config_version);
  if (version !== undefined && version !== null && Number(version) === current) return null;

  const cfg = await q1<any>(`SELECT * FROM scheduler_config WHERE id = TRUE`);
  return {
    config_version: current,
    agent: {
      profile_id: inst.agent_profile_id,
      version: inst.agent_profile_version,
      args: {},
    },
    api_profiles: inst.api_profile_ids ?? [],
    resource_profile: null,
    scheduling_mode: inst.scheduling_mode ?? "static",
    capacity: {
      cap_cpu_millicores: Number(inst.cap_cpu_millicores ?? 0),
      cap_mem_bytes: Number(inst.cap_mem_bytes ?? 0),
    },
    capability: {
      schema_version: Number(inst.capability_schema_version ?? 1),
      static_score: Number(inst.capability_static_score ?? 0),
      ceiling: Number(inst.capability_ceiling_score ?? inst.capability_score ?? 0),
      live: Number(inst.capability_live_score ?? inst.capability_score ?? 0),
      dispatch: Number(inst.capability_dispatch_score ?? inst.capability_score ?? 0),
      guaranteed: Number(inst.capability_guaranteed_score ?? inst.capability_score ?? 0),
    },
    allowed_task_types: inst.allowed_task_types,
    capabilities: inst.capabilities,
    drain: {
      requested: inst.state === "DRAINING",
      deadline_at: inst.drain_deadline_at,
    },
    policy: {
      heartbeat_interval_seconds: 10,
      suspect_after_seconds: cfg.suspect_after_seconds,
      offline_after_seconds: cfg.offline_after_seconds,
      lease_seconds: cfg.lease_seconds,
    },
  };
}

/** Drain timeout: DRAINING past the deadline → OFFLINE; in-flight leases go to the reaper */
export async function sweepDrainTimeouts(): Promise<string[]> {
  const rows = await q(
    `UPDATE role_instances
        SET state = 'OFFLINE', drain_deadline_at = NULL, updated_at = app_now()
      WHERE state = 'DRAINING'
        AND drain_deadline_at IS NOT NULL
        AND drain_deadline_at <= app_now()
      RETURNING instance_id`,
  );
  return rows.map((r: any) => r.instance_id);
}
