import { t } from "../i18n";
import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { db } from "../store";
import { useHostScope } from "../host-context";
import { useLive } from "../live/context";
import { tasksForHost } from "../host-tasks";
import { Character } from "../components/Character";
import { Button, Callout, Card, CardTitle, Empty, Field, Modal, PageHead, Stat, Tag } from "../components/ui";
import { Icon } from "../components/Icon";
import { CreateBuilderModal } from "../components/CreateBuilder";
import { DeployBuilderModal } from "../components/DeployBuilder";
import { DeploySchedulerModal } from "../components/DeployScheduler";
import { StudioScene } from "../components/StudioScene";
import { CreateTaskModal } from "../components/CreateTask";
import { mergeHost } from "../api";
import { errorMessage } from "../live/client";

/**
 * Overview: one host's "AI Agent studio".
 * Schedulers on top, builders below, getting-started steps and recent activity on the right; all data is filtered by the current host.
 */
export function Dashboard() {
  const live = useLive();
  const { host } = useHostScope();
  const [params, setParams] = useSearchParams();
  const [addOpen, setAddOpen] = useState(false);
  // Third entry point: attach a host already onboarded to the control plane under the current host.
  const [attachOpen, setAttachOpen] = useState(false);
  const [attachId, setAttachId] = useState("");
  const [attachBusy, setAttachBusy] = useState(false);
  const [attachError, setAttachError] = useState("");
  // Create tasks in a dialog in place, without navigating to the tasks page, so current-host work is not interrupted.
  const [createOpen, setCreateOpen] = useState(false);
  // Deploying a builder first shows a trade-off comparison: container builder or bare-metal builder.
  const [builderChoiceOpen, setBuilderChoiceOpen] = useState(false);
  // Adding a builder / scheduler is entered only from the AI Agent studio; ?add= lets other pages jump back to it.
  const [addRole, setAddRole] = useState<"builder" | "scheduler" | null>(() => {
    const add = params.get("add");
    return add === "builder" || add === "scheduler" ? add : null;
  });
  // When opened from a node scheduler's "+", remember the parent scheduler (deployment_id); new characters hang under it by default.
  const [addUnder, setAddUnder] = useState<string | null>(null);
  function closeAdd() {
    setAddRole(null);
    setAddUnder(null);
    if (params.get("add")) {
      params.delete("add");
      setParams(params, { replace: true });
    }
  }
  // Whichever character type is chosen in the dialog, keep the parent scheduler carried in from the "+".
  function chooseRole(kind: "builder" | "scheduler") {
    setAddOpen(false);
    setAddRole(kind);
  }
  // "Onboard host" lists only hosts already onboarded to the control plane; exclude the current host itself and its ancestors/descendants to avoid cycles in the federation tree.
  const attachCandidates = (() => {
    if (!host) return [];
    const blocked = new Set<string>([host.id]);
    const collectDown = (id: string) => {
      for (const h of db.hosts) {
        if (h.parent_host_id === id && !blocked.has(h.id)) {
          blocked.add(h.id);
          collectDown(h.id);
        }
      }
    };
    collectDown(host.id);
    let cursor = db.hosts.find((h) => h.id === host.parent_host_id);
    const seen = new Set<string>();
    while (cursor && !seen.has(cursor.id)) {
      blocked.add(cursor.id);
      seen.add(cursor.id);
      cursor = db.hosts.find((h) => h.id === cursor!.parent_host_id);
    }
    return db.hosts.filter((h) => !blocked.has(h.id));
  })();
  function closeAttach() {
    setAttachOpen(false);
    setAttachId("");
    setAttachError("");
    setAttachBusy(false);
  }
  async function attachHost() {
    if (!host || !attachId) return;
    setAttachBusy(true);
    setAttachError("");
    try {
      await mergeHost(attachId, host.id, async () => {
        if (live.connected) await live.refresh();
      });
      closeAttach();
    } catch (e) {
      setAttachError(errorMessage(e));
    } finally {
      setAttachBusy(false);
    }
  }
  // The studio tree expands hosts folded into this one, and builder counts cover the whole subtree,
  // otherwise the canvas shows 3 while the header reports only this host's 2.
  const studioHostIds = (() => {
    const ids = new Set<string>();
    if (!host) return ids;
    const add = (id: string) => {
      if (ids.has(id)) return;
      ids.add(id);
      for (const h of db.hosts) if (h.parent_host_id === id) add(h.id);
    };
    add(host.id);
    return ids;
  })();
  const builders = db.instances.filter(
    (i) => i.role === "builder" && (!host || studioHostIds.has(i.host_id)),
  );
  // The overview recognizes only the local root scheduler: node schedulers are viewed on the scheduler page, and the entry point is always the root.
  const hostSchedulers = db.instances.filter(
    (i) => i.role === "scheduler" && (!host || i.host_id === host.id),
  );
  const scheduler =
    hostSchedulers.find((i) => (i.scheduler_role ?? "root") === "root") ?? hostSchedulers[0];
  const hostTasks = tasksForHost(host);
  const s = {
    onlineBuilders: builders.filter((b) => b.state === "ONLINE").length,
    totalBuilders: builders.length,
    running: hostTasks.filter((t) => t.state === "RUNNING").length,
    queued: hostTasks.filter((t) => t.state === "QUEUED").length,
    failed: hostTasks.filter((t) => t.state === "FAILED").length,
  };
  const schedulerReady = Boolean(scheduler);
  // The onboarding checklist describes this host only. A builder folded in from a merged host (or a stale
  // registration on another host) must not tick "deploy builder" while this host's studio still shows it missing.
  const hostBuilders = db.instances.filter(
    (i) => i.role === "builder" && (!host || i.host_id === host.id),
  );
  // A bare-metal builder can register with another scheduler directly; the host no longer needs a scheduler first.
  const buildersReady = hostBuilders.length > 0;
  const steps: {
    title: string;
    desc: string;
    done: boolean;
    to?: string;
    run?: () => void;
    action: string;
    blocked: string;
  }[] = [
    {
      title: t("部署调度机"),
      desc: t("平台指挥中心，负责接收任务、排队和派发。"),
      done: schedulerReady,
      run: () => setAddRole("scheduler"),
      action: t("立即部署 →"),
      blocked: "",
    },
    {
      title: t("部署构建机"),
      desc: t("用 Docker 容器运行构建 Agent，执行研发任务。"),
      done: buildersReady,
      // The steps lead straight into creating a builder; the container/bare-metal choice appears only at the studio's empty-state entry.
      run: () => setAddRole("builder"),
      action: t("立即部署 →"),
      blocked: "",
    },
    {
      title: t("提交第一个任务"),
      desc: t("选择 Agent 和构建机，开始自动化研发。"),
      done: buildersReady && hostTasks.length > 0,
      run: () => setCreateOpen(true),
      action: t("提交任务 →"),
      blocked: buildersReady ? "" : t("等待构建机部署"),
    },
  ];
  const guide = !schedulerReady
    ? { text: t("等待初始化"), tone: "warn" as const }
    : !buildersReady
      ? { text: t("等待构建机"), tone: "warn" as const }
      : hostTasks.length === 0
        ? { text: t("等待任务"), tone: "warn" as const }
        : { text: t("已完成"), tone: "ok" as const };

  return (
    <div className="page page-dashboard">
      <PageHead
        title={t("总览")}
        meta={
          <>
            <span>{host?.name ?? t("未选择主机")}</span>
            <span className="sep" />
            <span>{t("{online}/{total} 构建机在线", { online: s.onlineBuilders, total: s.totalBuilders })}</span>
          </>
        }
        actions={
          <>
            <Button variant="primary" onClick={() => setCreateOpen(true)} disabled={!schedulerReady}>
              <Icon name="play" size={13} />
              {t("创建任务")}
            </Button>
          </>
        }
      />

      <Card flush className="stat-bar">
        <Stat label={t("在线构建机")} value={<>{s.onlineBuilders}<em>/{s.totalBuilders}</em></>} tone={s.onlineBuilders ? "ok" : "bad"} />
        <Stat label={t("运行中任务")} value={s.running} />
        <Stat label={t("排队任务")} value={s.queued} tone={s.queued > 3 ? "warn" : undefined} />
        <Stat label={t("失败待处理")} value={s.failed} tone={s.failed ? "bad" : undefined} />
      </Card>

      <div className="studio-layout">
        <Card flush className="studio-panel">
          <div className="studio-head">
            <h2>{t("AI Agent 工作室")}</h2>
          </div>
          <StudioScene
            host={host}
            onAdd={(parent) => {
              setAddUnder(parent ? parent.deployment_id ?? parent.id : null);
              setAddOpen(true);
            }}
            onDeployScheduler={() => setAddRole("scheduler")}
            onDeployBuilder={() => setBuilderChoiceOpen(true)}
          />
        </Card>

        <aside className="studio-right">
          <Card className="guide-card">
            <div className="guide-head">
              <h2>{t("开始使用")}</h2>
              <Tag tone={guide.tone}>{guide.text}</Tag>
            </div>
            <p className="guide-intro">{t("完成以下步骤，启动你的 AI 研发工作室。")}</p>
            <div className="guide-list">
              {steps.map((step, i) => {
                const active = !step.done && !step.blocked;
                return (
                  <div
                    key={step.title}
                    className={`guide-item${step.done ? " done" : active ? " active" : ""}`}
                  >
                    <span className="guide-num">{step.done ? "✓" : i + 1}</span>
                    <div className="guide-body">
                      <b>{step.title}</b>
                      <p>{step.desc}</p>
                      {!step.done && (step.blocked
                        ? <span className="guide-hint">{step.blocked}</span>
                        : step.run
                          ? <button type="button" className="link" onClick={step.run}>{step.action}</button>
                          : step.to
                            ? <Link to={step.to}>{step.action}</Link>
                            : null)}
                    </div>
                  </div>
                );
              })}
            </div>
          </Card>

          <Card className="activity">
            <CardTitle extra={<Link className="link" to="/tasks">{t("全部")}</Link>}>{t("最近活动")}</CardTitle>
            <div className="rail-list">
              {db.logs.slice(0, 5).map((l) => (
                <div className="rail-row" key={l.id}>
                  <div>
                    <b>{l.action}</b>
                    <small>{l.object} · {new Date(l.at).toLocaleTimeString("zh-CN")}</small>
                  </div>
                  <span className={`dot ${l.result === "OK" ? "dot-ok" : "dot-bad"}`} />
                </div>
              ))}
              {db.logs.length === 0 && <Empty text={t("还没有活动。")} />}
            </div>
          </Card>
        </aside>
      </div>

      <CreateTaskModal open={createOpen} onClose={() => setCreateOpen(false)} />

      <Modal
        open={attachOpen}
        title={t("接入主机")}
        onClose={closeAttach}
        width={520}
        footer={
          <>
            <Button onClick={closeAttach}>{t("取消")}</Button>
            <Button variant="primary" onClick={attachHost} disabled={attachBusy || !attachId}>
              {attachBusy ? t("接入中…") : t("接入")}
            </Button>
          </>
        }
      >
        <div className="stack">
          <Field
            label={t("主机")}
            hint={t("只列出已经接入控制面的主机；接入后会挂到当前主机下。")}
          >
            {attachCandidates.length === 0 ? (
              <Callout tone="warn">{t("没有可接入的主机。")}</Callout>
            ) : (
              <select className="input" value={attachId} onChange={(e) => setAttachId(e.target.value)}>
                <option value="">{t("选择主机…")}</option>
                {attachCandidates.map((h) => (
                  <option key={h.id} value={h.id}>
                    {h.name} · {h.state} · ΣW {h.subtree_score ?? 0}
                  </option>
                ))}
              </select>
            )}
          </Field>
          {attachError && <Callout tone="bad">{attachError}</Callout>}
        </div>
      </Modal>

      {addOpen && (
        <Modal
          open
          title={t("添加")}
          onClose={() => {
            setAddOpen(false);
            setAddUnder(null);
          }}
          width={520}
        >
          <div className="add-role-grid">
            <button
              type="button"
              className="add-role-card"
              disabled={!host}
              onClick={() => chooseRole("builder")}
            >
              <Character role="builder" state="idle" size={56} flat />
              <b>{t("构建机")}</b>
              <small>{t("执行任务")}</small>
            </button>
            <button
              type="button"
              className="add-role-card"
              disabled={!host}
              onClick={() => chooseRole("scheduler")}
            >
              <Character role="scheduler" state="idle" size={56} flat />
              <b>{t("调度机")}</b>
              <small>{t("接收与派发")}</small>
            </button>
            <button
              type="button"
              className="add-role-card"
              onClick={() => {
                setAddOpen(false);
                setAddUnder(null);
                setAttachOpen(true);
              }}
            >
              <span className="add-role-icon"><Icon name="server" size={28} /></span>
              <b>{t("接入主机")}</b>
              <small>{t("已连接的主机")}</small>
            </button>
          </div>
        </Modal>
      )}

      {builderChoiceOpen && host && (
        <DeployBuilderModal
          host={host}
          onClose={() => setBuilderChoiceOpen(false)}
          onDone={async () => {
            if (live.connected) await live.refresh();
          }}
        />
      )}

      {addRole === "builder" && host && (
        <CreateBuilderModal
          open
          defaultHostId={host.id}
          defaultSchedulerId={addUnder ?? undefined}
          onClose={closeAdd}
          onCreated={async () => {
            await live.refresh();
            closeAdd();
          }}
        />
      )}

      {addRole === "scheduler" && host && (
        <DeploySchedulerModal
          host={host}
          schedulers={hostSchedulers.filter((i) => i.host_id === host.id)}
          {...(addUnder ? { initialRole: "node" as const, initialParentId: addUnder } : {})}
          onClose={closeAdd}
          onDone={async () => {
            await live.refresh();
            closeAdd();
          }}
        />
      )}
    </div>
  );
}
