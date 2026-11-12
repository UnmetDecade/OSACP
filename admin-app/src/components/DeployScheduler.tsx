import { t } from "../i18n";
import { useState } from "react";
import { deployScheduler, type SchedulerDraft } from "../api";
import { errorMessage } from "../live/client";
import { db } from "../store";
import type { Host, Instance } from "../types";
import { Button, Callout, Field, Modal } from "./ui";

/** 只留数字，去掉前导零（"01" → "1"）；空串保留，方便继续输入。 */
function intText(raw: string): string {
  return raw.replace(/[^\d]/g, "").replace(/^0+(?=\d)/, "");
}

/** 提交时转数字，空值回落到默认值，并夹到允许区间。 */
function intValue(raw: string, fallback: number, min: number, max: number): number {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * 在一台主机上部署调度机。
 *
 * 每台主机最多一个根调度机（对外入口），根下面可以再挂多个结点调度机容器；
 * 结点只选择同一台主机上的父调度机，父的地址与数据库由控制面注入。
 */
export function DeploySchedulerModal({
  host,
  schedulers,
  initialRole,
  initialParentId,
  onClose,
  onDone,
}: {
  host: Host;
  /** 本主机现有的调度机（根 + 结点）。 */
  schedulers: Instance[];
  initialRole?: "root" | "node";
  initialParentId?: string;
  onClose: () => void;
  onDone: () => Promise<void> | void;
}) {
  const agents = db.agents.filter((a) => a.enabled !== false && a.role === "scheduler");
  const apis = db.apis.filter((a) => a.enabled !== false);
  const root = schedulers.find((s) => (s.scheduler_role ?? "root") === "root");
  const online = host.state === "ONLINE" || host.state === "WARNING";

  const [role, setRole] = useState<"root" | "node">(
    initialRole ?? (root ? "node" : "root"),
  );
  // 父调度机在控制面按 deployment_id 引用，界面上的 id 是实例名，不能直接混用。
  const refOf = (s: Instance | undefined) => s?.deployment_id ?? s?.id ?? "";
  // 父结点由入口决定（从哪台调度机的「＋」进来就挂哪台），没有入口时挂到根。
  const parent =
    (initialParentId
      ? schedulers.find((s) => refOf(s) === initialParentId)
      : undefined) ??
    root ??
    schedulers[0];
  const [name, setName] = useState(role === "root" ? "scheduler" : "node");
  const [nameTouched, setNameTouched] = useState(false);
  const [agent, setAgent] = useState("");
  const [api, setApi] = useState("");
  // 数字输入用字符串保存，允许清空后再输入；提交时再转成数字。
  // 否则清空的一瞬间会被写成 0，接着输入就变成 "01"。
  // 同一台主机上多台调度机各占一个宿主端口；从现有实例之后顺延。
  const [port, setPort] = useState(() => {
    const used = schedulers.map((s) => s.port ?? 0).filter((n) => n > 0);
    return String(Math.max(8443, ...used) + (used.length ? 1 : 0));
  });
  const [sshPort, setSshPort] = useState(() => {
    const used = db.instances.filter((i) => i.host_id === host.id).map((i) => i.ssh_port ?? 0);
    return String(Math.max(2200, ...used) + 1);
  });
  const [cpus, setCpus] = useState("2");
  const [mem, setMem] = useState("2048");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const selectedAgent =
    agent && agents.some((a) => a.id === agent) ? agent : agents[0]?.id ?? "";
  const agentModel = db.agents.find((a) => a.id === selectedAgent)?.model_api_profile_id;
  const preferredApi =
    apis.find((a) => a.id === agentModel)?.id ?? apis[0]?.id ?? "";
  const selectedApi = api && apis.some((a) => a.id === api) ? api : preferredApi;

  const blockedReason = !online
    ? t("这台主机还没上线")
    : role === "root" && root
      ? t("这台主机已有根调度机 {root}", { root: root.name })
      : role === "node" && !root
        ? t("先部署根调度机，再添加结点调度机")
        : "";
  const blocked = blockedReason !== "";

  function switchRole(next: "root" | "node") {
    setRole(next);
    if (!nameTouched) setName(next === "root" ? "scheduler" : "node");
    setError("");
  }

  async function submit() {
    if (blocked) {
      setError(blockedReason);
      return;
    }
    if (!selectedAgent) {
      setError(t("还没有可用的调度机 Agent"));
      return;
    }
    if (!selectedApi) {
      setError(t("还没有可用的 API"));
      return;
    }
    setBusy(true);
    setError("");
    try {
      const input: SchedulerDraft = {
        host_id: host.id,
        role,
        ...(role === "node" && parent ? { parent_scheduler_id: refOf(parent) } : {}),
        name: name.trim(),
        agent_profile_id: selectedAgent,
        api_profile_ids: [selectedApi],
        port: intValue(port, 8443, 1, 65535),
        ssh_port: intValue(sshPort, 2201, 1, 65535),
        cpus: intValue(cpus, 2, 1, 16),
        mem_mb: intValue(mem, 2048, 1024, 16384),
      };
      await deployScheduler(input, async () => {
        await onDone();
      });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      title={t("部署调度机 · {host}", { host: host.name })}
      onClose={onClose}
      width={620}
      footer={
        <>
          <Button onClick={onClose}>{t("取消")}</Button>
          <Button
            variant="primary"
            onClick={submit}
            disabled={busy || agents.length === 0 || blocked}
          >
            {busy ? t("部署中…") : role === "root" ? t("部署根调度机") : t("部署结点调度机")}
          </Button>
        </>
      }
    >
      <div className="stack">
        {!online && <Callout tone="warn">{t("这台主机还没上线，不能部署容器。")}</Callout>}
        {online && blocked && role === "root" && root && (
          <Callout tone="warn">{t("这台主机已有根调度机，可以在它下面添加结点调度机。")}</Callout>
        )}
        {online && role === "node" && !root && (
          <Callout tone="warn">{t("这台主机还没有根调度机。根是主机入口，必须先部署。")}</Callout>
        )}
        {agents.length === 0 ? (
          <Callout tone="warn">{t("还没有调度机 Agent。先创建 Agent Profile 再部署。")}</Callout>
        ) : (
          <>
            <Field label={t("角色")} hint={t("每台主机最多一个根；结点可以有很多个，逐个挂到父调度机下")}>
              <div className="role-toggle">
                <button
                  type="button"
                  className={`role-option${role === "root" ? " selected" : ""}`}
                  disabled={Boolean(root)}
                  onClick={() => switchRole("root")}
                >
                  <b>{t("根调度机")}</b>
                  <small>{root ? t("已有 {root}", { root: root.name }) : t("主机入口，接收任务")}</small>
                </button>
                <button
                  type="button"
                  className={`role-option${role === "node" ? " selected" : ""}`}
                  disabled={!root}
                  onClick={() => switchRole("node")}
                >
                  <b>{t("结点调度机")}</b>
                  <small>
                    {root
                      ? t("挂在 {name} 下", { name: parent?.name ?? root.name })
                      : t("先部署根调度机")}
                  </small>
                </button>
              </div>
            </Field>

            <Field label={t("名称")}>
              <input
                className="input"
                value={name}
                maxLength={32}
                placeholder={role === "root" ? t("调度机 / scheduler") : t("结点 / node")}
                onChange={(e) => {
                  setName(e.target.value);
                  setNameTouched(true);
                }}
              />
            </Field>

            <Field label="Agent">
              <select className="input" value={selectedAgent} onChange={(e) => setAgent(e.target.value)}>
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </select>
            </Field>

            <Field label="API">
              <select className="input" value={selectedApi} onChange={(e) => setApi(e.target.value)}>
                {apis.map((a) => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </select>
            </Field>

            <div className="row">
              <Field label={t("API 端口")}>
                <input
                  className="input"
                  type="number"
                  min={1}
                  max={65535}
                  step={1}
                  value={port}
                  onChange={(e) => setPort(intText(e.target.value))}
                />
              </Field>
              <Field label={t("SSH 端口")}>
                <input
                  className="input"
                  type="number"
                  min={1}
                  max={65535}
                  step={1}
                  value={sshPort}
                  onChange={(e) => setSshPort(intText(e.target.value))}
                />
              </Field>
              <Field label="CPU">
                <input
                  className="input"
                  type="number"
                  min={1}
                  max={16}
                  step={1}
                  value={cpus}
                  onChange={(e) => setCpus(intText(e.target.value))}
                />
              </Field>
              <Field label={t("内存 MiB")}>
                <input
                  className="input"
                  type="number"
                  min={1024}
                  max={16384}
                  step={1024}
                  value={mem}
                  onChange={(e) => setMem(intText(e.target.value))}
                />
              </Field>
            </div>
          </>
        )}

        {error && <Callout tone="bad">{error}</Callout>}
      </div>
    </Modal>
  );
}
