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
  /** Agent Profile 的实际加载版本；任务信封按它匹配（§2.2） */
  agent_profile_version?: string;
  /** 实例绑定的 API Profile 引用；任务只能使用这个集合的子集 */
  api_profile_ids?: string[];
  allowed_task_types: string[];
  capabilities: { healthy: string[]; unhealthy?: string[] };
  /** 工作能力值 0–1000；不传则由 capability_detail 计算，两者都不传则沿用旧值 */
  capability_score?: number;
  capability_detail?: CapabilityDetail;
  config_version: number;
  protocol_version?: string;
  payload_schemas?: string[];
}

/**
 * 注册。Host Runtime 只会为“已下发并被本机准入”的实例调用它；
 * 调度机不信任声明本身，注册只建“候选”记录，必须 ONLINE 才可领取。
 */
export async function register(input: RegisterInput) {
  if (!input.instance_id || !input.role_id || !input.host_id) {
    throw new ApiError(400, "BAD_REQUEST", "instance_id / role_id / host_id 必填");
  }
  const host = await q1("SELECT host_id FROM hosts WHERE host_id = $1", [input.host_id]);
  if (!host) throw new ApiError(409, "HOST_UNKNOWN", `主机未注册: ${input.host_id}`);

  // 首次注册时把声明的能力固化成上限；重复注册不放大上限（§7.3 只能收窄）
  const declared = input.capabilities ?? { healthy: [] };
  const ceiling = [...new Set([...(declared.healthy ?? []), ...(declared.unhealthy ?? [])])];

  // 工作能力值：优先用创建方算好的 score；只给了明细就本地算；都没有则不覆盖旧值。
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
         -- 注册代表“新进程起来了”：上一进程的 drain / 心跳超时状态全部作废。
         -- 否则上一个进程退出时发的 DRAINING 心跳会把这个实例永久卡住。
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
            -- 心跳不能把管理员下发的 DRAINING 覆盖回 ONLINE；恢复只能走 resume
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

  // 心跳响应带上宿主状态与配置版本（§7.2），实例据此自我限流、按需拉配置
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
 * 心跳扫描：45s 无心跳 → SUSPECT（不参与新领取，在途租约继续）
 *            90s 无心跳 → OFFLINE
 * 只做状态标注，不回收租约——回收由租约清理负责，两者互不越界。
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

// ---------------------------------------------------------------- 实例生命周期（§7.3 / §7.10–7.12）

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
 * 能力声明（§7.3）。只能收窄：
 *   - task_types 必须是 allowed_task_types 的子集
 *   - capabilities 必须是注册时固化下来的 capability_ceiling 的子集
 * 扩大一律 403 CAPABILITY_MISMATCH，要扩必须在 PCS 改配置后重新注册。
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
 * drain（§7.10）：不再派发新任务，在途任务继续；超时未完成 → OFFLINE。
 * claim 只认 ONLINE，所以改状态就等于停派。
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

    // 幂等：已经在 drain 就沿用原截止时间，不因重复调用而延长
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

/** 取消 drain：只有 DRAINING 需要恢复；已 ONLINE 幂等返回 */
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
 * 注销（§7.12）。force=false 且有在途租约 → 409。
 * 注销只把实例置为 OFFLINE；在途租约到期后由 reaper 回收，不在这里抢跑。
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
 * 配置同步（§7.11）。版本没变返回 null，由 HTTP 层回 304。
 * 只同步引用（Agent Profile id/version、API Profile id 列表）与白名单/策略；
 * Profile 的实现、地址与密钥由 PCS 与本地 Secret Store 管理，永远不进配置或信封。
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

/** drain 超时：DRAINING 且过了截止时间 → OFFLINE；在途租约交给 reaper */
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
