import { t } from "../i18n";
import { useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { db } from "../store";
import { useHostScope } from "../host-context";
import { tasksForHost } from "../host-tasks";
import { useLive } from "../live/context";
import { errorMessage } from "../live/client";
import { getLiveConnection } from "../live/config";
import { fetchFailureSignatures, fetchTaskDetail, fetchTaskEvents } from "../live/sync";
import type { FailureSignature, Task, TaskAttempt, TaskChild, TaskEvent } from "../types";
import { Character } from "../components/Character";
import { CreateTaskModal } from "../components/CreateTask";
import { Badge, Button, Callout, Card, CardTitle, Empty, KeyVal, PageHead, Tag } from "../components/ui";
import { Icon } from "../components/Icon";
import { answerTask, cancelBuild, retryBuild } from "../api";

const FILTERS = ["ALL", "QUEUED", "RUNNING", "NEEDS_INPUT", "WAITING_CHILDREN", "SUCCEEDED", "FAILED"] as const;

const OUTCOME_LABELS: Record<string, string> = {
  completed: "已完成",
  error: "执行错误",
  cancelled: "已取消",
  input_expired: "等待回答超时",
  input_exhausted: "回答轮次用尽",
  children_exhausted: "子任务轮次用尽",
  interrupted_after_outward: "外部操作后中断",
};

const FAILURE_CLASS_LABELS: Record<string, string> = {
  permanent: "确定性失败",
  outward: "外部操作后中断",
  rate_limit: "限流",
  busy: "资源占用",
  transient: "暂时性错误",
};

const APPROVAL_LABELS: Record<string, string> = {
  ask: "只读并提问",
  edits: "可改文件",
  auto: "可执行命令",
  full: "完全自主",
};

/** Internal payload keys mean nothing to an operator; show the platform wording instead. */
const PAYLOAD_LABELS: Record<string, string> = {
  payload_ref: "载荷引用",
  resource_profile_id: "资源规格",
};

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
                    <td>
                      <Badge value={task.state} />
                      {/* A retrying task is QUEUED between attempts; the counter is the only hint in the list that it already failed. */}
                      {task.state === "QUEUED" && task.attempts > 0 && (
                        <div className="small muted">{t("上次执行失败，等待自动重试")}</div>
                      )}
                    </td>
                    <td>{inst ? <Link className="link" to={`/builders/${inst.id}`}>{inst.name}</Link> : <span className="muted">{t("自动选择")}</span>}</td>
                    <td>P{task.priority}</td>
                    <td className="muted small">{new Date(task.created_at).toLocaleString("zh-CN")}</td>
                    <td>
                      <div className="actions">
                        {(task.state === "FAILED" || task.state === "CANCELLED") && (
                          <Button size="sm" onClick={() => act(task.id, "retry", task.scheduler_deployment_id)} disabled={busy === `${task.id}-retry`}>{t("重试")}</Button>
                        )}
                        {(task.state === "QUEUED" ||
                          task.state === "RUNNING" ||
                          task.state === "NEEDS_INPUT" ||
                          task.state === "WAITING_CHILDREN") && (
                          <Button size="sm" onClick={() => act(task.id, "cancel", task.scheduler_deployment_id)} disabled={busy === `${task.id}-cancel`}>{t("取消")}</Button>
                        )}
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
  // The list projection has no failure text; the attempt history is the only place the agent's error message lives.
  const [attempts, setAttempts] = useState<TaskAttempt[]>([]);
  const [children, setChildren] = useState<TaskChild[]>([]);
  // How often this same normalized failure has been seen across the fleet; one row, not one per run.
  const [signatures, setSignatures] = useState<FailureSignature[]>([]);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [answer, setAnswer] = useState("");

  useEffect(() => {
    setEvents(task?.events ?? []);
    const conn = getLiveConnection();
    if (!conn || !task) return;
    let alive = true;
    fetchTaskEvents(conn, task.id, task.scheduler_deployment_id)
      .then((items) => { if (alive) setEvents(items); })
      .catch(() => {});
    fetchTaskDetail(conn, task.id, task.scheduler_deployment_id)
      .then((detail) => {
        if (!alive) return;
        setAttempts(detail.attempts);
        setChildren(detail.children);
      })
      .catch(() => {});
    fetchFailureSignatures(conn, task.scheduler_deployment_id)
      .then((items) => { if (alive) setSignatures(items); })
      .catch(() => {});
    return () => { alive = false; };
  }, [task?.id, task?.events, task?.state, task?.attempts]);

  if (!task) {
    return (
      <div className="page">
        <Card><Empty text={t("任务不存在或已被清理。")} /></Card>
        <p style={{ marginTop: 12 }}><Link className="link" to="/tasks">{t("返回任务列表")}</Link></p>
      </div>
    );
  }

  const inst = db.instances.find((i) => i.id === task.instance_id);
  // requirements is an object: reading it with String() printed "[object Object]" instead of the task body.
  const requirements = (task.payload.requirements ?? {}) as Record<string, unknown>;
  const build = (requirements.build ?? {}) as Record<string, unknown>;
  const chat = (requirements.chat ?? {}) as Record<string, unknown>;
  const instruction = String(
    task.payload.instruction ??
      build.instruction ??
      chat.message ??
      task.payload.command ??
      "",
  );
  // The newest failed attempt explains why the task is queued for a retry or dead-lettered; a later success supersedes it.
  const lastFailure =
    task.state === "QUEUED" || task.state === "FAILED"
      ? [...attempts].reverse().find((a) => a.status === "FAILED" && a.error)
      : undefined;
  // The fleet-wide row for this exact failure: occurrence count, not another message.
  const sameFailure = lastFailure?.failure_signature
    ? signatures.find((s) => s.signature === lastFailure.failure_signature)
    : undefined;

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

  async function submitAnswer() {
    const text = answer.trim();
    if (!text) return;
    setBusy("answer");
    setError("");
    try {
      await answerTask(task!.id, text, live.refresh, task!.scheduler_deployment_id);
      setAnswer("");
      if (live.connected) await live.refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="page page-task">
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
            {(task.state === "QUEUED" || task.state === "RUNNING" || task.state === "WAITING_CHILDREN") && (
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
      {/* The agent stopped and is waiting for a person. Answering requeues the task and hands the
          answer to the next attempt; it is not a failure and does not consume the retry budget. */}
      {task.state === "NEEDS_INPUT" && (
        <Card style={{ marginBottom: 16 }}>
          <CardTitle>{t("等待回答")}</CardTitle>
          <div className="question-box">{task.pending_question?.question ?? t("（没有记录问题内容）")}</div>
          <textarea
            className="input"
            rows={4}
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            placeholder={t("回答后任务会带着这个回答继续执行")}
            style={{ width: "100%", marginTop: 10, resize: "vertical" }}
          />
          <div className="actions" style={{ marginTop: 10 }}>
            <Button variant="primary" onClick={() => void submitAnswer()} disabled={busy === "answer" || !answer.trim()}>
              {busy === "answer" ? t("提交中…") : t("提交回答并继续")}
            </Button>
            <Button onClick={() => act("cancel")} disabled={busy === "cancel"}>{t("放弃任务")}</Button>
          </div>
        </Card>
      )}

      {lastFailure && (
        <Callout tone="bad">
          {t("第 {n} 次执行失败（{code}）：{message}", {
            n: lastFailure.attempt_number,
            code: lastFailure.error?.code ?? "UNKNOWN",
            message: lastFailure.error?.message ?? "",
          })}
          {lastFailure.failure_class
            ? ` ${t("分类：{label}。", {
                label: t(FAILURE_CLASS_LABELS[lastFailure.failure_class] ?? lastFailure.failure_class),
              })}`
            : ""}
          {sameFailure ? ` ${t("同类失败已出现 {count} 次。", { count: sameFailure.occurrences })}` : ""}
          {task.state === "QUEUED"
            ? ` ${
                lastFailure.failure_class === "rate_limit"
                  ? t("正在等待外部限制恢复，恢复后自动重试。")
                  : t("调度机正在退避后自动重试。")
              }`
            : ""}
          {lastFailure.failure_signature && (
            <div className="muted small" style={{ marginTop: 6 }}>
              {t("失败签名：{signature}", { signature: lastFailure.failure_signature })}
            </div>
          )}
        </Callout>
      )}

      <div className="detail-grid">
        <Card>
          <CardTitle>{t("执行信息")}</CardTitle>
          <div className="kv-list">
            <KeyVal label={t("工作流")}>{task.workflow}</KeyVal>
            <KeyVal label={t("阶段")}>{task.stage}</KeyVal>
            <KeyVal label={t("目标角色")}>{task.target_role}</KeyVal>
            {task.approval_mode && (
              <KeyVal label={t("自主程度")}>
                {t(APPROVAL_LABELS[task.approval_mode] ?? task.approval_mode)}
              </KeyVal>
            )}
            {task.outcome && (
              <KeyVal label={t("结果")}>{t(OUTCOME_LABELS[task.outcome] ?? task.outcome)}</KeyVal>
            )}
            {task.parent_task_id && (
              <KeyVal label={t("父任务")}>
                <Link className="link" to={`/tasks/${task.parent_task_id}`}>{task.parent_task_id}</Link>
              </KeyVal>
            )}
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
                <KeyVal key={k} label={PAYLOAD_LABELS[k] ? t(PAYLOAD_LABELS[k]) : k}>
                  {typeof v === "object" ? JSON.stringify(v) : String(v)}
                </KeyVal>
              ))}
          </div>
        </Card>
      </div>

      {/* Fan-out: the parent waits here until every child is terminal, then resumes with their results. */}
      {(children.length || task.children?.length || task.parent_task_id) && (
        <Card style={{ marginTop: 16 }}>
          <CardTitle>{t("子任务")}</CardTitle>
          {(children.length ? children : task.children ?? []).length ? (
            <table className="table">
              <thead>
                <tr>
                  <th>{t("任务")}</th>
                  <th>{t("类型")}</th>
                  <th>{t("状态")}</th>
                  <th>{t("结果")}</th>
                </tr>
              </thead>
              <tbody>
                {(children.length ? children : task.children ?? []).map((c) => (
                  <tr key={c.task_id}>
                    <td>
                      <Link className="strong" to={`/tasks/${c.task_id}`}>{c.title || c.task_id}</Link>
                    </td>
                    <td><Tag>{c.task_type}</Tag></td>
                    <td><Badge value={c.status} /></td>
                    <td className="muted small">{c.outcome ? t(OUTCOME_LABELS[c.outcome] ?? c.outcome) : "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Empty text={t("这个任务由父任务拆分而来，等待父任务汇总结果。")} />
          )}
        </Card>
      )}

      <Card className="events-card" style={{ marginTop: 16 }}>
        <CardTitle>{t("事件")}</CardTitle>
        {events.length ? (
          // The event trail grows for the whole task lifetime; scroll it inside the card instead of stretching the page.
          <div className="events-scroll">
            <ul className="timeline">
              {/* Newest first: the latest state is what an operator opens the page for. */}
              {[...events].reverse().map((e, i) => (
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
          </div>
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
