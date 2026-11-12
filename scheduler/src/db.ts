import pg from "pg";
import { config } from "./config.js";

const { Pool } = pg;

export const pool = new Pool({
  connectionString: config.databaseUrl,
  max: Number(process.env.PG_POOL_MAX ?? 10),
  application_name: "scheduler",
});

export type Client = pg.PoolClient;

export async function q<T extends pg.QueryResultRow = any>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const res = await pool.query<T>(sql, params);
  return res.rows;
}

export async function q1<T extends pg.QueryResultRow = any>(
  sql: string,
  params: unknown[] = [],
): Promise<T | null> {
  const rows = await q<T>(sql, params);
  return rows[0] ?? null;
}

/** All write paths go through here; a thrown error rolls back automatically */
export async function tx<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** Database time, the only trustworthy time source */
export async function now(c: Client | typeof pool = pool): Promise<Date> {
  const res = await c.query<{ t: Date }>("SELECT app_now() AS t");
  return res.rows[0].t;
}

export async function closePool(): Promise<void> {
  await pool.end();
}
