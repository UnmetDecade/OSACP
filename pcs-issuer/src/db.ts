import pg from "pg";

const { Pool } = pg;

export function databaseUrlFromEnv(): string {
  return (
    process.env.PCS_DATABASE_URL ??
    "postgres://postgres:sched_dev_pw@127.0.0.1:5432/platform_control"
  );
}

export const pool = new Pool({
  connectionString: databaseUrlFromEnv(),
  max: 10,
  idleTimeoutMillis: 30_000,
});

export type Client = pg.PoolClient;

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  values: unknown[] = [],
): Promise<pg.QueryResult<T>> {
  return pool.query<T>(text, values);
}

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
