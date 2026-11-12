/**
 * 实时连接配置。
 *
 * 应用不再有演示模式：目标固定为页面同源的调度机与控制面代理。
 * 令牌只从 sessionStorage 读取（可通过调试或截图脚本注入），不写 localStorage、不写 URL、不在界面回显。
 */
export type LiveConnection = {
  /** 调度机地址，固定为同源代理。 */
  schedulerUrl: string;
  /** 控制面地址，固定为同源代理。 */
  pcsUrl: string;
  /** 访问令牌，可选；为空时不发送 Authorization。 */
  adminToken: string;
  /** 审计里显示的操作者名，默认 local@dev。 */
  operator: string;
};

const KEY = "platform.live.connection";

function normalizeBase(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

export function defaultConnection(): LiveConnection {
  return {
    // /api/* 前缀：/scheduler 是页面路由，不能再同时当 API 代理前缀。
    schedulerUrl: "/api/scheduler",
    pcsUrl: "/api/pcs",
    adminToken: "",
    operator: "local@dev",
  };
}

/** 旧版本把同源代理写成 /scheduler，和页面路由撞车；读到就顺手升级。 */
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

/** 始终返回可用连接：优先带令牌的 sessionStorage 配置，否则用同源默认值。 */
export function getLiveConnection(): LiveConnection {
  return readStored() ?? defaultConnection();
}
