export const config = {
  port: Number(process.env.PORT ?? 7801),
  // 默认只听回环：对外只经控制面反向代理 + mTLS 暴露，不直接把端口挂到网卡上
  host: process.env.HOST ?? "127.0.0.1",
  databaseUrl:
    process.env.DATABASE_URL ??
    "postgres://postgres:sched_dev_pw@127.0.0.1:5432/scheduler",
  tickMs: Number(process.env.TICK_MS ?? 1000),
  // 生产环境的循环开关；测试里直接调用 sweep 函数，不跑循环
  loops: process.env.DISABLE_LOOPS !== "1",
  // P6：直连 TLS / mTLS。证书与私钥必须同时配置。
  tlsCertFile: (process.env.SCHEDULER_TLS_CERT_FILE ?? "").trim(),
  tlsKeyFile: (process.env.SCHEDULER_TLS_KEY_FILE ?? "").trim(),
  tlsCaFile: (process.env.SCHEDULER_TLS_CA_FILE ?? "").trim(),
  mtls: process.env.SCHEDULER_MTLS === "1",
  // 联邦树：本节点的 id、宿主 id、上级调度机地址与共享令牌。
  // 没有 PARENT_URL 时本节点就是根；根和结点都按直接子结点的上报做任务下推。
  nodeId: (process.env.SCHEDULER_NODE_ID ?? "").trim(),
  hostId: (process.env.SCHEDULER_HOST_ID ?? "").trim(),
  parentUrl: (process.env.SCHEDULER_PARENT_URL ?? "").trim().replace(/\/+$/, ""),
  federationToken: (process.env.SCHEDULER_FEDERATION_TOKEN ?? "").trim(),
  federationIntervalMs: Math.max(
    5000,
    Number(process.env.SCHEDULER_FEDERATION_INTERVAL_MS ?? 30000) || 30000,
  ),
  // 本调度机对同联邦其它调度机的可达地址。PCS 部署时按「主机地址 + 宿主端口」注入；
  // 子结点把它随能力上报一起交给父结点，父结点中继任务时才知道往哪发。
  advertiseUrl: (process.env.SCHEDULER_ADVERTISE_URL ?? "").trim().replace(/\/+$/, ""),
  // 父结点镜像子结点任务状态的周期。0 表示关闭中继同步（只保留转发）。
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
