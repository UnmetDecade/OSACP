/**
 * Demo-only seed for the example-project storyline.
 *
 * Creates the two hosts, the deployments that name the studio cards, and the
 * sideload clients (development / test / after-sales). Idempotent: re-running the
 * demo keeps the same records. Enabled by DEMO_SEED=1 in the one-command demo.
 *
 * The scheduler instances themselves are not seeded: the real containers register
 * over the normal heartbeat path, so the studio shows live state.
 */
import { loadConfig } from "../src/config.js";
import { query } from "../src/db.js";
import { PcsService } from "../src/service.js";

const HOST_DEV = "docker-host-01";
const HOST_KERNEL = "dev-box";

const Gib = 1024 ** 3;

const hosts = [
  {
    host_id: HOST_DEV,
    hostname: "开发机",
    parent_host_id: null as string | null,
    labels: { role: "development" },
    resources: {
      cpu_count: 16,
      mem_total_bytes: 32 * Gib,
      mem_available_bytes: 14 * Gib,
      load1: 2.4,
      disk: [{ fs: "root", total_bytes: 512 * Gib, free_bytes: 336 * Gib }],
    },
  },
  {
    host_id: HOST_KERNEL,
    hostname: "调度机 · 内核开发",
    parent_host_id: HOST_DEV,
    labels: { role: "kernel" },
    resources: {
      cpu_count: 8,
      mem_total_bytes: 16 * Gib,
      mem_available_bytes: 9 * Gib,
      load1: 0.7,
      disk: [{ fs: "root", total_bytes: 256 * Gib, free_bytes: 190 * Gib }],
    },
  },
];

const deployments = [
  {
    deployment_id: "dep-demo-scheduler",
    instance_id: "scheduler",
    host_id: HOST_DEV,
    role_id: "scheduler",
    display_name: "调度机 · 派令",
    image: "platform/scheduler:demo",
  },
  {
    deployment_id: "dep-demo-ui",
    instance_id: "dev-ui",
    host_id: HOST_DEV,
    role_id: "builder",
    display_name: "界面开发",
    image: "platform/builder:demo-ubuntu22.04",
  },
  {
    deployment_id: "dep-demo-middle",
    instance_id: "dev-middle",
    host_id: HOST_DEV,
    role_id: "builder",
    display_name: "中间层开发",
    image: "platform/builder:demo-ubuntu22.04",
  },
  {
    deployment_id: "dep-demo-driver",
    instance_id: "dev-driver",
    host_id: HOST_DEV,
    role_id: "builder",
    display_name: "驱动开发",
    image: "platform/builder:demo-ubuntu22.04",
  },
  {
    deployment_id: "dep-demo-scheduler-kernel",
    instance_id: "scheduler-kernel",
    host_id: HOST_KERNEL,
    role_id: "scheduler",
    display_name: "调度机 · 内核",
    image: "platform/scheduler:demo",
  },
  {
    deployment_id: "dep-demo-kernel",
    instance_id: "kernel-dev",
    host_id: HOST_KERNEL,
    role_id: "builder",
    display_name: "内核开发",
    image: "platform/builder:demo-ubuntu22.04",
  },
];

const sideloads = [
  {
    name: "开发",
    scopes: ["tasks:read", "tasks:write", "builders:read", "queue:read", "console:run"],
  },
  { name: "测试", scopes: ["tasks:read", "tasks:write", "queue:read", "console:run"] },
  { name: "售后", scopes: ["tasks:read", "queue:read"] },
];

async function seedHosts(): Promise<void> {
  for (const h of hosts) {
    await query(
      `INSERT INTO pcs_hosts
         (host_id, hostname, status, labels, resources, os, arch, parent_host_id, last_seen_at)
       VALUES ($1,$2,'ONLINE',$3,$4,'Linux','x86_64',$5, now())
       ON CONFLICT (host_id) DO UPDATE SET
         hostname=EXCLUDED.hostname,
         status='ONLINE',
         labels=EXCLUDED.labels,
         resources=EXCLUDED.resources,
         os=EXCLUDED.os,
         arch=EXCLUDED.arch,
         parent_host_id=EXCLUDED.parent_host_id,
         last_seen_at=now(),
         updated_at=now()`,
      [h.host_id, h.hostname, JSON.stringify(h.labels), JSON.stringify(h.resources), h.parent_host_id],
    );
  }
}

async function seedDeployments(): Promise<void> {
  for (const d of deployments) {
    await query(
      `INSERT INTO pcs_deployments
         (deployment_id, instance_id, host_id, role_id, display_name, image,
          desired_state, actual_state, status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,'RUNNING','RUNNING','HEALTHY','demo')
       ON CONFLICT (deployment_id) DO UPDATE SET
         instance_id=EXCLUDED.instance_id,
         host_id=EXCLUDED.host_id,
         role_id=EXCLUDED.role_id,
         display_name=EXCLUDED.display_name,
         image=EXCLUDED.image,
         desired_state='RUNNING',
         actual_state='RUNNING',
         status='HEALTHY',
         updated_at=now()`,
      [d.deployment_id, d.instance_id, d.host_id, d.role_id, d.display_name, d.image],
    );
  }
}

async function seedSideloads(service: PcsService): Promise<void> {
  for (const s of sideloads) {
    const existing = await query(
      `SELECT 1 FROM pcs_sideloads
        WHERE host_id=$1 AND name=$2 AND revoked_at IS NULL
        LIMIT 1`,
      [HOST_DEV, s.name],
    );
    if (existing.rowCount) continue;
    await service.createSideload({
      host_id: HOST_DEV,
      name: s.name,
      scopes: s.scopes,
      created_by: "demo",
    });
    console.log(`[demo-seed] sideload ${s.name}`);
  }
}

async function main(): Promise<void> {
  await seedHosts();
  await seedDeployments();
  await seedSideloads(new PcsService(loadConfig()));
  console.log("[demo-seed] hosts, deployments and sideloads ready");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("[demo-seed] failed:", e instanceof Error ? e.message : e);
    process.exit(1);
  });
