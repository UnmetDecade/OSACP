#!/usr/bin/env node
/**
 * PCS management-plane CLI (for development/operations). Every write operation carries an admin JWT;
 * the PCS only verifies the signature and checks scopes.
 *
 * Usage:
 *   npm run pcs -- admin-token --operator alice [--hours 8]
 *   npm run pcs -- host-add --name ubuntu22 [--labels pool:dev,zone:a]
 *   npm run pcs -- host-list
 *   npm run pcs -- host-revoke --host hst_xxx
 *   npm run pcs -- deploy --host hst_xxx --role builder \
 *        --image registry/repo@sha256:... --name builder-a \
 *        --cpu 0.5 --memory-mib 256 [--env A=B ...] [--volume workspace:/opt/platform/workspace] \
 *        [--command sh,-c,sleep 3600] [--network default]
 *   npm run pcs -- deployments [--host hst_xxx]
 *   npm run pcs -- action --deployment dep_xxx --action stop|start|restart|remove
 *   npm run pcs -- agent-profile-add --role builder --name w --version 1.0.0 \
 *        --image registry/repo@sha256:... --allowed-tools demo.echo --task-types task.agent.probe
 *   npm run pcs -- api-profile-add --name mock --kind tool --base-url https://... \
 *        --secret-ref secret://apis/mock --quota '{"rpm":5}'
 *   npm run pcs -- bind-agent --instance builder-a --host hst_xxx --agent agp_xxx --role builder
 *   npm run pcs -- unbind-agent --instance builder-a --host hst_xxx
 *   npm run pcs -- bind-api --instance builder-a --api api_xxx
 *   npm run pcs -- resolve --instance builder-a
 *   npm run pcs -- audit --limit 50
 */
import { loadConfig } from "./config.js";
import { PcsService } from "./service.js";

const PCS_URL = process.env.PCS_URL ?? "http://127.0.0.1:7901";

function parseArgs(argv: string[]): {
  command: string;
  opts: Record<string, string[]>;
} {
  const [command, ...rest] = argv;
  const opts: Record<string, string[]> = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (!arg.startsWith("--")) {
      throw new Error(`unable to parse argument: ${arg}`);
    }
    const key = arg.slice(2);
    const value = rest[i + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`--${key} is missing a value`);
    }
    i++;
    (opts[key] ??= []).push(value);
  }
  return { command, opts };
}

function one(opts: Record<string, string[]>, key: string): string | undefined {
  return opts[key]?.[0];
}

function need(opts: Record<string, string[]>, key: string): string {
  const v = one(opts, key);
  if (!v) throw new Error(`missing --${key}`);
  return v;
}

function parsePairs(values: string[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const item of values ?? []) {
    const idx = item.indexOf("=");
    if (idx <= 0) throw new Error(`expected KEY=VALUE: ${item}`);
    out[item.slice(0, idx)] = item.slice(idx + 1);
  }
  return out;
}

function parseVolumes(values: string[] | undefined): Array<{ name: string; mount: string }> {
  return (values ?? []).map((item) => {
    const idx = item.indexOf(":");
    if (idx <= 0) throw new Error(`expected name:mount: ${item}`);
    return { name: item.slice(0, idx), mount: item.slice(idx + 1) };
  });
}

async function call(
  method: string,
  path: string,
  body?: unknown,
): Promise<Record<string, unknown>> {
  const token = process.env.PCS_ADMIN_TOKEN;
  if (!token) throw new Error("PCS_ADMIN_TOKEN is required (generate one with admin-token and export it)");
  const res = await fetch(`${PCS_URL}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const err = data.error ?? {};
    throw new Error(`${res.status} ${err.code ?? "HTTP_ERROR"}: ${err.message ?? text}`);
  }
  return data;
}

function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

async function main(): Promise<void> {
  const { command, opts } = parseArgs(process.argv.slice(2));

  if (command === "admin-token") {
    const cfg = loadConfig();
    const svc = new PcsService(cfg);
    const token = svc.issueAdminToken(need(opts, "operator"), Number(one(opts, "hours") ?? 8));
    const out = one(opts, "out");
    if (out) {
      const fs = await import("node:fs");
      const path = await import("node:path");
      fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
      fs.writeFileSync(out, token + "\n", { mode: 0o600 });
      console.error(`Wrote ${out}`);
    } else {
      console.log(token);
    }
    return;
  }

  if (command === "host-add") {
    const labels: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsePairs(opts.labels))) labels[k] = v;
    const out = await call("POST", "/api/v1/platform/hosts", {
      name: need(opts, "name"),
      labels,
    });
    print(out);
    return;
  }

  if (command === "host-list") {
    print(await call("GET", "/api/v1/platform/hosts"));
    return;
  }

  if (command === "host-revoke") {
    print(await call("POST", `/api/v1/platform/hosts/${encodeURIComponent(need(opts, "host"))}/revoke`));
    return;
  }

  if (command === "deploy") {
    const memoryMib = Number(one(opts, "memory-mib") ?? 1024);
    if (!Number.isFinite(memoryMib) || memoryMib <= 0) throw new Error("--memory-mib must be a positive number");
    const commandParts = one(opts, "command")?.split(",").filter((s) => s.length > 0);
    const body = {
      host_id: need(opts, "host"),
      role_id: need(opts, "role"),
      image: need(opts, "image"),
      display_name: one(opts, "name"),
      instance_id: one(opts, "instance"),
      resource_profile: {
        cpu_limit: Number(one(opts, "cpu") ?? 1),
        memory_limit_bytes: Math.round(memoryMib * 1024 ** 2),
        pids_limit: Number(one(opts, "pids") ?? 512),
        io_weight: Number(one(opts, "io-weight") ?? 500),
      },
      env: parsePairs(opts.env),
      volumes: parseVolumes(opts.volume),
      network_policy: one(opts, "network") ?? "default",
      command: commandParts,
      config_version: Number(one(opts, "config-version") ?? 1),
    };
    print(await call("POST", "/api/v1/platform/deployments", body));
    return;
  }

  if (command === "deployments") {
    const host = one(opts, "host");
    print(
      await call(
        "GET",
        `/api/v1/platform/deployments${host ? `?host_id=${encodeURIComponent(host)}` : ""}`,
      ),
    );
    return;
  }

  if (command === "agent-profile-add") {
    const profile = await call("POST", "/api/v1/platform/agent-profiles", {
      agent_profile_id: one(opts, "id"),
      role_id: need(opts, "role"),
      name: need(opts, "name"),
      version: need(opts, "version"),
      adapter: one(opts, "adapter") ?? "stdio-jsonrpc",
      artifact_image: need(opts, "image"),
      entrypoint: (one(opts, "entrypoint") ?? "").split(",").filter(Boolean),
      args: (one(opts, "args") ?? "").split(",").filter(Boolean),
      model_api_profile_id: one(opts, "model-api") ?? null,
      tool_api_profile_ids: (one(opts, "tool-apis") ?? "").split(",").filter(Boolean),
      limits: one(opts, "limits") ? JSON.parse(one(opts, "limits")!) : {},
      capabilities: (one(opts, "capabilities") ?? "").split(",").filter(Boolean),
      allowed_tools: (one(opts, "allowed-tools") ?? "").split(",").filter(Boolean),
      task_types: (one(opts, "task-types") ?? "").split(",").filter(Boolean),
    });
    print(profile);
    return;
  }

  if (command === "agent-profiles") {
    print(await call("GET", "/api/v1/platform/agent-profiles"));
    return;
  }

  if (command === "api-profile-add") {
    const profile = await call("POST", "/api/v1/platform/api-profiles", {
      api_profile_id: one(opts, "id"),
      name: need(opts, "name"),
      kind: need(opts, "kind"),
      base_url: need(opts, "base-url"),
      auth_type: one(opts, "auth") ?? "bearer",
      secret_ref: need(opts, "secret-ref"),
      scopes: (one(opts, "scopes") ?? "").split(",").filter(Boolean),
      quota: one(opts, "quota") ? JSON.parse(one(opts, "quota")!) : {},
      timeout_seconds: Number(one(opts, "timeout") ?? 60),
      egress: one(opts, "egress") ?? null,
      fallback: (one(opts, "fallback") ?? "").split(",").filter(Boolean),
    });
    print(profile);
    return;
  }

  if (command === "api-profiles") {
    print(await call("GET", "/api/v1/platform/api-profiles"));
    return;
  }

  if (command === "bind-agent") {
    print(
      await call(
        "POST",
        `/api/v1/platform/instances/${encodeURIComponent(need(opts, "instance"))}/bind-agent`,
        {
          host_id: need(opts, "host"),
          agent_profile_id: need(opts, "agent"),
          role_id: need(opts, "role"),
        },
      ),
    );
    return;
  }

  if (command === "unbind-agent") {
    print(
      await call(
        "DELETE",
        `/api/v1/platform/instances/${encodeURIComponent(need(opts, "instance"))}/bind-agent?host_id=${encodeURIComponent(need(opts, "host"))}`,
      ),
    );
    return;
  }

  if (command === "bind-api") {
    print(
      await call(
        "POST",
        `/api/v1/platform/instances/${encodeURIComponent(need(opts, "instance"))}/bind-api`,
        { host_id: need(opts, "host"), api_profile_id: need(opts, "api") },
      ),
    );
    return;
  }

  if (command === "unbind-api") {
    print(
      await call(
        "DELETE",
        `/api/v1/platform/instances/${encodeURIComponent(need(opts, "instance"))}/bind-api/${encodeURIComponent(need(opts, "api"))}?host_id=${encodeURIComponent(need(opts, "host"))}`,
      ),
    );
    return;
  }

  if (command === "resolve") {
    print(
      await call(
        "GET",
        `/api/v1/platform/instances/${encodeURIComponent(need(opts, "instance"))}/resolve?host_id=${encodeURIComponent(need(opts, "host"))}`,
      ),
    );
    return;
  }

  if (command === "audit") {
    print(await call("GET", `/api/v1/platform/audit-logs?limit=${Number(one(opts, "limit") ?? 100)}`));
    return;
  }

  if (command === "action") {
    const id = encodeURIComponent(need(opts, "deployment"));
    const action = need(opts, "action");
    if (!["start", "stop", "restart", "remove"].includes(action)) {
      throw new Error("--action must be one of start|stop|restart|remove");
    }
    print(await call("POST", `/api/v1/platform/deployments/${id}/${action}`));
    return;
  }

  console.error(
    "Usage: pcs.ts admin-token|host-add|host-list|host-revoke|deploy|deployments|action [--key value ...]",
  );
  process.exit(1);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
