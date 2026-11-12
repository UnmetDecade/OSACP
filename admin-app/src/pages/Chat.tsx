import { t } from "../i18n";
import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { db } from "../store";
import { useHostScope } from "../host-context";
import { groupByHost, hostTreeIds } from "../host-tree";
import { HostFold } from "../components/HostFold";
import { errorMessage } from "../live/client";
import { CHARACTERS, characterState } from "../characters";
import { Character } from "../components/Character";
import { Badge, Empty, PageHead, Tag } from "../components/ui";
import { Icon } from "../components/Icon";
import { osLabel, sendChat, stopChatTask } from "../api";
import type { Instance, Role } from "../types";

type Msg = {
  id: string;
  from: "user" | "bot";
  text: string;
  meta?: string;
};

/** Chat history is kept locally long-term: it survives page switches, refreshes and browser restarts. */
const THREADS_KEY = "platform.chat.threads.v1";
const SELECTED_KEY = "platform.chat.selected.v1";
const MAX_MESSAGES = 200;

/** The same instance name can repeat across hosts, so records must use a host-prefixed key. */
function threadKeyOf(instance: Instance): string {
  return instance.key || `${instance.host_id}:${instance.id}`;
}

function loadThreads(): Record<string, Msg[]> {
  try {
    let raw = localStorage.getItem(THREADS_KEY);
    if (!raw) {
      // The previous version stored this in sessionStorage; migrate once on upgrade so existing records are not lost.
      raw = sessionStorage.getItem(THREADS_KEY);
      if (raw) {
        localStorage.setItem(THREADS_KEY, raw);
        sessionStorage.removeItem(THREADS_KEY);
      }
    }
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, Msg[]> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (!Array.isArray(value)) continue;
      out[key] = (value as Msg[]).filter(
        (m) => m && typeof m.text === "string" && (m.from === "user" || m.from === "bot"),
      );
    }
    return out;
  } catch {
    return {};
  }
}

function loadSelected(): string {
  try {
    return localStorage.getItem(SELECTED_KEY) ?? sessionStorage.getItem(SELECTED_KEY) ?? "";
  } catch {
    return "";
  }
}

const PRESETS: Record<Role, string[]> = {
  builder: [t("现在在忙什么？"), t("磁盘还剩多少？"), t("怎么 SSH 进去？"), t("帮我看看构建失败原因")],
  scheduler: [t("队列现在怎么样？"), t("为什么这个任务在排队？"), t("派发规则是什么？"), t("哪台构建机最闲？")],
};

export function ChatPage() {
  const [params] = useSearchParams();
  const { host } = useHostScope();
  // Like the builder / scheduler pages, scope to the host subtree: folded hosts must be able to chat too.
  const scopedHostIds = hostTreeIds(host?.id);
  const builders = db.instances.filter(
    (i) => i.role === "builder" && (!host || scopedHostIds.has(i.host_id)),
  );
  // A host can have multiple schedulers (root + nodes); the chat list must show them all.
  const schedulers = db.instances.filter(
    (i) => i.role === "scheduler" && (!host || scopedHostIds.has(i.host_id)),
  );
  const roster = [...schedulers, ...builders];
  const initial = (() => {
    const match =
      builders.find((b) => b.state === "ONLINE") ?? builders[0] ?? schedulers[0];
    return match ? threadKeyOf(match) : "";
  })();
  const [selected, setSelected] = useState(() => {
    const param = params.get("instance");
    if (param) {
      // New links carry a key (host:instance name); old links have only the instance name and still resolve.
      const match = roster.find((i) => threadKeyOf(i) === param) ??
        roster.find((i) => i.id === param);
      if (match) return threadKeyOf(match);
      return param;
    }
    // On returning to the chat page, resume the previous robot instead of jumping back to the first one.
    const saved = loadSelected();
    const match = roster.find((i) => threadKeyOf(i) === saved);
    return match ? threadKeyOf(match) : initial;
  });
  const [threads, setThreads] = useState<Record<string, Msg[]>>(loadThreads);
  const [input, setInput] = useState("");
  const [typing, setTyping] = useState(false);
  const [error, setError] = useState("");
  const logRef = useRef<HTMLDivElement>(null);
  // Stop: abort ends polling immediately, then cancel the scheduled task once task_id arrives.
  const abortRef = useRef<AbortController | null>(null);
  const taskIdRef = useRef("");
  const stopRequested = useRef(false);
  // Chinese IME: Enter confirms a candidate, it does not send. Ignore Enter during composition and for
  // a short time after it ends (Safari fires compositionend before keydown).
  const composing = useRef(false);
  const composedAt = useRef(0);

  const instance = roster.find((i) => threadKeyOf(i) === selected);
  const threadKey = instance ? threadKeyOf(instance) : "";
  const messages = threadKey ? threads[threadKey] ?? [] : [];

  useEffect(() => {
    // Do not clear the URL/last selection when the instance list is empty on first paint.
    if (!roster.length) return;
    if (!selected || !roster.some((i) => threadKeyOf(i) === selected)) {
      setSelected(threadKeyOf(roster[0]));
    }
  }, [selected, roster]);

  useEffect(() => {
    if (!instance) return;
    const key = threadKeyOf(instance);
    setThreads((prev) => {
      if (prev[key]) return prev;
      return { ...prev, [key]: [greeting(instance)] };
    });
  }, [instance]);

  // Chat history and the current selection are both written to localStorage: switching pages and coming back,
  // or even refreshing the page, keeps them; only closing the tab clears them.
  useEffect(() => {
    try {
      const trimmed: Record<string, Msg[]> = {};
      for (const [key, list] of Object.entries(threads)) {
        if (list.length) trimmed[key] = list.slice(-MAX_MESSAGES);
      }
      localStorage.setItem(THREADS_KEY, JSON.stringify(trimmed));
    } catch {
      // Storage unavailable or full: keep records in memory only; chat is unaffected.
    }
  }, [threads]);

  useEffect(() => {
    if (!instance) return;
    try {
      localStorage.setItem(SELECTED_KEY, threadKeyOf(instance));
    } catch {
      // ignore
    }
  }, [instance]);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, typing]);

  async function send(text: string) {
    const message = text.trim();
    if (!message || !instance || typing) return;
    setInput("");
    setError("");
    const userMsg: Msg = { id: `u_${Date.now()}`, from: "user", text: message };
    const key = threadKeyOf(instance);
    const next = [...(threads[key] ?? [greeting(instance)]), userMsg];
    setThreads((prev) => ({ ...prev, [key]: next }));
    setTyping(true);
    const controller = new AbortController();
    abortRef.current = controller;
    taskIdRef.current = "";
    stopRequested.current = false;
    const target = instance;
    const targetKey = key;
    try {
      const history = next.slice(-12).map((m) => ({
        role: (m.from === "user" ? "user" : "assistant") as "user" | "assistant",
        text: m.text,
      }));
      const out = await sendChat(target.id, target.role, message, history, {
        signal: controller.signal,
        schedulerDeploymentId: target.scheduler_deployment_id,
        onTaskCreated: (taskId) => {
          taskIdRef.current = taskId;
          // Stop was pressed before task creation finished: cancel immediately once the id arrives.
          if (stopRequested.current)
            void stopChatTask(taskId, target.scheduler_deployment_id).catch(() => {});
        },
      });
      const bot: Msg = {
        id: `b_${Date.now()}`,
        from: "bot",
        text: out.reply,
        meta: `${out.mode ?? "deterministic"} · ${out.latency_ms}ms`,
      };
      setThreads((prev) => ({ ...prev, [targetKey]: [...(prev[targetKey] ?? next), bot] }));
    } catch (e) {
      if ((e as Error)?.name === "AbortError") {
        const stopped: Msg = { id: `s_${Date.now()}`, from: "bot", text: t("已停止。"), meta: "stopped" };
        setThreads((prev) => ({ ...prev, [targetKey]: [...(prev[targetKey] ?? next), stopped] }));
      } else {
        setError(errorMessage(e));
      }
    } finally {
      abortRef.current = null;
      setTyping(false);
    }
  }

  function stop() {
    const controller = abortRef.current;
    if (!controller) return;
    stopRequested.current = true;
    if (taskIdRef.current) {
      void stopChatTask(taskIdRef.current, instance?.scheduler_deployment_id).catch((e) =>
        setError(errorMessage(e)),
      );
    }
    controller.abort();
  }

  if (roster.length === 0) {
    return (
      <div className="page page-chat">
        <PageHead title={t("对话")} />
        <div className="card"><Empty text={t("还没有构建机。创建一台后就能和机器人对话。")} /></div>
      </div>
    );
  }

  return (
    <div className="page page-chat">
      <PageHead
        title={t("对话")}
        meta={
          <>
            <span>{host?.name ?? t("未选择主机")}</span>
            <span className="sep" />
            <span>{t("{count} 个机器人", { count: roster.length })}</span>
          </>
        }
        actions={
          instance?.role === "builder" ? (
            <Link className="btn" to={`/terminal?instance=${encodeURIComponent(threadKeyOf(instance))}`}>
              <Icon name="terminal" size={14} />
              {t("打开终端")}
            </Link>
          ) : undefined
        }
      />

      <div className="chat-layout">
        <aside className="roster">
          {/* Like the terminal, split into schedulers / builders, then group by host name within each. */}
          {(["scheduler", "builder"] as const).map((role) => {
            const items = roster.filter((i) => i.role === role);
            if (!items.length) return null;
            const groups = groupByHost(items, host?.id);
            return (
              <div key={role} className="roster-group">
                <div className="roster-title">{role === "scheduler" ? t("调度机") : t("构建机")}</div>
                {groups.length > 1
                  ? groups.map((g) => (
                      <HostFold
                        key={g.hostId}
                        name={g.name}
                        label={t("{count} 个", { count: g.items.length })}
                        foldKey={`chat:${role}:${g.hostId}`}
                        defaultOpen={g.current}
                        forceOpen={g.items.some((i) => threadKeyOf(i) === selected)}
                      >
                        {g.items.map((item) => (
                          <RosterItem
                            key={threadKeyOf(item)}
                            instance={item}
                            active={threadKeyOf(item) === selected}
                            onSelect={() => { setSelected(threadKeyOf(item)); setError(""); }}
                          />
                        ))}
                      </HostFold>
                    ))
                  : groups[0]?.items.map((item) => (
                      <RosterItem
                        key={threadKeyOf(item)}
                        instance={item}
                        active={threadKeyOf(item) === selected}
                        onSelect={() => { setSelected(threadKeyOf(item)); setError(""); }}
                      />
                    ))}
              </div>
            );
          })}
        </aside>

        <section className="chat-panel">
          {instance ? (
            <>
              <div className="chat-head">
                <Character role={instance.role} state={chatState(instance)} size={34} flat />
                <div className="chat-head-info">
                  <div className="chat-head-name">
                    {t(CHARACTERS[instance.role].name)}
                    <Tag>{instance.name}</Tag>
                    <Badge value={instance.state} />
                  </div>
                  <div className="chat-head-meta">
                    {instance.role === "builder" ? osLabel(instance.os) : t("调度 Agent")}
                  </div>
                </div>
              </div>

              <div className="chat-log" ref={logRef}>
                {messages.map((m) => (
                  <div key={m.id} className={`msg ${m.from === "user" ? "msg-user" : "msg-role"}`}>
                    {m.from === "bot" && <Character role={instance.role} state={chatState(instance)} size={28} flat />}
                    <div className="msg-bubble">
                      <div className="msg-text">{m.text}</div>
                      {m.meta && <div className="msg-meta">{m.meta}</div>}
                    </div>
                  </div>
                ))}
                {messages.length <= 1 && (
                  <div className="preset-row" style={{ marginTop: 8 }}>
                    {PRESETS[instance.role].map((p) => (
                      <button key={p} className="preset" onClick={() => send(p)}>{p}</button>
                    ))}
                  </div>
                )}
                {typing && (
                  <div className="msg msg-role">
                    <Character role={instance.role} state="working" size={28} flat />
                    <div className="msg-bubble">
                      <div className="msg-text"><span className="typing"><span /><span /><span /></span></div>
                    </div>
                  </div>
                )}
              </div>

              {error && <div className="chat-footnote text-bad">{error}</div>}
              <div className="chat-composer">
                <textarea
                  rows={1}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onCompositionStart={() => { composing.current = true; }}
                  onCompositionEnd={() => { composing.current = false; composedAt.current = Date.now(); }}
                  onKeyDown={(e) => {
                    if (e.key !== "Enter" || e.shiftKey) return;
                    const confirming = e.nativeEvent.isComposing || composing.current || Date.now() - composedAt.current < 100;
                    if (confirming) return;
                    e.preventDefault();
                    void send(input);
                  }}
                  placeholder={t("给{name}发消息", { name: t(CHARACTERS[instance.role].name) })}
                  disabled={typing}
                />
                {typing ? (
                  <button className="send-btn stop-btn" onClick={stop} aria-label={t("停止")}>
                    <Icon name="stop" size={14} />
                  </button>
                ) : (
                  <button className="send-btn" onClick={() => send(input)} disabled={!input.trim()} aria-label={t("发送")}>
                    <Icon name="send" size={16} />
                  </button>
                )}
              </div>
            </>
          ) : (
            <Empty text={t("选择左边的机器人开始对话。")} />
          )}
        </section>
      </div>
    </div>
  );
}

function RosterItem({
  instance,
  active,
  onSelect,
}: {
  instance: Instance;
  active: boolean;
  onSelect: () => void;
}) {
  const running = db.tasks.find((t) => t.instance_id === instance.id && t.state === "RUNNING");
  return (
    <button className={`roster-item${active ? " active" : ""}`} onClick={onSelect}>
      <Character role={instance.role} state={characterState(instance, running)} size={34} flat />
      <span className="roster-body">
        <b>{t(CHARACTERS[instance.role].name)} · {instance.role === "builder" ? t("构建") : t("调度")}</b>
        <small>{instance.name}</small>
      </span>
      {instance.state === "ONLINE" ? <span className="dot dot-ok" /> : <span className={`dot ${instance.state === "SUSPECT" ? "dot-warn" : "dot-bad"}`} />}
    </button>
  );
}

function chatState(instance: Instance) {
  const running = db.tasks.find((t) => t.instance_id === instance.id && t.state === "RUNNING");
  const state = characterState(instance, running);
  if (state === "offline") return "offline" as const;
  if (running) return "working" as const;
  return state;
}

function greeting(instance: Instance): Msg {
  const c = CHARACTERS[instance.role];
  const text =
    instance.role === "builder"
      ? t("我是{name}，{instance} 的构建机器人。 {os}，root Shell 完整权限。要问进度、看磁盘，还是让我执行点什么？", { name: t(c.name), instance: instance.name, os: osLabel(instance.os) })
      : t("我是{name}，调度机器人。派发由确定性规则完成，我身上的 Agent 负责解释队列、租约和「为什么这条在等」。", { name: t(c.name) });
  return { id: `g_${instance.id}`, from: "bot", text };
}
