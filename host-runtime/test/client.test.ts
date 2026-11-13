import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { SchedulerClient, SchedulerError } from "../src/client.js";

let server: http.Server;
let base: string;
let hits: string[] = [];
let auths: Array<string | undefined> = [];
let script: Array<{ status: number; body?: unknown }> = [];

before(async () => {
  server = http.createServer((req, res) => {
    hits.push(req.url ?? "");
    auths.push(req.headers.authorization);
    const next = script.shift() ?? { status: 200, body: { ok: true } };
    res.writeHead(next.status, { "content-type": "application/json" });
    res.end(next.body === undefined ? "" : JSON.stringify(next.body));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address() as import("node:net").AddressInfo;
  base = `http://127.0.0.1:${addr.port}`;
});

after(() => new Promise<void>((r) => server.close(() => r())));

describe("scheduler client", () => {
  it("5xx responses are retried automatically", async () => {
    hits = [];
    script = [
      { status: 503, body: { error: { code: "UNAVAILABLE", message: "db down" } } },
      { status: 200, body: { instance_id: "worker-a", state: "ONLINE" } },
    ];
    const c = new SchedulerClient(base);
    const r = await c.heartbeat({ instance_id: "worker-a" });
    assert.equal(r?.state, "ONLINE");
    assert.equal(hits.length, 2);
  });

  it("409 FENCING_STALE is not retried and is thrown to the caller", async () => {
    hits = [];
    script = [
      { status: 409, body: { error: { code: "FENCING_STALE", message: "fencing has expired" } } },
    ];
    const c = new SchedulerClient(base);
    await assert.rejects(
      () => c.progress("att_1", { lease_token: "l", fencing_token: 1 }),
      (e: unknown) => {
        assert.ok(e instanceof SchedulerError);
        assert.equal(e.code, "FENCING_STALE");
        assert.equal(e.isFencingLost, true);
        return true;
      },
    );
    assert.equal(hits.length, 1, "business errors should not be retried");
  });

  it("claim returns null on 204", async () => {
    script = [{ status: 204 }];
    const c = new SchedulerClient(base);
    assert.equal(await c.claim("worker-a"), null);
  });

  it("config's 304 normalizes to null and forwards the Bearer token", async () => {
    hits = [];
    auths = [];
    script = [{ status: 304 }];
    const c = new SchedulerClient(base, 5000, "tok-123");
    assert.equal(await c.config("worker-a", 7), null);
    assert.equal(hits[0], "/v1/instances/worker-a/config?version=7");
    assert.equal(auths[0], "Bearer tok-123");
  });

  it("an unreachable scheduler normalizes to status 0", async () => {
    const c = new SchedulerClient("http://127.0.0.1:1", 300);
    await assert.rejects(
      () => c.claim("worker-a"),
      (e: unknown) => {
        assert.ok(e instanceof SchedulerError);
        assert.equal(e.status, 0);
        assert.equal(e.code, "SCHEDULER_UNREACHABLE");
        return true;
      },
    );
  });
});
