import { beforeEach, describe, expect, it } from "vitest";
import { defaultConnection, getLiveConnection } from "./config";

const KEY = "platform.live.connection";

describe("live connection config", () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it("returns the same-origin defaults when nothing is stored", () => {
    expect(defaultConnection()).toEqual({
      schedulerUrl: "/api/scheduler",
      pcsUrl: "/api/pcs",
      adminToken: "",
      operator: "local@dev",
    });
    expect(getLiveConnection()).toEqual(defaultConnection());
  });

  it("migrates legacy proxy prefixes and trims trailing slashes", () => {
    sessionStorage.setItem(
      KEY,
      JSON.stringify({ schedulerUrl: "/scheduler/", pcsUrl: "/pcs/" }),
    );
    expect(getLiveConnection()).toMatchObject({
      schedulerUrl: "/api/scheduler",
      pcsUrl: "/api/pcs",
    });
  });

  it("fills in defaults for missing fields", () => {
    sessionStorage.setItem(KEY, JSON.stringify({ schedulerUrl: " https://sched.example " }));
    const connection = getLiveConnection();
    expect(connection.schedulerUrl).toBe("https://sched.example");
    expect(connection.pcsUrl).toBe("/api/pcs");
    expect(connection.adminToken).toBe("");
    expect(connection.operator).toBe("local@dev");
  });

  it("preserves a stored token without exposing it in the defaults", () => {
    sessionStorage.setItem(
      KEY,
      JSON.stringify({ schedulerUrl: "/api/scheduler", adminToken: "secret-token", operator: "ops" }),
    );
    expect(getLiveConnection().adminToken).toBe("secret-token");
    expect(getLiveConnection().operator).toBe("ops");
    expect(defaultConnection().adminToken).toBe("");
  });

  it("ignores corrupt or incomplete stored values", () => {
    sessionStorage.setItem(KEY, "{not json");
    expect(getLiveConnection()).toEqual(defaultConnection());
    sessionStorage.setItem(KEY, JSON.stringify({ adminToken: "orphan" }));
    expect(getLiveConnection()).toEqual(defaultConnection());
  });
});
