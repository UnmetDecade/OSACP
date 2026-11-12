export const config = {
  port: Number(process.env.PORT ?? 7801),
  // Listen on loopback by default: expose externally only through the control-plane reverse proxy + mTLS, never bind the port directly to a NIC
  host: process.env.HOST ?? "127.0.0.1",
  databaseUrl:
    process.env.DATABASE_URL ??
    "postgres://postgres:sched_dev_pw@127.0.0.1:5432/scheduler",
  tickMs: Number(process.env.TICK_MS ?? 1000),
  // Loop switches for production; tests call the sweep functions directly and run no loops
  loops: process.env.DISABLE_LOOPS !== "1",
  // P6: direct TLS / mTLS. Certificate and private key must be configured together.
  tlsCertFile: (process.env.SCHEDULER_TLS_CERT_FILE ?? "").trim(),
  tlsKeyFile: (process.env.SCHEDULER_TLS_KEY_FILE ?? "").trim(),
  tlsCaFile: (process.env.SCHEDULER_TLS_CA_FILE ?? "").trim(),
  mtls: process.env.SCHEDULER_MTLS === "1",
  // Federation tree: this node id, host id, parent scheduler URL and shared token.
  // Without PARENT_URL this node is the root; both root and nodes push tasks based on direct-child reports.
  nodeId: (process.env.SCHEDULER_NODE_ID ?? "").trim(),
  hostId: (process.env.SCHEDULER_HOST_ID ?? "").trim(),
  parentUrl: (process.env.SCHEDULER_PARENT_URL ?? "").trim().replace(/\/+$/, ""),
  federationToken: (process.env.SCHEDULER_FEDERATION_TOKEN ?? "").trim(),
  federationIntervalMs: Math.max(
    5000,
    Number(process.env.SCHEDULER_FEDERATION_INTERVAL_MS ?? 30000) || 30000,
  ),
  // This scheduler's reachable address for other schedulers in the federation. PCS injects it as "host address + host port" at deployment;
  // a child sends it to its parent with the capability report, so the parent knows where to send relayed tasks.
  advertiseUrl: (process.env.SCHEDULER_ADVERTISE_URL ?? "").trim().replace(/\/+$/, ""),
  // Period at which the parent mirrors child task state. 0 disables relay sync (forwarding only).
  relaySyncMs: Math.max(
    250,
    Number(process.env.SCHEDULER_RELAY_SYNC_MS ?? 2000) || 2000,
  ),
} as const;

if (Boolean(config.tlsCertFile) !== Boolean(config.tlsKeyFile)) {
  throw new Error("SCHEDULER_TLS_CERT_FILE 与 SCHEDULER_TLS_KEY_FILE 必须同时配置");
}
if (config.mtls && (!config.tlsCertFile || !config.tlsCaFile)) {
  throw new Error("SCHEDULER_MTLS=1 需要同时配置 TLS 证书与客户端 CA（SCHEDULER_TLS_CA_FILE）");
}
