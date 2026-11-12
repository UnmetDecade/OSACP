import { t } from "../i18n";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { db } from "../store";
import { useHostScope } from "../host-context";
import { groupByHost, hostTreeIds } from "../host-tree";
import { Badge, Empty, PageHead } from "../components/ui";
import { HostFold } from "../components/HostFold";
import { Icon } from "../components/Icon";
import type { Instance } from "../types";
import { osLabel, sshCommand } from "../api";
import { getTerminalSession, type TermSession, type TermStatus } from "../terminal/sessions";

type Status = TermStatus | "idle";

const STATUS_LABEL: Record<Status, string> = {
  idle: t("未连接"),
  connecting: t("连接中"),
  open: t("已连接"),
  closed: t("已断开"),
  error: t("连接失败"),
};

/**
 * The terminal is a root shell used directly by admins: WebSocket straight to PCS, which runs
 * `docker exec -it` into the instance container on the host (remote hosts use ssh -tt). No command review and no
 * task queue; keystrokes reach the container byte by byte.
 *
 * Sessions are held by terminal/sessions.ts; leaving this page only hides the terminal, and the shell and
 * scrollback remain, so returning reattaches to the same session.
 */
export function TerminalPage() {
  const [params, setParams] = useSearchParams();
  const { host } = useHostScope();
  // Like the builder / scheduler pages, scope to the host subtree: folded hosts must be reachable in the terminal too.
  const scopedHostIds = hostTreeIds(host?.id);
  // Schedulers and builders are both containers and both allow a direct root shell; schedulers come first as the host entry point.
  const instances = db.instances
    .filter(
      (i) =>
        (i.role === "builder" || i.role === "scheduler") &&
        (!host || scopedHostIds.has(i.host_id)),
    )
    .sort(
      (a, b) =>
        (a.role === b.role ? 0 : a.role === "scheduler" ? -1 : 1) ||
        a.name.localeCompare(b.name),
    );
  // Instance names are unique only within a host: select by a host-prefixed key so same-named instances from folded hosts do not collide.
  const keyOf = (i: { key?: string; host_id: string; id: string }) =>
    i.key || `${i.host_id}:${i.id}`;
  const initial = (() => {
    const param = params.get("instance") ?? "";
    const match = instances.find((i) => keyOf(i) === param) ??
      instances.find((i) => i.id === param);
    if (match) return keyOf(match);
    const first = instances.find((b) => b.state === "ONLINE") ?? instances[0];
    return first ? keyOf(first) : "";
  })();
  const [selected, setSelected] = useState(initial);
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const hostRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<TermSession | null>(null);

  const instance = instances.find((b) => keyOf(b) === selected);

  useEffect(() => {
    // The instance list has not synced back on first paint: do not overwrite the instance from the URL with an empty list.
    if (!instances.length) return;
    if (!selected || !instances.some((b) => keyOf(b) === selected)) {
      setSelected(keyOf(instances[0]));
    }
  }, [selected, instances]);

  const hostId = instance?.host_id;
  const instanceId = instance?.id;

  useEffect(() => {
    const mount = hostRef.current;
    if (!mount || !hostId || !instanceId) {
      setStatus("idle");
      return;
    }
    const session = getTerminalSession(hostId, instanceId);
    sessionRef.current = session;
    session.attach(mount);
    const sync = () => {
      setStatus(session.status);
      setError(session.error);
    };
    sync();
    const unsubscribe = session.subscribe(sync);
    return () => {
      unsubscribe();
      session.detach();
      if (sessionRef.current === session) sessionRef.current = null;
    };
  }, [hostId, instanceId]);

  function choose(key: string) {
    setSelected(key);
    const next = new URLSearchParams(params);
    next.set("instance", key);
    setParams(next, { replace: true });
  }

  async function copy() {
    if (!instance) return;
    try {
      await navigator.clipboard.writeText(sshCommand(instance.ssh_host, instance.ssh_port, instance.ssh_user));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore
    }
  }

  const sshLine = useMemo(
    () => (instance ? sshCommand(instance.ssh_host, instance.ssh_port, instance.ssh_user) : "-"),
    [instance],
  );

  return (
    <div className="page page-term">
      <PageHead
        title={t("终端")}
        meta={
          <>
            <span>{host?.name ?? t("未选择主机")}</span>
            <span className="sep" />
            <span>{STATUS_LABEL[status]}</span>
          </>
        }
        actions={
          instance ? (
            <>
              <button className="btn" onClick={() => sessionRef.current?.reconnect()}>
                <Icon name="refresh" size={14} />
                {t("重连")}
              </button>
              <button className="btn" onClick={copy}>
                <Icon name={copied ? "check" : "copy"} size={14} />
                {copied ? t("已复制") : t("复制 SSH")}
              </button>
              <Link
                className="btn"
                to={instance.role === "scheduler" ? `/scheduler/${instance.id}` : `/builders/${instance.id}`}
              >
                <Icon name={instance.role === "scheduler" ? "server" : "box"} size={14} />
                {instance.role === "scheduler" ? t("调度机详情") : t("构建机详情")}
              </Link>
            </>
          ) : undefined
        }
      />

      {instances.length === 0 ? (
        <div className="card"><Empty text={t("还没有可进入终端的实例。先部署调度机或构建机。")} /></div>
      ) : (
        <div className="term-layout">
          <aside className="term-roster">
            {(["scheduler", "builder"] as const).map((role) => {
              const group = instances.filter((i) => i.role === role);
              if (!group.length) return null;
              // One group per host, collapsed by host name; the local host is expanded by default and folded hosts are collapsed.
              const groups = groupByHost(group, host?.id);
              const renderItem = (b: Instance) => (
                <button key={keyOf(b)} className={`roster-item${keyOf(b) === selected ? " active" : ""}`} onClick={() => choose(keyOf(b))}>
                  <span className={`dot ${b.state === "ONLINE" ? "dot-ok" : b.state === "SUSPECT" ? "dot-warn" : "dot-bad"}`} />
                  <span className="roster-body">
                    <b>{b.name}</b>
                    <small>{osLabel(b.os)} · :{b.ssh_port}</small>
                  </span>
                  {db.tasks.some((t) => t.instance_id === b.id && t.state === "RUNNING") && <span className="working-pip" />}
                </button>
              );
              return (
                <div key={role} className="roster-group">
                  <div className="roster-title">{role === "scheduler" ? t("调度机") : t("构建机")}</div>
                  {groups.length > 1
                    ? groups.map((g) => (
                        <HostFold
                          key={g.hostId}
                          name={g.name}
                          label={t("{count} 台", { count: g.items.length })}
                          foldKey={`terminal:${role}:${g.hostId}`}
                          defaultOpen={g.current}
                          forceOpen={g.items.some((i) => keyOf(i) === selected)}
                        >
                          {g.items.map(renderItem)}
                        </HostFold>
                      ))
                    : groups[0]?.items.map(renderItem)}
                </div>
              );
            })}
          </aside>

          <section className="term-panel">
            <div className="term-head">
              <Icon name="terminal" size={15} />
              <b>{instance?.name ?? t("未选择")}</b>
              {instance && <Badge value={instance.state} />}
              <span className={`term-status term-status-${status}`}>{STATUS_LABEL[status]}</span>
              <span className="lock">
                <Icon name="lock" size={12} />
                root
              </span>
            </div>
            <div className="term-body term-xterm" ref={hostRef} />
            {error && <div className="term-alert">{error}</div>}
            <div className="term-foot">
              <span>{sshLine}</span>
              <span>
                {instance
                  ? t("{name} · {role} · root shell", { name: instance.name, role: instance.role === "scheduler" ? t("调度机") : osLabel(instance.os) })
                  : "-"}
              </span>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
