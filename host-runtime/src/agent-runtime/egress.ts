import dns from "node:dns/promises";
import net from "node:net";

/** 云元数据与控制面地址：无论白名单怎么写都拒绝（§3.7）。 */
const METADATA = new Set([
  "169.254.169.254",
  "169.254.170.2",
  "100.100.100.200",
  "fd00:ec2::254",
]);

const HOST_SUFFIX_BLOCK = ["metadata.google.internal", "metadata.azure.internal"];

export class EgressDenied extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "EgressDenied";
  }
}

export interface EgressPolicyOptions {
  /** 策略名 -> 允许的 host（精确或 *.suffix） */
  policies: Record<string, string[]>;
  /** 仅本地开发：允许 127.0.0.1 / ::1 */
  allowLoopback?: boolean;
}

function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "");
}

export function hostAllowed(host: string, allow: string[]): boolean {
  const h = normalizeHost(host);
  return allow.some((rule) => {
    const r = normalizeHost(rule);
    if (r.startsWith("*.")) return h.endsWith(r.slice(1)) && h.length > r.length - 1;
    return h === r;
  });
}

/** IP 是否属于禁止出站的地址（元数据、回环、私网、链路本地）。 */
export function isBlockedIp(ip: string, allowLoopback = false): boolean {
  const addr = normalizeHost(ip);
  if (METADATA.has(addr)) return true;
  const family = net.isIP(addr);
  if (family === 4) {
    const [a, b, c] = addr.split(".").map(Number);
    if (a === 0 || a === 127) return !allowLoopback;
    if (a === 169 && b === 254) return true;
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT / 部分云内网
    if (a === 198 && (b === 18 || b === 19)) return true;
    if (a >= 224) return true;
    void c;
    return false;
  }
  if (family === 6) {
    if (addr === "::" || addr === "::1") return !allowLoopback;
    if (addr.startsWith("fd") || addr.startsWith("fc")) return true;
    if (/^fe[89ab]/.test(addr)) return true;
    if (addr.startsWith("ff")) return true;
    return false;
  }
  return true;
}

/**
 * 校验目标 URL 是否允许访问。
 *
 * - egress 策略必须显式存在（默认拒绝）；
 * - host 必须在策略白名单内；
 * - DNS 解析出的每个地址都必须在白名单语义下可放行（元数据/私网一律否）。
 */
export async function assertEgressAllowed(
  url: URL,
  policyName: string | null,
  opts: EgressPolicyOptions,
): Promise<void> {
  if (!policyName) {
    throw new EgressDenied("EGRESS_POLICY_REQUIRED", "API Profile 未声明 egress 策略，默认拒绝");
  }
  const allow = opts.policies[policyName];
  if (!allow) {
    throw new EgressDenied("EGRESS_POLICY_UNKNOWN", `未知出站策略：${policyName}`);
  }
  const host = normalizeHost(url.hostname);
  if (HOST_SUFFIX_BLOCK.some((h) => host === h || host.endsWith(`.${h}`))) {
    throw new EgressDenied("EGRESS_METADATA_BLOCKED", `禁止访问元数据域名：${host}`);
  }
  if (!hostAllowed(host, allow)) {
    throw new EgressDenied("EGRESS_HOST_NOT_ALLOWED", `${host} 不在出站策略 ${policyName} 内`);
  }
  if (url.protocol !== "https:" && !(opts.allowLoopback && url.protocol === "http:")) {
    throw new EgressDenied("EGRESS_SCHEME_DENIED", `只允许 https 出站：${url.protocol}`);
  }

  if (net.isIP(host)) {
    if (isBlockedIp(host, opts.allowLoopback)) {
      throw new EgressDenied("EGRESS_IP_BLOCKED", `目标地址不可访问：${host}`);
    }
    return;
  }
  let addrs: Array<{ address: string }>;
  try {
    addrs = await dns.lookup(host, { all: true, verbatim: true });
  } catch {
    throw new EgressDenied("EGRESS_DNS_FAILED", `无法解析：${host}`);
  }
  if (!addrs.length) throw new EgressDenied("EGRESS_DNS_FAILED", `DNS 无结果：${host}`);
  for (const a of addrs) {
    if (isBlockedIp(a.address, opts.allowLoopback)) {
      throw new EgressDenied("EGRESS_IP_BLOCKED", `${host} 解析到不可访问地址 ${a.address}`);
    }
  }
}
