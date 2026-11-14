import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, errorMessage, pcs, scheduler, schedulerFor } from "./client";
import { defaultConnection, type LiveConnection } from "./config";

const connection: LiveConnection = {
  ...defaultConnection(),
  adminToken: "test-token",
  operator: "ops",
};

function json(body: unknown, status = 200, statusText = ""): Response {
  return new Response(JSON.stringify(body), { status, statusText });
}

let fetchMock: ReturnType<typeof vi.fn>;

function lastRequest(): { url: string; init: RequestInit } {
  const call = fetchMock.mock.calls.at(-1);
  if (!call) throw new Error("fetch was not called");
  return { url: String(call[0]), init: (call[1] ?? {}) as RequestInit };
}

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("request", () => {
  it("sends the control-plane path with a bearer token and JSON body", async () => {
    fetchMock.mockResolvedValue(json({ ok: true }));
    const out = await pcs(connection, "/api/v1/platform/hosts", {
      method: "POST",
      body: { name: "devbox" },
    });

    expect(out).toEqual({ ok: true });
    const { url, init } = lastRequest();
    expect(url).toBe("/api/pcs/api/v1/platform/hosts");
    expect(init.method).toBe("POST");
    expect(init.cache).toBe("no-store");
    expect(init.body).toBe(JSON.stringify({ name: "devbox" }));
    expect(init.headers).toMatchObject({
      accept: "application/json",
      "content-type": "application/json",
      authorization: "Bearer test-token",
    });
  });

  it("never sends the admin token to the scheduler", async () => {
    fetchMock.mockResolvedValue(json({ items: [] }));
    await scheduler(connection, "/v1/instances");

    const { url, init } = lastRequest();
    expect(url).toBe("/api/scheduler/v1/instances");
    expect(init.headers).not.toHaveProperty("authorization");
    expect(init.headers).not.toHaveProperty("content-type");
    expect(init.body).toBeUndefined();
  });

  it("falls back to the default scheduler when no deployment is selected", async () => {
    fetchMock.mockResolvedValue(json({ items: [] }));
    await schedulerFor(connection, null, "/v1/tasks?limit=5");

    expect(lastRequest().url).toBe("/api/scheduler/v1/tasks?limit=5");
  });

  it("proxies a deployment-specific request through the control plane", async () => {
    fetchMock.mockResolvedValue(json({ items: [] }));
    await schedulerFor(connection, "dep/root", "/v1/tasks?limit=5");

    const { url, init } = lastRequest();
    expect(url).toBe(
      "/api/pcs/api/v1/platform/schedulers/dep%2Froot/proxy/v1/tasks?limit=5",
    );
    expect(init.headers).toMatchObject({ authorization: "Bearer test-token" });
  });

  it("turns a network failure into a coded ApiError", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(pcs(connection, "/api/v1/platform/hosts")).rejects.toMatchObject({
      status: 0,
      code: "NETWORK_ERROR",
    });
    await expect(pcs(connection, "/api/v1/platform/hosts")).rejects.toThrow(
      /ECONNREFUSED/,
    );
  });

  it("surfaces the structured error code and detail", async () => {
    fetchMock.mockResolvedValue(
      json(
        {
          error: {
            message: "plan digest mismatch",
            code: "PLAN_MISMATCH",
            detail: { checks: [{ ok: false, detail: "digest" }] },
          },
        },
        409,
        "Conflict",
      ),
    );

    const error = await pcs(connection, "/plans/1/apply", {
      method: "POST",
      body: {},
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 409,
      code: "PLAN_MISMATCH",
      message: "plan digest mismatch",
    });
  });

  it("uses a plain-text body when the gateway returns one", async () => {
    fetchMock.mockResolvedValue(
      new Response("upstream unavailable", { status: 502, statusText: "Bad Gateway" }),
    );
    await expect(pcs(connection, "/api/v1/platform/hosts")).rejects.toMatchObject({
      status: 502,
      code: "HTTP_ERROR",
      message: "upstream unavailable",
    });
  });

  it("replaces an HTML error page with the HTTP status", async () => {
    fetchMock.mockResolvedValue(
      new Response("<html>bad gateway</html>", { status: 502, statusText: "Bad Gateway" }),
    );
    await expect(pcs(connection, "/api/v1/platform/hosts")).rejects.toMatchObject({
      code: "HTTP_ERROR",
      message: "HTTP 502 Bad Gateway",
    });
  });

  it("returns a plain body without JSON wrapping", async () => {
    fetchMock.mockResolvedValue(new Response("pong", { status: 200 }));
    await expect(scheduler(connection, "/healthz")).resolves.toBe("pong");
  });
});

describe("errorMessage", () => {
  it("lists the failed pre-deployment checks", () => {
    const error = new ApiError(400, "PRECHECK_FAILED", "precheck failed", {
      checks: [
        { ok: true, detail: "image present" },
        { ok: false, detail: "host offline" },
        { ok: false, detail: "disk full" },
      ],
    });
    expect(errorMessage(error)).toBe("PRECHECK_FAILED: host offline; disk full");
  });

  it("does not prefix HTTP_ERROR because it already carries the status text", () => {
    expect(errorMessage(new ApiError(503, "HTTP_ERROR", "HTTP 503 Service Unavailable"))).toBe(
      "HTTP 503 Service Unavailable",
    );
  });

  it("prefixes other codes", () => {
    expect(errorMessage(new ApiError(404, "INSTANCE_UNKNOWN", "gone"))).toBe(
      "INSTANCE_UNKNOWN: gone",
    );
  });

  it("handles plain errors and unknown values", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
    expect(errorMessage("boom")).toBe("boom");
    expect(errorMessage(42)).toBe("42");
  });
});
