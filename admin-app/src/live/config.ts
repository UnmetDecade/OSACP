/**
 * Live connection configuration.
 *
 * The app no longer has a demo mode: targets are always the same-origin scheduler and control plane proxies.
 * The token is read only from sessionStorage (injectable via devtools or capture scripts); never written to localStorage or the URL, and never echoed in the UI.
 */
export type LiveConnection = {
  /** Scheduler address, fixed to the same-origin proxy. */
  schedulerUrl: string;
  /** Control plane address, fixed to the same-origin proxy. */
  pcsUrl: string;
  /** Access token, optional; no Authorization header is sent when empty. */
  adminToken: string;
  /** Operator name shown in audit logs; defaults to local@dev. */
  operator: string;
};

const KEY = "platform.live.connection";

function normalizeBase(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

export function defaultConnection(): LiveConnection {
  return {
    // /api/* prefix: /scheduler is a page route and can no longer double as the API proxy prefix.
    schedulerUrl: "/api/scheduler",
    pcsUrl: "/api/pcs",
    adminToken: "",
    operator: "local@dev",
  };
}

/** Older versions used /scheduler for the same-origin proxy, colliding with the page route; upgrade it on read. */
function migrateBase(value: string): string {
  if (value === "/scheduler") return "/api/scheduler";
  if (value === "/pcs") return "/api/pcs";
  return value;
}

function readStored(): LiveConnection | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<LiveConnection>;
    if (!parsed.schedulerUrl) return null;
    return {
      schedulerUrl: migrateBase(normalizeBase(parsed.schedulerUrl)),
      pcsUrl: migrateBase(normalizeBase(parsed.pcsUrl || "/api/pcs")),
      adminToken: String(parsed.adminToken ?? ""),
      operator: String(parsed.operator || "local@dev"),
    };
  } catch {
    return null;
  }
}

/** Always return a usable connection: prefer a sessionStorage config with a token, otherwise use the same-origin default. */
export function getLiveConnection(): LiveConnection {
  return readStored() ?? defaultConnection();
}
