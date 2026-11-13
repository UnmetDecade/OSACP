/**
 * Generate product screenshots and animations for the README.
 *
 *   node scripts/capture-readme.mjs --lang en
 *   node scripts/capture-readme.mjs --lang zh
 *   node scripts/capture-readme.mjs --arch both
 *
 * Output goes to the repo's docs/assets/:
 *   dashboard-<lang>.png   overview (studio)
 *   studio-<lang>.gif      studio wiring/robot animation
 *   hosts-<lang>.png       hosts
 *   scheduler-<lang>.png   scheduler
 *   tasks-<lang>.png       tasks
 *   architecture-<lang>.png  full-page screenshot of the architecture HTML
 *
 * Before capturing, internal IPs and personal hostnames are replaced with sample values so screenshots do not leak environment details.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9447;
const BASE = process.env.CAPTURE_BASE ?? "http://127.0.0.1:5173";
const WIDTH = 1600;
const HEIGHT = 1000;
const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "../..");
const OUT = path.join(ROOT, "docs/assets");
const FRAMES = path.join(OUT, ".studio-frames");
const args = process.argv.slice(2);
const LANG = (args.find((a) => a.startsWith("--lang="))?.split("=")[1] ??
  (args.includes("--lang") ? args[args.indexOf("--lang") + 1] : "")) || "en";
const ARCH = args.includes("--arch");
const ALL = args.includes("--all");
const DARK = args.includes("--dark");
const HERO_ONLY = args.includes("--hero-only");
const GIF_ONLY = args.includes("--gif-only");
const THEME = DARK ? "dark" : "light";
const SUFFIX = `${LANG}${DARK ? "-dark" : ""}`;

fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--no-first-run",
    "--no-default-browser-check",
    `--remote-debugging-port=${PORT}`,
    "--remote-allow-origins=*",
    `--user-data-dir=${path.join(OUT, ".chrome-profile")}`,
    `--window-size=${WIDTH},${HEIGHT}`,
    "about:blank",
  ],
  { stdio: "ignore" },
);

let ws;
let seq = 0;
const pending = new Map();

function send(method, params = {}) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const out = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (out?.exceptionDetails) throw new Error(out.exceptionDetails.text);
  return out?.result?.value;
}

async function waitFor(fn, timeout, label) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await fn().catch(() => false)) return true;
    await sleep(250);
  }
  throw new Error(`Timed out waiting for: ${label}`);
}

/** Text replacement: internal IPs and personal hostnames stay out of public screenshots. */
const SCRUB = `(() => {
  const ips = /\\b(?:\\d{1,3}\\.){3}\\d{1,3}\\b/g;
  const names = [["thinkpad", "workstation-a"], ["thinkcentre", "workstation-b"], ["chromebox", "workstation-c"], ["docker-host", "workstation-a"]];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const n of nodes) {
    let v = n.nodeValue;
    if (!v) continue;
    v = v.replace(ips, "192.0.2.10");
    for (const [a, b] of names) v = v.split(a).join(b);
    if (v !== n.nodeValue) n.nodeValue = v;
  }
})()`;

async function screenshot(name) {
  const data = await send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(OUT, name), Buffer.from(data.data, "base64"));
  console.log(`✓ ${name}`);
}

async function openPage(url) {
  await send("Page.navigate", { url });
  await sleep(1200);
  await send("Emulation.setDeviceMetricsOverride", {
    width: WIDTH, height: HEIGHT, deviceScaleFactor: 2, mobile: false,
  });
  await sleep(400);
  await evaluate(`localStorage.setItem("app-theme", ${JSON.stringify(THEME)}); localStorage.setItem("app-lang", ${JSON.stringify(LANG)});`);
  await send("Page.reload");
  await sleep(3500);
  await evaluate(SCRUB);
}

function ffmpeg(args) {
  return new Promise((resolve, reject) => {
    const p = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(err.slice(-2000)))));
  });
}

async function makeStudioGif() {
  fs.rmSync(FRAMES, { recursive: true, force: true });
  fs.mkdirSync(FRAMES, { recursive: true });
  await send("Page.navigate", { url: `${BASE}/` });
  await sleep(3000);
  await evaluate(SCRUB);
  await evaluate(`window.scrollTo(0, 0)`);
  const rect = await evaluate(`(() => {
    const el = document.querySelector(".scene");
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.max(0, r.left), y: Math.max(0, r.top), width: r.width, height: r.height };
  })()`);
  if (!rect) throw new Error("Could not find .scene");
  // Cards are absolutely positioned and slightly overflow .scene; capture an extra margin so the hostname at the bottom is not clipped.
  const clip = {
    x: Math.max(0, Math.round(rect.x - 16)),
    y: Math.max(0, Math.round(rect.y)),
    width: Math.round(rect.width + 32),
    height: Math.min(HEIGHT - Math.max(0, Math.round(rect.y - 16)), Math.round(rect.height + 160)),
    scale: 1,
  };
  const N = 18;
  for (let i = 0; i < N; i++) {
    const data = await send("Page.captureScreenshot", {
      format: "png",
      clip,
      captureBeyondViewport: true,
    });
    fs.writeFileSync(path.join(FRAMES, `f${String(i).padStart(3, "0")}.png`), Buffer.from(data.data, "base64"));
    await sleep(160);
  }
  const gif = path.join(OUT, `studio-${SUFFIX}.gif`);
  await ffmpeg([
    "-y", "-framerate", "6", "-i", path.join(FRAMES, "f%03d.png"),
    "-vf", "scale=1100:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=160[p];[s1][p]paletteuse=dither=bayer",
    "-loop", "0", gif,
  ]);
  console.log(`✓ studio-${SUFFIX}.gif`);
}

async function captureArchitecture() {
  const target = LANG === "zh"
    ? path.join(ROOT, "docs/开源分布式AI-Agent计算与调度平台架构图.html")
    : path.join(ROOT, "docs/Open-Source-Agent-Compute-Platform-Architecture.html");
  await send("Page.navigate", { url: `file://${target}` });
  await sleep(1500);
  await send("Emulation.setDeviceMetricsOverride", {
    width: 1600, height: 1000, deviceScaleFactor: 1.5, mobile: false,
  });
  await sleep(500);
  const metrics = await send("Page.getLayoutMetrics");
  const size = metrics.cssContentSize ?? metrics.contentSize;
  const height = Math.ceil(size.height);
  const data = await send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: true,
    clip: { x: 0, y: 0, width: 1600, height, scale: 1.5 },
  });
  const name = `architecture-${LANG}.png`;
  fs.writeFileSync(path.join(OUT, name), Buffer.from(data.data, "base64"));
  console.log(`✓ ${name} (${height}px tall)`);
}

try {
  await waitFor(async () => (await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok, 10_000, "Chrome CDP");
  const target = await (
    await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(`${BASE}/`)}`, { method: "PUT" })
  ).json();
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(String(ev.data));
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    }
  });
  await send("Page.enable");
  await send("Runtime.enable");

  if (ARCH) {
    await captureArchitecture();
  } else if (GIF_ONLY) {
    await openPage(`${BASE}/`);
    await waitFor(async () => evaluate(`Boolean(document.querySelector(".scene-scheduler"))`), 12_000, "studio data");
    await evaluate(SCRUB);
    await makeStudioGif();
  } else {
    await openPage(`${BASE}/`);
    await waitFor(async () => evaluate(`Boolean(document.querySelector(".scene-scheduler"))`), 12_000, "studio data");
    await evaluate(SCRUB);
    await screenshot(`dashboard-${SUFFIX}.png`);
    if (!HERO_ONLY) await makeStudioGif();

    const routes = [
      ["hosts", "/hosts"],
      ["tasks", "/tasks"],
    ];
    for (const [name, route] of HERO_ONLY ? [] : routes) {
      await openPage(`${BASE}${route}`);
      await sleep(1200);
      await evaluate(SCRUB);
      await screenshot(`${name}-${SUFFIX}.png`);
    }
    if (ALL) {
      for (const [name, route] of [["builders", "/builders"], ["chat", "/chat"], ["terminal", "/terminal"], ["logs", "/logs"]]) {
        await openPage(`${BASE}${route}`);
        await sleep(1200);
        await evaluate(SCRUB);
        await screenshot(`${name}-${SUFFIX}.png`);
      }
    }
  }
} finally {
  try { ws?.close(); } catch { /* ignore */ }
  chrome.kill("SIGTERM");
  await sleep(800);
  for (const dir of [path.join(OUT, ".chrome-profile"), FRAMES]) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  }
}
