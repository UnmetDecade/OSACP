import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { databaseUrlFromEnv } from "./db.js";

const { Client } = pg;
const here = path.dirname(fileURLToPath(import.meta.url));
const sqlDir = path.join(here, "..", "sql");

async function ensureDatabase(): Promise<void> {
  const url = new URL(databaseUrlFromEnv());
  const dbName = decodeURIComponent(url.pathname.replace(/^\//, ""));
  const adminUrl = new URL(url.toString());
  adminUrl.pathname = "/postgres";

  const admin = new Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  try {
    const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [dbName]);
    if (!exists.rowCount) {
      await admin.query(`CREATE DATABASE "${dbName.replace(/"/g, '""')}"`);
      console.log(`created database ${dbName}`);
    }
  } finally {
    await admin.end();
  }
}

async function runFile(file: string): Promise<void> {
  const sql = fs.readFileSync(path.join(sqlDir, file), "utf8");
  const client = new Client({ connectionString: databaseUrlFromEnv() });
  await client.connect();
  try {
    await client.query(sql);
    console.log(`applied ${file}`);
  } finally {
    await client.end();
  }
}

await ensureDatabase();
await runFile("001_init.sql");
await runFile("002_profiles.sql");
await runFile("003_deployment_plans.sql");
await runFile("004_ssh_ports.sql");
await runFile("005_ssh_hosts.sql");
await runFile("006_agent_profile_prompt.sql");
await runFile("007_ssh_host_auth.sql");
await runFile("008_deployment_syncing.sql");
await runFile("009_host_scoped_bindings.sql");
await runFile("010_host_federation.sql");
await runFile("011_scheduler_nodes.sql");
await runFile("012_task_attachments.sql");
await runFile("013_native_roles.sql");
// 014 sideloads: per-host curl tokens with a closed permission vocabulary.
await runFile("014_sideloads.sql");
process.exit(0);
