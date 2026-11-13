import dns from "node:dns/promises";
import net from "node:net";

/** Cloud metadata and control-plane addresses: rejected no matter how the allowlist is written (§3.7). */
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
  /** Policy name -> allowed hosts (exact or *.suffix) */
  policies: Record<string, string[]>;
  /** Local development only: allow 127.0.0.1 / ::1 */
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

/** Whether an IP is a blocked egress address (metadata, loopback, private, link-local). */
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
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT / some cloud internal networks
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
 * Check whether the target URL is allowed.
 *
 * - The egress policy must exist explicitly (deny by default);
 * - the host must be in the policy allowlist;
 * - every address resolved by DNS must be permitted under the allowlist semantics (metadata/private networks always denied).
 */
export async function assertEgressAllowed(
  url: URL,
  policyName: string | null,
  opts: EgressPolicyOptions,
): Promise<void> {
  if (!policyName) {
    throw new EgressDenied("EGRESS_POLICY_REQUIRED", "API Profile did not declare an egress policy; denying by default");
  }
  const allow = opts.policies[policyName];
  if (!allow) {
    throw new EgressDenied("EGRESS_POLICY_UNKNOWN", `Unknown egress policy: ${policyName}`);
  }
  const host = normalizeHost(url.hostname);
  if (HOST_SUFFIX_BLOCK.some((h) => host === h || host.endsWith(`.${h}`))) {
    throw new EgressDenied("EGRESS_METADATA_BLOCKED", `Access to metadata host is forbidden: ${host}`);
  }
  if (!hostAllowed(host, allow)) {
    throw new EgressDenied("EGRESS_HOST_NOT_ALLOWED", `${host} is not in egress policy ${policyName}`);
  }
  if (url.protocol !== "https:" && !(opts.allowLoopback && url.protocol === "http:")) {
    throw new EgressDenied("EGRESS_SCHEME_DENIED", `Only https egress is allowed: ${url.protocol}`);
  }

  if (net.isIP(host)) {
    if (isBlockedIp(host, opts.allowLoopback)) {
      throw new EgressDenied("EGRESS_IP_BLOCKED", `Target address is not reachable: ${host}`);
    }
    return;
  }
  let addrs: Array<{ address: string }>;
  try {
    addrs = await dns.lookup(host, { all: true, verbatim: true });
  } catch {
    throw new EgressDenied("EGRESS_DNS_FAILED", `DNS resolution failed: ${host}`);
  }
  if (!addrs.length) throw new EgressDenied("EGRESS_DNS_FAILED", `DNS returned no results: ${host}`);
  for (const a of addrs) {
    if (isBlockedIp(a.address, opts.allowLoopback)) {
      throw new EgressDenied("EGRESS_IP_BLOCKED", `${host} resolves to a blocked address ${a.address}`);
    }
  }
}
