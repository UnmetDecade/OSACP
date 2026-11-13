import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { config } from "./config.js";

const { Client } = pg;
const here = path.dirname(fileURLToPath(import.meta.url));
// Source layout is src/migrate.ts + ../sql. The bundled layout is app/migrate.mjs + app/sql when the
// files are available, otherwise app/sql.json: the deployment channel accepts at most 16 files, so the
// payload ships every migration inside one bundle instead of one file per migration.
const sqlDir =
  [path.join(here, "sql"), path.join(here, "..", "sql")].find((d) => fs.existsSync(d)) ??
  path.join(here, "..", "sql");
const sqlBundleFile = [path.join(here, "sql.json"), path.join(here, "..", "sql.json")].find((f) =>
  fs.existsSync(f),
);
const sqlBundle: Record<string, string> | null = sqlBundleFile
  ? (JSON.parse(fs.readFileSync(sqlBundleFile, "utf8")) as Record<string, string>)
  : null;

async function ensureDatabase(): Promise<void> {
  const url = new URL(config.databaseUrl);
  const dbName = decodeURIComponent(url.pathname.replace(/^\//, ""));
  const adminUrl = new URL(config.databaseUrl);
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
  const sql = sqlBundle?.[file] ?? fs.readFileSync(path.join(sqlDir, file), "utf8");
  const client = new Client({ connectionString: config.databaseUrl });
  await client.connect();
  try {
    await client.query(sql);
    console.log(`applied ${file}`);
  } finally {
    await client.end();
  }
}

const seed = process.argv.includes("--seed");
await ensureDatabase();
await runFile("001_init.sql");
await runFile("003_profiles.sql");
if (seed) await runFile("002_seed.sql");
// 004 depends on the instance rows from 002; it must run after the seed so registered instances also get their task types.
await runFile("004_chat_console.sql");
// 005 is runtime-required data (resource profiles / task.build), independent of the demo seed, and runs on every migration.
await runFile("005_essentials.sql");
// 006 capability score W / task difficulty D / node reporting.
await runFile("006_capability.sql");
// 007 cross-scheduler task relay: child addresses/instance roster + relay mapping table.
await runFile("007_relay.sql");
// 008 dynamic scheduling: pool/grant ledger, capability split and claim backoff fields.
await runFile("008_dynamic_scheduling.sql");
// 009 agent control: NEEDS_INPUT, fan-out parents/children, approval mode and typed outcomes.
await runFile("009_agent_control.sql");
// 010 failure recovery: retry waivers for external waits + failure_class on attempts.
await runFile("010_failure_recovery.sql");
// 011 artifact names: the file channel needs the original name for downloads and file lists.
await runFile("011_artifact_names.sql");
process.exit(0);
