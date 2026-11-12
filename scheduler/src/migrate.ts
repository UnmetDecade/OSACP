import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { config } from "./config.js";

const { Client } = pg;
const here = path.dirname(fileURLToPath(import.meta.url));
// 源码布局是 src/migrate.ts + ../sql；打成 bundle 后是 app/migrate.mjs + app/sql。
const sqlDir =
  [path.join(here, "sql"), path.join(here, "..", "sql")].find((d) => fs.existsSync(d)) ??
  path.join(here, "..", "sql");

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
  const sql = fs.readFileSync(path.join(sqlDir, file), "utf8");
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
// 004 依赖 002 的实例行；必须放在 seed 之后，才能把已注册实例也补上任务类型。
await runFile("004_chat_console.sql");
// 005 是运行必需数据（资源画像 / task.build），不依赖演示种子，每次迁移都执行。
await runFile("005_essentials.sql");
// 006 工作能力值 W / 任务难度 D / 结点上报。
await runFile("006_capability.sql");
// 007 跨调度机任务中继：子结点地址/实例名册 + 中继映射表。
await runFile("007_relay.sql");
process.exit(0);
