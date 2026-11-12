/**
 * 用本机 Chrome 截图管理应用全部路由。
 *
 *   node scripts/capture-ui.mjs            # 全路由截图
 *   ADMIN_TOKEN=... node scripts/capture-ui.mjs            # 带令牌截图
 *
 * 令牌只写进当前标签页的 sessionStorage，不落盘、不打印。
 * 输出到 admin-app/.screenshots/。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9444;
const BASE = process.env.CAPTURE_BASE ?? "http://127.0.0.1:5173";
const OUT = path.resolve(".screenshots");
const LIVE = process.argv.includes("--live");
const DARK = process.argv.includes("--dark");
const MOBILE = process.argv.includes("--mobile");
const LANG = process.env.CAPTURE_LANG ?? "";
const HOST = process.env.CAPTURE_HOST ?? "";
const token = (process.env.ADMIN_TOKEN ?? "").trim();
const WIDTH = Number(process.env.CAPTURE_WIDTH ?? 1440);
const HEIGHT = Number(process.env.CAPTURE_HEIGHT ?? 1000);

if (LIVE && !token) {
  console.error("实时模式需要 ADMIN_TOKEN");
  process.exit(1);
}

const ALL_ROUTES = [
  ["dashboard", "/"],
  ["hosts", "/hosts"],
  ["builders", "/builders"],
  ["scheduler", "/scheduler"],
  ["tasks", "/tasks"],
  ["terminal", "/terminal"],
  ["chat", "/chat"],
  ["logs", "/logs"],
];
const ROUTES = MOBILE ? ALL_ROUTES.filter(([n]) => ["dashboard", "chat", "tasks", "terminal"].includes(n)) : ALL_ROUTES;
const SUFFIX = `${LIVE ? "-live" : ""}${DARK ? "-dark" : ""}${MOBILE ? "-mobile" : ""}${LANG ? `-${LANG}` : ""}`;

fs.mkdirSync(OUT, { recursive: true });
const profileDir = path.join(OUT, "chrome-profile");
fs.rmSync(profileDir, { recursive: true, force: true });

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
    `--user-data-dir=${profileDir}`,
    `--window-size=${WIDTH},${HEIGHT}`,
    "about:blank",
  ],
  { stdio: "ignore" },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeoutMs, label) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      /* retry */
    }
    await sleep(250);
  }
  throw new Error(`等待超时：${label}`);
}

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

async function shot(name) {
  const data = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(data.data, "base64"));
  console.log(`${name}.png`);
}

async function evalJs(expression) {
  const out = await send("Runtime.evaluate", { expression, returnByValue: true });
  return out?.result?.value;
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
  if (MOBILE) {
    await send("Emulation.setDeviceMetricsOverride", {
      width: 390, height: 844, deviceScaleFactor: 2, mobile: true,
    });
  } else {
    await send("Emulation.setDeviceMetricsOverride", {
      width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false,
    });
  }
  await send("Page.navigate", { url: `${BASE}/` });
  await sleep(2000);
  if (DARK) {
    await send("Runtime.evaluate", { expression: `localStorage.setItem("app-theme", "dark")` });
  }
  if (LANG) {
    await send("Runtime.evaluate", { expression: `localStorage.setItem("app-lang", ${JSON.stringify(LANG)})` });
  }

  if (LIVE) {
    const connection = {
      pcsUrl: "/pcs",
      schedulerUrl: "/scheduler",
      adminToken: token,
      operator: "ui-capture",
    };
    await send("Runtime.evaluate", {
      expression: `sessionStorage.setItem("platform.live.connection", ${JSON.stringify(JSON.stringify(connection))});`,
    });
  }
  if (HOST) {
    await send("Runtime.evaluate", {
      expression: `sessionStorage.setItem("current-host", ${JSON.stringify(HOST)});`,
    });
  }

  for (const [name, route] of ROUTES) {
    await send("Page.navigate", { url: `${BASE}${route}` });
    await sleep(LIVE ? 6000 : 1600);
    await shot(`${name}${SUFFIX}`);
  }

  // 实时模式下确认「创建任务」弹窗能列出可接任务的构建机。
  if (LIVE) {
    await send("Page.navigate", { url: `${BASE}/tasks?new=1` });
    await sleep(6000);
    await shot(`create-task${SUFFIX}`);

    // 主机删除弹窗：只打开，不点确认，避免真的删数据。
    await send("Page.navigate", { url: `${BASE}/hosts` });
    await sleep(3000);
    await evalJs(`(() => {
      const row = document.querySelector('.list-row');
      const btn = row && [...row.querySelectorAll('.list-actions button')].pop();
      if (btn) { btn.click(); return true; }
      return false;
    })()`);
    await sleep(800);
    await shot(`delete-host${SUFFIX}`);
    // 勾选「同时删除容器并清除数据」，确认按钮切换成彻底删除。
    await evalJs(`(() => {
      const rows = document.querySelectorAll('.check-row input');
      const last = rows[rows.length - 1];
      if (!last) return false;
      last.click();
      return true;
    })()`);
    await sleep(400);
    await shot(`delete-host-clear${SUFFIX}`);
  }

  // 详情页交互。
  if (!LIVE) {
    await send("Page.navigate", { url: `${BASE}/tasks` });
    await sleep(1200);
    const taskHref = await evalJs("document.querySelector('table tbody tr a')?.getAttribute('href') ?? ''");
    if (taskHref) {
      await send("Page.navigate", { url: `${BASE}${taskHref}` });
      await sleep(1200);
      await shot(`task-detail${SUFFIX}`);
    }

    await send("Page.navigate", { url: `${BASE}/builders` });
    await sleep(1200);
    const builderHref = await evalJs("document.querySelector('.instance-head a')?.getAttribute('href') ?? ''");
    if (builderHref) {
      await send("Page.navigate", { url: `${BASE}${builderHref}` });
      await sleep(1200);
      await shot(`builder-detail${SUFFIX}`);
    }

    await send("Page.navigate", { url: `${BASE}/chat` });
    await sleep(1200);
    await evalJs("document.querySelector('.preset')?.click()");
    await sleep(1600);
    await shot(`chat-reply${SUFFIX}`);

    await send("Page.navigate", { url: `${BASE}/terminal` });
    await sleep(1200);
    await evalJs(`(() => {
      const el = document.querySelector('.term-input');
      if (!el) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(el, 'help');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('.term-run')?.click();
      return true;
    })()`);
    await sleep(1200);
    await shot(`terminal-help${SUFFIX}`);

    // 切换主机后，左上方页面应跟着换到另一台主机的组件。
    await send("Page.navigate", { url: `${BASE}/` });
    await sleep(1200);
    await evalJs("document.querySelector('.host-switch')?.click()");
    await sleep(400);
    await shot(`host-menu${SUFFIX}`);
    const switched = await evalJs(`(() => {
      const items = [...document.querySelectorAll('.host-menu-item')];
      if (items.length < 2) return false;
      items[1].click();
      return true;
    })()`);
    if (switched) {
      await sleep(1000);
      await shot(`dashboard-switched${SUFFIX}`);
      await send("Page.navigate", { url: `${BASE}/builders` });
      await sleep(1000);
      await shot(`builders-switched${SUFFIX}`);
    }
  }
} finally {
  try {
    ws?.close();
  } catch {
    /* ignore */
  }
  chrome.kill("SIGTERM");
}
