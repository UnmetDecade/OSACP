import { config } from "./config.js";
import { pool } from "./db.js";
import { authEnabled } from "./auth.js";
import { createServer } from "./http/server.js";
import { sweepLeases } from "./loops/reaper.js";
import { sweepDrainTimeouts, sweepHeartbeats } from "./repo/instances.js";
import { capabilitySnapshot } from "./repo/federation.js";
import { getFederationParentUrl } from "./federation-state.js";
import { syncRelays } from "./core/relay.js";
import { selfNodeId } from "./node.js";

const server = createServer();

async function readTuning() {
  const res = await pool.query("SELECT * FROM scheduler_config WHERE id = TRUE");
  return res.rows[0];
}

let timer: NodeJS.Timeout | undefined;
let running = false;
let federationTimer: NodeJS.Timeout | undefined;
let relayTimer: NodeJS.Timeout | undefined;
let reporting = false;
let syncingRelays = false;

/**
 * 三个后台扫描：
 *   - 心跳扫描：45s → SUSPECT（不参与新领取），90s → OFFLINE
 *   - drain 超时：过了截止时间仍是 DRAINING → OFFLINE
 *   - 租约清理：启动窗口超时 / 租约过期 → 回收、回队、死信
 * 都是“幂等 + SKIP LOCKED”，多进程跑也不会重复处理。
 */
async function tick() {
  if (running) return; // 上一轮没跑完就跳过，不堆积
  running = true;
  try {
    const cfg = await readTuning();
    const hb = await sweepHeartbeats({
      suspectAfter: cfg.suspect_after_seconds,
      offlineAfter: cfg.offline_after_seconds,
    });
    if (hb.suspect.length) console.log("[heartbeat] SUSPECT", hb.suspect.join(","));
    if (hb.offline.length) console.log("[heartbeat] OFFLINE", hb.offline.join(","));

    const drainedOut = await sweepDrainTimeouts();
    if (drainedOut.length) console.log("[drain] 超时 OFFLINE", drainedOut.join(","));

    const r = await sweepLeases();
    if (r.reclaimed.length) {
      console.log(
        "[lease] 回收",
        r.reclaimed.map((x) => `${x.task_id}:${x.cause}->${x.to}`).join(" "),
      );
    }
  } catch (e) {
    console.error("[tick]", e);
  } finally {
    running = false;
  }
}

/**
 * 结点调度机向上级上报聚合能力。
 *
 * 只在配置了 SCHEDULER_PARENT_URL + SCHEDULER_FEDERATION_TOKEN 时运行；上报失败只记日志，
 * 不影响本地派发。上级把本次上报的 parent_node_id 记成自己，因此这里不需要知道对方 id。
 */
async function reportUpstream() {
  const parentUrl = getFederationParentUrl();
  if (!parentUrl || !config.federationToken) return;
  if (reporting) return;
  reporting = true;
  try {
    const snap = await capabilitySnapshot(selfNodeId());
    const res = await fetch(`${parentUrl}/v1/nodes/report`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-federation-token": config.federationToken,
      },
      body: JSON.stringify({
        node_id: snap.node_id,
        host_id: config.hostId || snap.node_id,
        local_score: snap.local_score,
        subtree_score: snap.subtree_score,
        // 容量指标报整棵子树的值：中间结点自己可能没有构建机，但子树里有。
        builder_count: snap.subtree_builder_count,
        child_count: snap.child_count,
        // 父结点中继任务需要：可达地址、最大 W、空闲数、子树实例名册。
        url: config.advertiseUrl || null,
        max_builder_score: snap.subtree_max_builder_score,
        idle_builder_count: snap.subtree_idle_builder_count,
        instances: snap.instances,
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      console.warn(`[federation] 上报失败 ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
  } catch (e) {
    console.warn("[federation] 上报失败", e instanceof Error ? e.message : e);
  } finally {
    reporting = false;
  }
}

/**
 * 中继同步：把子结点上执行中的任务状态拉回来。和本地派发完全独立，
 * 子结点不可达时只记错误，父任务保持原状，不会回收重跑。
 */
async function relayTick() {
  if (syncingRelays) return;
  syncingRelays = true;
  try {
    const r = await syncRelays();
    if (r.updated) console.log(`[relay] 同步 ${r.checked} 条，状态更新 ${r.updated} 条`);
  } catch (e) {
    console.error("[relay]", e);
  } finally {
    syncingRelays = false;
  }
}

server.listen(config.port, config.host, () => {
  console.log(`scheduler listening on ${config.host}:${config.port}`);
  if (!authEnabled()) {
    console.warn("[auth] 未配置 PCS 公钥或 AUTH_TOKEN：实例/Worker 接口无鉴权，只允许本地开发使用");
  } else if (process.env.PCS_PUBLIC_KEY_FILE || process.env.PCS_PUBLIC_KEY) {
    console.log("[auth] 实例鉴权：ES256 JWT 验签");
  } else {
    console.warn("[auth] 实例鉴权：共享 AUTH_TOKEN（过渡方案）");
  }
  if (config.loops) {
    timer = setInterval(tick, config.tickMs);
    void tick();
    // 上级可能在运行时被设置（主机并入），所以定时器常开，没上级时上报函数直接跳过。
    if (config.federationToken) {
      federationTimer = setInterval(reportUpstream, config.federationIntervalMs);
      void reportUpstream();
    }
    // 没有中继时这轮只是查一张空表；跳过的代价比判断「有没有子结点」还低。
    relayTimer = setInterval(relayTick, config.relaySyncMs);
  }
});

async function shutdown(signal: string) {
  console.log(`\n${signal}，正在停止…`);
  if (timer) clearInterval(timer);
  if (federationTimer) clearInterval(federationTimer);
  if (relayTimer) clearInterval(relayTimer);
  server.close();
  await pool.end().catch(() => {});
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
