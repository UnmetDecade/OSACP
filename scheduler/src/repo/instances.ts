import { q, q1, tx } from "../db.js";
import { ApiError } from "../errors.js";
import {
  computeCapabilityScore,
  normalizeCapabilityDetail,
  type CapabilityDetail,
} from "../capability.js";

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
    throw new ApiError(400, "BAD_REQUEST", "instance_id / role_id / host_id 必填");
  }
  const host = await q1("SELECT host_id FROM hosts WHERE host_id = $1", [input.host_id]);
  if (!host) throw new ApiError(409, "HOST_UNKNOWN", `主机未注册: ${input.host_id}`);

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

  return tx(async (c) => {
    const res = await c.query(
      `INSERT INTO role_instances (
         instance_id, role_id, host_id, state, agent_profile_id, allowed_task_types,
         capabilities, config_version, protocol_version, payload_schemas,
         capability_ceiling, drain_deadline_at, last_heartbeat_at, updated_at,
         agent_profile_version, api_profile_ids, capability_score, capability_detail)
       VALUES ($1,$2,$3,'STARTING',$4,$5,$6,$7,$8,COALESCE($9, ARRAY['1.0']),
               $10, NULL, app_now(), app_now(), $11, $12::text[],
               COALESCE($13, 0), COALESCE($14::jsonb, '{}'::jsonb))
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
            config_version = COALESCE($5, config_version)
      WHERE instance_id = $1
      RETURNING instance_id, state, config_version, host_id`,
    [
      input.instance_id,
      input.state ?? null,
      input.load === undefined ? null : JSON.stringify(input.load),
      input.capabilities === undefined ? null : JSON.stringify(input.capabilities),
      input.config_version ?? null,
    ],
  );
  if (!rows.length) throw new ApiError(404, "INSTANCE_UNKNOWN", `实例未注册: ${input.instance_id}`);
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
    if (!inst) throw new ApiError(404, "INSTANCE_UNKNOWN", `实例未注册: ${instanceId}`);

    const declared = input.declared ?? {};
    const allowed: string[] = inst.allowed_task_types ?? [];
    const nextTaskTypes = declared.task_types ?? allowed;
    const extraTypes = nextTaskTypes.filter((t) => !allowed.includes(t));
    if (extraTypes.length) {
      throw new ApiError(403, "CAPABILITY_MISMATCH", "只能收窄任务类型，不能扩大", {
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
      throw new ApiError(403, "CAPABILITY_MISMATCH", "只能收窄能力，不能扩大", {
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
    throw new ApiError(400, "BAD_REQUEST", "timeout_seconds 必须是正数");
  }

  return tx(async (c) => {
    const inst = (
      await c.query(`SELECT * FROM role_instances WHERE instance_id = $1 FOR UPDATE`, [instanceId])
    ).rows[0];
    if (!inst) throw new ApiError(404, "INSTANCE_UNKNOWN", `实例未注册: ${instanceId}`);
    if (!["ONLINE", "SUSPECT", "DRAINING"].includes(inst.state)) {
      throw new ApiError(409, "INSTANCE_NOT_ELIGIBLE", `实例状态 ${inst.state}，不能 drain`);
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
    if (!inst) throw new ApiError(404, "INSTANCE_UNKNOWN", `实例未注册: ${instanceId}`);
    if (inst.state === "ONLINE") return { instance_id: instanceId, state: "ONLINE", idempotent: true };
    if (inst.state !== "DRAINING") {
      throw new ApiError(409, "STATE_CONFLICT", `实例状态 ${inst.state}，不能 resume`);
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
    if (!inst) throw new ApiError(404, "INSTANCE_UNKNOWN", `实例未注册: ${instanceId}`);

    const active = await c.query(
      `SELECT count(*)::int AS n FROM leases
        WHERE instance_id = $1 AND released_at IS NULL AND expires_at > app_now()`,
      [instanceId],
    );
    const activeAttempts = active.rows[0].n;
    if (activeAttempts > 0 && !input.force) {
      throw new ApiError(409, "STATE_CONFLICT", "还有在途任务，不能注销", {
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
  if (!inst) throw new ApiError(404, "INSTANCE_UNKNOWN", `实例未注册: ${instanceId}`);

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
