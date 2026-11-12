import { t } from "../i18n";
import { useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { db } from "../store";
import { useHostScope } from "../host-context";
import { tasksForHost } from "../host-tasks";
import { useLive } from "../live/context";
import { errorMessage } from "../live/client";
import { getLiveConnection } from "../live/config";
import { fetchTaskEvents } from "../live/sync";
import type { Task, TaskEvent } from "../types";
import { Character } from "../components/Character";
import { CreateTaskModal } from "../components/CreateTask";
import { Badge, Button, Callout, Card, CardTitle, Empty, KeyVal, PageHead, Tag } from "../components/ui";
import { Icon } from "../components/Icon";
import { cancelBuild, retryBuild } from "../api";

const FILTERS = ["ALL", "QUEUED", "RUNNING", "SUCCEEDED", "FAILED"] as const;

export function TaskList() {
  const live = useLive();
  const { host } = useHostScope();
  const [params, setParams] = useSearchParams();
  const [submitOpen, setSubmitOpen] = useState(params.get("new") === "1");
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>("ALL");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (params.get("new") === "1") setSubmitOpen(true);
  }, [params]);

  const tasks = tasksForHost(host);
  const shown = tasks.filter((t) => {
    if (filter !== "ALL" && t.state !== filter) return false;
    const q = query.trim().toLowerCase();
    return !q || t.title.toLowerCase().includes(q) || t.id.toLowerCase().includes(q) || t.type.includes(q);
  });

  function closeSubmit() {
    setSubmitOpen(false);
    if (params.get("new")) {
      params.delete("new");
      setParams(params, { replace: true });
    }
  }

  async function act(id: string, action: "retry" | "cancel", schedulerDeploymentId?: string | null) {
    setBusy(`${id}:${action}`);
    setError("");
    try {
      if (action === "retry") await retryBuild(id, live.refresh, schedulerDeploymentId);
      else await cancelBuild(id, live.refresh, schedulerDeploymentId);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="page">
      <PageHead
        title={t("任务")}
        meta={
          <>
            <span>{host?.name ?? t("未选择主机")}</span>
            <span className="sep" />
            <span>{t("{count} 条", { count: tasks.length })}</span>
            <span className="sep" />
            <span>{t("{count} 运行中", { count: tasks.filter((t) => t.state === "RUNNING").length })}</span>
            <span className="sep" />
            <span>{t("{count} 排队", { count: tasks.filter((t) => t.state === "QUEUED").length })}</span>
          </>
        }
        actions={
          <Button variant="primary" onClick={() => setSubmitOpen(true)}>
            <Icon name="plus" size={14} />
            {t("创建任务")}
          </Button>
        }
      />

      <div className="toolbar">
        <div className="search">
          <Icon name="search" size={14} />
          <input className="input" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("标题 / ID / 类型")} />
        </div>
        <div className="segmented">
          {FILTERS.map((f) => (
            <button key={f} className={`segment${filter === f ? " active" : ""}`} onClick={() => setFilter(f)}>
              {f === "ALL" ? t("全部") : f}
              <em>{f === "ALL" ? tasks.length : tasks.filter((t) => t.state === f).length}</em>
            </button>
          ))}
        </div>
      </div>

      {error && <Callout tone="bad">{error}</Callout>}

      <Card flush>
        {shown.length === 0 ? (
          <Empty text={t("没有匹配的任务。")} />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>{t("任务")}</th>
                <th>{t("类型")}</th>
                <th>{t("状态")}</th>
                <th>{t("构建机")}</th>
                <th>{t("优先级")}</th>
                <th>{t("创建时间")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {shown.map((task) => {
                const inst = db.instances.find((i) => i.id === task.instance_id);
                return (
                  <tr key={task.id}>
                    <td>
                      <Link className="strong" to={`/tasks/${task.id}`}>{task.title}</Link>
                      <div className="small"><code>{task.id}</code></div>
                    </td>
                    <td><Tag>{task.type}</Tag></td>
                    <td><Badge value={task.state} /></td>
                    <td>{inst ? <Link className="link" to={`/builders/${inst.id}`}>{inst.name}</Link> : <span className="muted">{t("自动选择")}</span>}</td>
                    <td>P{task.priority}</td>
                    <td className="muted small">{new Date(task.created_at).toLocaleString("zh-CN")}</td>
                    <td>
                      <div className="actions">
                        {(task.state === "FAILED" || task.state === "CANCELLED") && (
                          <Button size="sm" onClick={() => act(task.id, "retry", task.scheduler_deployment_id)} disabled={busy === `${task.id}-retry`}>{t("重试")}</Button>
                        )}
                        {(task.state === "QUEUED" || task.state === "RUNNING") && (
                          <Button size="sm" onClick={() => act(task.id, "cancel", task.scheduler_deployment_id)} disabled={busy === `${task.id}-cancel`}>{t("取消")}</Button>
                        )}
                        <Link className="icon-btn" to={`/tasks/${task.id}`} title={t("详情")}><Icon name="arrow" size={14} /></Link>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>

      <CreateTaskModal open={submitOpen} onClose={closeSubmit} />
    </div>
  );
}

export function TaskShow() {
  const { id = "" } = useParams();
  const live = useLive();
  const task = db.tasks.find((t) => t.id === id);
  const [events, setEvents] = useState<TaskEvent[]>(task?.events ?? []);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    setEvents(task?.events ?? []);
    const conn = getLiveConnection();
    if (!conn || !task) return;
    let alive = true;
    fetchTaskEvents(conn, task.id, task.scheduler_deployment_id)
      .then((items) => { if (alive) setEvents(items); })
      .catch(() => {});
    return () => { alive = false; };
  }, [task?.id, task?.events]);

  if (!task) {
    return (
      <div className="page">
        <Card><Empty text={t("任务不存在或已被清理。")} /></Card>
        <p style={{ marginTop: 12 }}><Link className="link" to="/tasks">{t("返回任务列表")}</Link></p>
      </div>
    );
  }

  const inst = db.instances.find((i) => i.id === task.instance_id);
  const instruction = String(
    task.payload.instruction ?? task.payload.command ?? task.payload.requirements ?? "",
  );

  async function act(action: "retry" | "cancel") {
    setBusy(action);
    setError("");
    try {
      if (action === "retry") await retryBuild(task!.id, live.refresh, task!.scheduler_deployment_id);
      else await cancelBuild(task!.id, live.refresh, task!.scheduler_deployment_id);
      if (live.connected) await live.refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="page">
      <Link className="back" to="/tasks"><Icon name="back" size={13} />{t("任务")}</Link>
      <PageHead
        title={
          <>
            <Character role="builder" state={task.state === "RUNNING" ? "working" : task.state === "FAILED" ? "alert" : "idle"} size={44} flat />
            {task.title}
            <Badge value={task.state} />
          </>
        }
        meta={
          <>
            <code>{task.id}</code>
            <span className="sep" />
            <span>{task.type}</span>
            <span className="sep" />
            <span>P{task.priority}</span>
            <span className="sep" />
            <span>{t("第 {n} 次尝试", { n: task.attempts })}</span>
          </>
        }
        actions={
          <>
            {(task.state === "FAILED" || task.state === "CANCELLED" || task.state === "BLOCKED") && (
              <Button onClick={() => act("retry")} disabled={busy === "retry"}>
                <Icon name="refresh" size={14} />
                {busy === "retry" ? t("重试中…") : t("重试")}
              </Button>
            )}
            {(task.state === "QUEUED" || task.state === "RUNNING") && (
              <Button onClick={() => act("cancel")} disabled={busy === "cancel"}>
                <Icon name="stop" size={13} />
                {t("取消")}
              </Button>
            )}
            {inst && (
              <Link className="btn" to={`/terminal?instance=${encodeURIComponent(inst.key)}`}>
                <Icon name="terminal" size={14} />
                {t("进入构建机")}
              </Link>
            )}
          </>
        }
      />

      {error && <Callout tone="bad">{error}</Callout>}
      {task.block_reason && <Callout tone="bad">{task.block_reason}</Callout>}

      <div className="detail-grid">
        <Card>
          <CardTitle>{t("执行信息")}</CardTitle>
          <div className="kv-list">
            <KeyVal label={t("工作流")}>{task.workflow}</KeyVal>
            <KeyVal label={t("阶段")}>{task.stage}</KeyVal>
            <KeyVal label={t("目标角色")}>{task.target_role}</KeyVal>
            <KeyVal label={t("构建机")}>{inst ? <Link className="link" to={`/builders/${inst.id}`}>{inst.name}</Link> : t("等待派发")}</KeyVal>
            <KeyVal label={t("创建时间")}>{new Date(task.created_at).toLocaleString("zh-CN")}</KeyVal>
            <KeyVal label={t("开始时间")}>{task.started_at ? new Date(task.started_at).toLocaleString("zh-CN") : "-"}</KeyVal>
            <KeyVal label={t("结束时间")}>{task.finished_at ? new Date(task.finished_at).toLocaleString("zh-CN") : "-"}</KeyVal>
          </div>
        </Card>

        <Card>
          <CardTitle>{t("任务与参数")}</CardTitle>
          <pre className="code-block command-block">{instruction || t("（无任务描述）")}</pre>
          <div className="kv-list" style={{ marginTop: 10 }}>
            {Object.entries(task.payload)
              .filter(([k]) => k !== "instruction" && k !== "command" && k !== "requirements")
              .map(([k, v]) => (
                <KeyVal key={k} label={k}>{typeof v === "object" ? JSON.stringify(v) : String(v)}</KeyVal>
              ))}
          </div>
        </Card>
      </div>

      <Card style={{ marginTop: 16 }}>
        <CardTitle>{t("事件")}</CardTitle>
        {events.length ? (
          <ul className="timeline">
            {events.map((e, i) => (
              <li key={`${e.at}-${i}`}>
                <span className={`tl-dot tl-${e.type.toLowerCase()}`} />
                <div>
                  <b>{e.type}</b>
                  <p>{e.message}</p>
                  <small>{new Date(e.at).toLocaleString("zh-CN")}</small>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <Empty text={t("还没有事件。实时模式下会从调度机拉取。")} />
        )}
      </Card>
    </div>
  );
}

export function taskById(id: string): Task | undefined {
  return db.tasks.find((t) => t.id === id);
}
