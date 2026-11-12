/**
 * 用本机 Chrome + CDP 截取“实时模式”页面。
 *
 * 令牌从进程环境 ADMIN_TOKEN 读取（默认从 macOS 剪贴板取），只写进当前标签页的
 * sessionStorage，不落盘、不打印。输出只包含截图文件名与页面标题。
 *
 * 用法：
 *   ADMIN_TOKEN=$(pbpaste) node scripts/capture-live.mjs
 */
import { spawn, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9444;
const BASE = "http://127.0.0.1:5178";
const OUT = path.resolve(".screenshots");
const ROUTES = [
  ["office-live", "/"],
  ["agents-live", "/agents"],
  ["chat-live", "/chat?instance=worker-a"],
  ["terminal-live", "/terminal?instance=worker-a"],
  ["console-live", "/dev-console"],
  ["workflow-live", "/workflow"],
  ["overview-live", "/overview"],
];

const token = (process.env.ADMIN_TOKEN ?? "").trim() || execSync("pbpaste", { encoding: "utf8" }).trim();
if (!token) {
  console.error("没有管理员令牌：设置 ADMIN_TOKEN 或复制到剪贴板");
  process.exit(1);
}

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
    "--window-size=1440,1200",
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
  await send("Page.navigate", { url: `${BASE}/` });
  await sleep(2500);

  const connection = {
    pcsUrl: "/pcs",
    schedulerUrl: "/scheduler",
    adminToken: token,
    operator: "ui-capture",
  };
  await send("Runtime.evaluate", {
    expression: `sessionStorage.setItem("platform.live.connection", ${JSON.stringify(JSON.stringify(connection))});`,
  });

  for (const [name, route] of ROUTES) {
    await send("Page.navigate", { url: `${BASE}${route}` });
    await sleep(6000); // 首次同步 + 15s 轮询之间留出渲染时间
    const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(shot.data, "base64"));
    const title = await send("Runtime.evaluate", { expression: "document.title", returnByValue: true });
    console.log(`${name}.png  ${title?.result?.value ?? ""}`);

    // 实时交互：打开 Agent 选择、对话点第一个预设、终端执行 help。
    if (name === "office-live") {
      await send("Runtime.evaluate", {
        expression: `(() => {
          const btn = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === '换 Agent');
          if (!btn) return false;
          btn.click();
          return true;
        })()`,
        returnByValue: true,
      });
      await sleep(1200);
      const modalShot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
      fs.writeFileSync(path.join(OUT, "office-live-agent.png"), Buffer.from(modalShot.data, "base64"));
      const names = await send("Runtime.evaluate", {
        expression: "[...document.querySelectorAll('.modal .select-card b')].map((b) => b.textContent).join(' | ')",
        returnByValue: true,
      });
      console.log("agent choices:", String(names?.result?.value ?? ""));
    }
    if (name === "chat-live") {
      await send("Runtime.evaluate", { expression: "document.querySelector('.preset')?.click()" });
      await sleep(5000);
      const after = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
      fs.writeFileSync(path.join(OUT, "chat-live-replied.png"), Buffer.from(after.data, "base64"));
      const text = await send("Runtime.evaluate", {
        expression: "document.querySelector('.chat-log')?.innerText.slice(-500) ?? ''",
        returnByValue: true,
      });
      console.log("chat reply:", String(text?.result?.value ?? "").replace(/\s+/g, " ").slice(0, 240));
    }
    if (name === "terminal-live") {
      await send("Runtime.evaluate", {
        expression: `(() => {
          const el = document.querySelector('.crt-input');
          if (!el) return false;
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
          setter.call(el, 'help');
          el.dispatchEvent(new Event('input', { bubbles: true }));
          document.querySelector('.crt-input-row button')?.click();
          return true;
        })()`,
        returnByValue: true,
      });
      await sleep(5000);
      const after = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
      fs.writeFileSync(path.join(OUT, "terminal-live-help.png"), Buffer.from(after.data, "base64"));
      const text = await send("Runtime.evaluate", {
        expression: "document.querySelector('.crt-screen')?.innerText.slice(-600) ?? ''",
        returnByValue: true,
      });
      console.log("terminal:", String(text?.result?.value ?? "").replace(/\s+/g, " ").slice(0, 240));
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
