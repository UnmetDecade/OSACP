import { t } from "../i18n";
import { useState } from "react";
import { deployScheduler, type SchedulerDraft } from "../api";
import { errorMessage } from "../live/client";
import { db } from "../store";
import type { Host, Instance } from "../types";
import { Button, Callout, Field, Modal } from "./ui";

/** Keep digits only and strip leading zeros ("01" → "1"); keep the empty string so typing can continue. */
function intText(raw: string): string {
  return raw.replace(/[^\d]/g, "").replace(/^0+(?=\d)/, "");
}

/** Convert to a number on submit, fall back to the default when empty, and clamp to the allowed range. */
function intValue(raw: string, fallback: number, min: number, max: number): number {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * Deploy a scheduler on a host.
 *
 * Each host has at most one root scheduler (the external entry point), and multiple node scheduler containers can hang under it;
 * a node selects only a parent scheduler on the same host, and the parent's address and database are injected by the control plane.
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
  /** Existing schedulers on this host (root + nodes). */
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
  // The parent scheduler is referenced by deployment_id in the control plane, while the id shown in the UI is the instance name; do not mix them.
  const refOf = (s: Instance | undefined) => s?.deployment_id ?? s?.id ?? "";
  // The parent is determined by the entry point (whichever scheduler's "+" was used); without an entry point, it hangs under the root.
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
  // Numeric inputs are stored as strings so they can be cleared before retyping; convert them on submit.
  // Otherwise the field is written as 0 the moment it is cleared, and the next input becomes "01".
  // Multiple schedulers on one host each take a host port, continuing after the existing instances.
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
  // Only the root picks a mode; node schedulers and builders inherit it through the control plane.
  const [mode, setMode] = useState<"static" | "dynamic">(root?.scheduling_mode ?? "static");
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
        ...(role === "root" ? { scheduling_mode: mode } : {}),
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

            <Field
              label={t("调度模式")}
              hint={
                role === "root"
                  ? t("静态按部署时的 CPU / 内存预算分配；动态使用主机资源池，按运行压力实时下发配额")
                  : t("结点调度机继承根调度机的模式")
              }
            >
              {role === "root" ? (
                <div className="role-toggle">
                  <button
                    type="button"
                    className={`role-option${mode === "static" ? " selected" : ""}`}
                    onClick={() => setMode("static")}
                  >
                    <b>{t("静态")}</b>
                    <small>{t("固定预算，超卖不启用")}</small>
                  </button>
                  <button
                    type="button"
                    className={`role-option${mode === "dynamic" ? " selected" : ""}`}
                    onClick={() => setMode("dynamic")}
                  >
                    <b>{t("动态")}</b>
                    <small>{t("资源池 + cgroup 配额，支持超卖")}</small>
                  </button>
                </div>
              ) : (
                <div className="muted">
                  {t("继承根调度机：{mode}", { mode: root?.scheduling_mode === "dynamic" ? t("动态") : t("静态") })}
                </div>
              )}
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
