import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

/**
 * Bundle the two host-runtime entry points into a single self-contained .mjs.
 *
 * Remote hosts do not want to install tsx or the source tree; they only need Node 22 + Docker. During
 * bootstrapping the PCS writes the bundle over together with the config, and a restart needs only these two files.
 * Results are cached per source directory and rebuilt automatically when the source changes.
 */
export type RuntimeBundle = {
  dir: string;
  runtime: string;
  watchdog: string;
};

const here = path.dirname(fileURLToPath(import.meta.url));

export function runtimeSourceDir(): string {
  return process.env.PCS_RUNTIME_SOURCE_DIR ?? path.resolve(here, "..", "..", "host-runtime");
}

export async function ensureRuntimeBundle(): Promise<RuntimeBundle> {
  const source = runtimeSourceDir();
  const runtimeEntry = path.join(source, "src", "runtime.ts");
  const watchdogEntry = path.join(source, "src", "watchdog.ts");
  if (!fs.existsSync(runtimeEntry) || !fs.existsSync(watchdogEntry)) {
    throw new Error(`host-runtime source not found: ${source} (set PCS_RUNTIME_SOURCE_DIR to override)`);
  }

  const dir = process.env.PCS_RUNTIME_BUNDLE_DIR
    ? path.resolve(process.env.PCS_RUNTIME_BUNDLE_DIR)
    : path.join(os.homedir(), ".cache", "pcs", "runtime-bundle");
  const runtime = path.join(dir, "runtime.mjs");
  const watchdog = path.join(dir, "watchdog.mjs");

  if (isFresh(runtime, source) && isFresh(watchdog, source)) {
    return { dir, runtime, watchdog };
  }

  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.tmp-${process.pid}-${Date.now()}`);
  fs.mkdirSync(tmp, { recursive: true, mode: 0o700 });
  try {
    await build({
      entryPoints: { runtime: runtimeEntry, watchdog: watchdogEntry },
      outdir: tmp,
      outExtension: { ".js": ".mjs" },
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node22",
      sourcemap: false,
      minify: false,
      logLevel: "silent",
    });
    fs.renameSync(path.join(tmp, "runtime.mjs"), runtime);
    fs.renameSync(path.join(tmp, "watchdog.mjs"), watchdog);
    return { dir, runtime, watchdog };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** Rebuild if either entry point, or any file under src, is newer than the bundle. */
function isFresh(bundle: string, source: string): boolean {
  if (!fs.existsSync(bundle)) return false;
  const stamp = fs.statSync(bundle).mtimeMs;
  const stack = [path.join(source, "src")];
  while (stack.length) {
    const dir = stack.pop()!;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (/\.(ts|json)$/.test(entry.name) && fs.statSync(full).mtimeMs > stamp) return false;
    }
  }
  return true;
}
