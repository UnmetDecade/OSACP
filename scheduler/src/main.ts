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
 * Three background sweeps:
 *   - heartbeat sweep: 45s → SUSPECT (excluded from new claims), 90s → OFFLINE
 *   - drain timeout: still DRAINING past the deadline → OFFLINE
 *   - lease cleanup: start-window timeout / lease expired → reap, requeue, dead-letter
 * All are "idempotent + SKIP LOCKED", so multiple processes never double-process.
 */
async function tick() {
  if (running) return; // Skip if the previous round has not finished, so nothing piles up
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
 * Node schedulers report aggregated capability to their parent.
 *
 * Runs only when SCHEDULER_PARENT_URL + SCHEDULER_FEDERATION_TOKEN are configured; a failed report is only logged,
 * without affecting local dispatch. The parent records parent_node_id as itself for this report, so this side need not know the parent id.
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
        // Capacity metrics report whole-subtree values: an intermediate node may have no builders itself, but its subtree does.
        builder_count: snap.subtree_builder_count,
        child_count: snap.child_count,
        // The parent needs for relaying: reachable address, max W, idle count, subtree instance roster.
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
 * Relay sync: pull back the state of tasks running on children. Completely independent of local dispatch;
 * when a child is unreachable only the error is recorded, and the parent task stays as is, never reaped and re-run.
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
    // The parent may be set at runtime (host join), so the timer always runs; the report function skips when there is no parent.
    if (config.federationToken) {
      federationTimer = setInterval(reportUpstream, config.federationIntervalMs);
      void reportUpstream();
    }
    // Without relays this round just queries an empty table; skipping costs less than checking "are there child nodes".
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
