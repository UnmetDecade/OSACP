#!/usr/bin/env node
/**
 * 打部署载荷：调度机（服务 + SQL）与构建机（实例运行时）各一份。
 *
 * 产物在 deploy/scheduler/app/、deploy/builder/app/，由 PCS 在部署计划里当作
 * files 下发给容器，镜像保持官方 ubuntu；换代码只换这几个文件，不需要重建
 * 或传输镜像。
 *
 * 用法：node scripts/build-app-payload.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { build } = createRequire(path.join(repo, "pcs-issuer", "package.json"))("esbuild");
const schedulerOut = path.join(repo, "deploy", "scheduler", "app");
const builderOut = path.join(repo, "deploy", "builder", "app");

const runtimeEntry = path.join(repo, "host-runtime", "src", "main.ts");

/** esbuild 打一个自包含的 ESM bundle（node22）。 */
async function bundle(entryPoints, outdir) {
  fs.mkdirSync(outdir, { recursive: true });
  await build({
    entryPoints,
    outdir,
    outExtension: { ".js": ".mjs" },
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    sourcemap: false,
    minify: false,
    logLevel: "warning",
    // pg 是 CJS，内部用 require("events") 这类内置模块。ESM 产物默认没有 require，
    // 这里补一个 createRequire，让打进来的 CJS 依赖照常工作。
    banner: {
      js: 'import { createRequire as __platformCreateRequire } from "node:module"; const require = __platformCreateRequire(import.meta.url);',
    },
  });
}

// ---- 调度机：服务 + 迁移 + 容器内 Agent 运行时 + SQL + 入口 ----
fs.rmSync(schedulerOut, { recursive: true, force: true });
fs.mkdirSync(path.join(schedulerOut, "sql"), { recursive: true });
await bundle(
  {
    main: path.join(repo, "scheduler", "src", "main.ts"),
    migrate: path.join(repo, "scheduler", "src", "migrate.ts"),
    // 调度机容器里跑的 host-runtime：承担 task.chat.scheduler / task.console.scheduler。
    "agent-runtime": runtimeEntry,
  },
  schedulerOut,
);
for (const file of fs.readdirSync(path.join(repo, "scheduler", "sql"))) {
  if (file.endsWith(".sql")) {
    fs.copyFileSync(path.join(repo, "scheduler", "sql", file), path.join(schedulerOut, "sql", file));
  }
}
fs.copyFileSync(path.join(repo, "agents", "cli-agent.mjs"), path.join(schedulerOut, "cli-agent.mjs"));
// 调度机 Agent 的构建机工具（MCP stdio）；配置由容器入口按实际端口生成。
fs.copyFileSync(path.join(repo, "scheduler", "tools.mjs"), path.join(schedulerOut, "tools.mjs"));
fs.copyFileSync(
  path.join(repo, "deploy", "scheduler", "app-entrypoint.sh"),
  path.join(schedulerOut, "entrypoint.sh"),
);
fs.copyFileSync(
  path.join(repo, "deploy", "scheduler", "sshd_config"),
  path.join(schedulerOut, "sshd_config"),
);

// ---- 构建机：实例运行时 + Agent 适配器 + sshd/Codex 配置 ----
fs.rmSync(builderOut, { recursive: true, force: true });
fs.mkdirSync(path.join(builderOut, "codex"), { recursive: true });
await bundle({ "agent-runtime": runtimeEntry }, builderOut);
fs.copyFileSync(path.join(repo, "agents", "cli-agent.mjs"), path.join(builderOut, "cli-agent.mjs"));
fs.copyFileSync(
  path.join(repo, "deploy", "builder", "app-entrypoint.sh"),
  path.join(builderOut, "entrypoint.sh"),
);
fs.copyFileSync(
  path.join(repo, "deploy", "builder", "sshd_config"),
  path.join(builderOut, "sshd_config"),
);
fs.copyFileSync(
  path.join(repo, "deploy", "codex", "config.toml"),
  path.join(builderOut, "codex", "config.toml"),
);

let total = 0;
for (const [label, dir] of [
  ["调度机", schedulerOut],
  ["构建机", builderOut],
]) {
  let size = 0;
  for (const file of listFiles(dir)) size += fs.statSync(file).size;
  total += size;
  console.log(`${label}载荷 ${(size / 1024).toFixed(0)}K → ${path.relative(repo, dir)}/`);
}
console.log(`合计 ${(total / 1024).toFixed(0)}K`);

function listFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? listFiles(full) : [full];
  });
}
