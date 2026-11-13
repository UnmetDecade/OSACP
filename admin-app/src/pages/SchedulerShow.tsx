import { t } from "../i18n";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { db } from "../store";
import { useHostScope } from "../host-context";
import { tasksForHost } from "../host-tasks";
import { useLive } from "../live/context";
import { errorMessage } from "../live/client";
import { Character } from "../components/Character";
import { InstanceProfilesModal } from "../components/InstanceProfiles";
import { Badge, Button, Callout, Card, CardTitle, Empty, KeyVal, PageHead, Tag } from "../components/ui";
import { Icon } from "../components/Icon";
import { builderAction, sshCommand } from "../api";
import type { Instance } from "../types";

/** Single scheduler details: queue, running tasks, bound Agents and configuration. */
export function SchedulerShow() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const live = useLive();
  const { host: scopeHost } = useHostScope();
  const scheduler = db.instances.find((i) => i.id === id && i.role === "scheduler");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [profilesOpen, setProfilesOpen] = useState(false);

  if (!scheduler) {
    return (
      <div className="page">
        <Card><Empty text={t("调度机不存在或已被删除。")} /></Card>
        <p style={{ marginTop: 12 }}><Link className="link" to="/scheduler">{t("返回调度机列表")}</Link></p>
      </div>
    );
  }

  const s = scheduler;
  const host = db.hosts.find((h) => h.id === s.host_id);
  const internalRole = s.scheduler_role ?? "root";
  // From the current host's view: a folded host's root is not this host's root, but a node under the parent host's root.
  const merged = internalRole === "root" && scopeHost?.id !== s.host_id;
  const externalRole = internalRole === "node" || merged ? "node" : "root";
  // Resolve parent references by instance name first: a scheduler restart changes the deployment_id, but the instance name stays.
  const parent = s.parent_scheduler_id
    ? db.instances.find(
        (i) =>
          i.role === "scheduler" &&
          (s.parent_scheduler_instance_id
            ? i.id === s.parent_scheduler_instance_id
            : (i.deployment_id ?? i.id) === s.parent_scheduler_id),
      )
    : merged && host?.parent_host_id
      ? db.instances.find(
          (i) =>
            i.role === "scheduler" &&
            i.host_id === host.parent_host_id &&
            (i.scheduler_role ?? "root") === "root",
        )
      : undefined;
  const parentHost = merged && host?.parent_host_id
    ? db.hosts.find((h) => h.id === host.parent_host_id)
    : undefined;
  // All schedulers on the same host, used to show the parent scheduler's name and port.
  const hostSchedulers = db.instances.filter((i) => i.role === "scheduler" && i.host_id === s.host_id);
  const hostRoot = hostSchedulers.find(
    (i) => (i.scheduler_role ?? "root") === "root",
  );
  // Attribute by instance name; legacy data without scheduler_instance_id falls back to the local root scheduler.
  const owned = db.instances.filter(
    (b) =>
      b.role === "builder" &&
      b.host_id === s.host_id &&
      (b.scheduler_instance_id ?? hostRoot?.id) === s.id,
  );
  const ownedIds = new Set(owned.map((b) => b.id));
  // Tasks without an assigned builder land on the host entry point, i.e. the local root scheduler.
  const tasks = host
    ? tasksForHost(host).filter((t) =>
        t.instance_id ? ownedIds.has(t.instance_id) : internalRole === "root",
      )
    : [];
  const stats = {
    queued: tasks.filter((t) => t.state === "QUEUED").length,
    running: tasks.filter((t) => t.state === "RUNNING").length,
    succeeded: tasks.filter((t) => t.state === "SUCCEEDED").length,
    failed: tasks.filter((t) => t.state === "FAILED").length,
  };
  const queued = tasks
    .filter((t) => t.state === "QUEUED")
    .sort((a, b) => a.priority - b.priority || a.created_at.localeCompare(b.created_at));
  const running = tasks.filter((t) => t.state === "RUNNING");
  const agent = db.agents.find((a) => a.id === s.agent_profile_id);
  const agentModel =
    db.apis.find((a) => a.id === agent?.model_api_profile_id) ??
    db.apis.find((a) => a.kind === "llm" && (s.api_profile_ids ?? []).includes(a.id));
  const w = owned
    .filter((b) => b.state === "ONLINE")
    .reduce((sum, b) => sum + (b.capability_score ?? 0), 0);
  const offline = s.state !== "ONLINE";

  async function act(action: "start" | "stop" | "restart" | "remove") {
    if (action === "remove" && !window.confirm(t("删除 {name}？容器与数据卷都会被删除。", { name: s.name }))) return;
    setBusy(action);
    setError("");
    try {
      await builderAction(s.id, action, live.refresh, s.host_id);
      if (action === "remove") navigate("/scheduler");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy("");
    }
  }

  function builderOfTask(t: { instance_id?: string }): Instance | undefined {
    return db.instances.find((i) => i.key === t.instance_id || i.id === t.instance_id);
  }

  return (
    <div className="page page-sched">
      <Link className="back" to="/scheduler"><Icon name="back" size={13} />{t("调度机")}</Link>
      <PageHead
        title={
          <>
            <Character role="scheduler" state={offline ? "offline" : stats.queued ? "working" : "idle"} size={46} flat />
            {s.name}
            <Badge value={s.state} />
            <Tag tone={externalRole === "root" ? "ok" : "accent"}>
              {externalRole === "root" ? t("根") : t("结点")}
            </Tag>
          </>
        }
        meta={
          <>
            <span>{host?.name ?? s.host_id}</span>
            <span className="sep" />
            <span>{s.cpu_limit}C / {Math.round(s.mem_limit_mb / 1024)} GiB</span>
            <span className="sep" />
            <span>{t("{count} 构建机 · ΣW {w}", { count: owned.length, w })}</span>
            <span className="sep" />
            <span>{t("配置 v{version}", { version: s.config_version })}</span>
          </>
        }
        actions={
          <>
            <Link className="btn" to={`/terminal?instance=${encodeURIComponent(s.key)}`}>
              <Icon name="terminal" size={14} />
              {t("终端")}
            </Link>
            <Link className="btn" to={`/chat?instance=${encodeURIComponent(s.key)}`}>
              <Icon name="chat" size={14} />
              {t("问派令")}
            </Link>
            <Button onClick={() => setProfilesOpen(true)}>
              <Icon name="agent" size={14} />
              {t("配置 Agent")}
            </Button>
            <Button onClick={() => act("restart")} disabled={busy !== ""}>
              <Icon name="refresh" size={13} />
              {t("重启")}
            </Button>
            <Button onClick={() => act(offline ? "start" : "stop")} disabled={busy !== ""}>
              <Icon name={offline ? "play" : "stop"} size={13} />
              {offline ? t("启动") : t("停止")}
            </Button>
            <Button variant="danger" onClick={() => act("remove")} disabled={busy !== ""}>
              <Icon name="trash" size={13} />
              {t("删除")}
            </Button>
          </>
        }
      />

      {error && <Callout tone="bad">{error}</Callout>}

      {/* Two blocks side by side at the top: overview on the left, scheduling Agent config on the right. The page has a fixed height;
          when space runs out the cards scroll themselves and the page does not. */}
      <div className="sched-top">
        <Card>
          <CardTitle>{t("运行信息")}</CardTitle>
          <div className="kv-list">
            <KeyVal label={t("状态")}><Badge value={s.state} /></KeyVal>
            <KeyVal label={t("主机")}>{host?.name ?? s.host_id}</KeyVal>
            <KeyVal label={t("排队")}>{stats.queued}</KeyVal>
            <KeyVal label={t("运行")}>{stats.running}</KeyVal>
            <KeyVal label={t("今日成功")}>{stats.succeeded}</KeyVal>
            <KeyVal label={t("失败")}>
              <span className={stats.failed ? "text-bad" : undefined}>{stats.failed}</span>
            </KeyVal>
            <KeyVal label={t("构建机")}>{t("{count} 构建机 · ΣW {w}", { count: owned.length, w })}</KeyVal>
            <KeyVal label="SSH">
              {s.ssh_port ? sshCommand(s.ssh_host, s.ssh_port, s.ssh_user) : "-"}
            </KeyVal>
            <KeyVal label={t("镜像")}><code className="digest">{s.image}</code></KeyVal>
          </div>
        </Card>

        <Card>
          <CardTitle>{t("调度 Agent")}</CardTitle>
          <div className="kv-list">
            <KeyVal label={t("实例 ID")}>{s.id}</KeyVal>
            <KeyVal label={t("角色")}>
              {externalRole === "node"
                ? merged
                  ? t("结点调度机（并入 {host}）", { host: parentHost?.name ?? t("上级主机") })
                  : t("结点调度机")
                : t("根调度机")}
            </KeyVal>
            <KeyVal label={t("父调度机")}>
              {externalRole === "node" ? parent?.name ?? "-" : "—"}
            </KeyVal>
            <KeyVal label={t("API 端口")}>{s.port ? `:${s.port}` : "-"}</KeyVal>
            <KeyVal label="Agent">{agent ? `${agent.name} · v${agent.version}` : t("未绑定")}</KeyVal>
            <KeyVal label={t("适配器")}><code>{agent?.adapter ?? "-"}</code></KeyVal>
            <KeyVal label={t("模型")}>{agentModel ? `${agentModel.name} · ${agentModel.base_url}` : t("未绑定模型")}</KeyVal>
            <KeyVal label="API">
              {(s.api_profile_ids ?? [])
                .map((pid) => db.apis.find((a) => a.id === pid)?.name ?? pid)
                .join(" · ") || "-"}
            </KeyVal>
            <KeyVal label={t("能力")}>
              <div className="chips">
                {(agent?.capabilities ?? []).map((c) => <Tag key={c}>{c}</Tag>)}
              </div>
            </KeyVal>
          </div>
        </Card>
      </div>

      <div className="grid-2 sched-split" style={{ marginTop: 16 }}>
        <Card>
          <CardTitle extra={<Link className="link" to="/tasks">{t("全部任务")}</Link>}>
            {t("待派发队列")}
          </CardTitle>
          <div className="rail-list">
            {queued.map((task, i) => (
              <Link className="rail-row" key={task.id} to={`/tasks/${task.id}`}>
                <span className="queue-index">{i + 1}</span>
                <div>
                  <b>{task.title}</b>
                  <small>P{task.priority} · {task.type} · {t("等待 {min} 分钟", { min: Math.max(1, Math.round((Date.now() - new Date(task.created_at).getTime()) / 60000)) })}</small>
                </div>
                <Badge value={task.state} />
              </Link>
            ))}
            {queued.length === 0 && <Empty text={t("队列为空，调度机在等任务。")} />}
          </div>
        </Card>

        <Card>
          <CardTitle>{t("运行中")}</CardTitle>
          <div className="rail-list">
            {running.map((task) => {
              const inst = builderOfTask(task);
              return (
                <Link className="rail-row" key={task.id} to={`/tasks/${task.id}`}>
                  <div>
                    <b>{task.title}</b>
                    <small>{inst?.name ?? task.instance_id ?? "-"} · {task.type}</small>
                  </div>
                  <Badge value={task.state} />
                </Link>
              );
            })}
            {running.length === 0 && <Empty text={t("没有运行中的任务。")} />}
          </div>
        </Card>
      </div>

      {profilesOpen && (
        <InstanceProfilesModal
          instance={s}
          role="scheduler"
          onClose={() => setProfilesOpen(false)}
        />
      )}
    </div>
  );
}
