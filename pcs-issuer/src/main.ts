import { pool } from "./db.js";
import { loadConfig } from "./config.js";
import { createPcsServer } from "./http.js";
import { PcsService } from "./service.js";
import { handleTerminalUpgrade } from "./terminal.js";

const cfg = loadConfig();
const service = new PcsService(cfg);
const server = createPcsServer(service, cfg);
// Interactive terminal: WebSocket upgrades bypass the normal HTTP handler and are mounted separately.
server.on("upgrade", handleTerminalUpgrade);

let sweepTimer: NodeJS.Timeout | undefined;
let sweeping = false;

async function sweep(): Promise<void> {
  if (sweeping) return;
  sweeping = true;
  try {
    const r = await service.sweep();
    if (r.offline.length) console.log("[host] OFFLINE", r.offline.join(","));
  } catch (e) {
    console.error("[sweep]", e);
  } finally {
    sweeping = false;
  }
}

server.listen(cfg.port, cfg.host, () => {
  console.log(`platform-control (PCS stand-in) listening on ${cfg.host}:${cfg.port}`);
  console.log(`  Database ${cfg.databaseUrl.replace(/\/\/[^@]+@/, "//***@")}`);
  if (!cfg.imageAllowlist.length) {
    console.warn("[deploy] PCS_IMAGE_ALLOWLIST is empty: every deployment intent will be rejected (deny by default)");
  } else {
    console.log(`  Image allowlist ${cfg.imageAllowlist.join(", ")}`);
  }
  sweepTimer = setInterval(() => void sweep(), cfg.tickMs);
  void sweep();
});

async function shutdown(signal: string): Promise<void> {
  console.log(`\n${signal}: shutting down…`);
  if (sweepTimer) clearInterval(sweepTimer);
  server.close();
  await pool.end().catch(() => {});
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
