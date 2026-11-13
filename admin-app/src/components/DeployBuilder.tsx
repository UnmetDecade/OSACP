import { useState } from "react";
import { t } from "../i18n";
import { db } from "../store";
import { editHost, fetchHostDeployments } from "../api";
import { errorMessage } from "../live/client";
import { useLive } from "../live/context";
import type { Host } from "../types";
import { Button, Callout, Field, Modal } from "./ui";

/**
 * Deploy builder: first explain the trade-off between container and bare-metal builders, then pick one.
 *
 * A container builder uses the existing CreateBuilderModal; a bare-metal builder switches the host role to builder,
 * and the control plane automatically creates and starts a native builder process on the host. The native path has
 * its own form (name, Agent, API) so the instance is not created with hidden defaults.
 */
export function DeployBuilderModal({
  host,
  onClose,
  onDone,
}: {
  host: Host;
  onClose: () => void;
  onDone: () => Promise<void> | void;
}) {
  const live = useLive();
  const builderAgents = db.agents.filter((a) => a.enabled !== false && a.role === "builder");
  const [step, setStep] = useState<"choice" | "native">("choice");
  const [name, setName] = useState("");
  const [agent, setAgent] = useState("");
  const [apiProfile, setApiProfile] = useState("");
  const [busy, setBusy] = useState<"container" | "native" | null>(null);
  const [notice, setNotice] = useState<{ tone: "warn" | "bad"; text: string } | null>(null);
  const [done, setDone] = useState<string | null>(null);

  // Fall back to the first enabled builder Agent / the empty API option when the stored choice disappears.
  const selectedAgent = builderAgents.some((a) => a.id === agent)
    ? agent
    : builderAgents[0]?.id ?? "";
  const selectedApi = db.apis.some((a) => a.id === apiProfile) ? apiProfile : "";

  /** Turn the host's failed command acknowledgement into an operator-readable reason. */
  function deploymentError(observed: any): string {
    const err = observed?.error;
    if (!err || typeof err !== "object") return t("主机没有执行部署命令，请在主机页重试。");
    const code = String(err.code ?? "DEPLOY_FAILED");
    const message = String(err.message ?? "");
    return message ? `${code}：${message}` : code;
  }

  /**
   * Wait until the builder actually registers, or the host reports why it could not start.
   * Returns as soon as either answer is known; a timeout is reported as "not online yet", never as success.
   */
  async function waitForBuilder(deploymentId: string): Promise<{ ok: boolean; text: string }> {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2000));
      const deps = await fetchHostDeployments(host.id).catch(() => []);
      const dep = deps.find((d) => d.deployment_id === deploymentId);
      if (dep?.status === "FAILED") {
        return {
          ok: false,
          text: t("构建机部署失败：{reason}", { reason: deploymentError(dep.observed) }),
        };
      }
      if (live.connected) await live.refresh().catch(() => undefined);
      const inst = db.instances.find(
        (i) => i.host_id === host.id && i.deployment_id === deploymentId,
      );
      if (inst?.state === "ONLINE") {
        return { ok: true, text: t("裸机构建机已上线（{name}），可以接任务了。", { name: inst.name }) };
      }
    }
    return {
      ok: false,
      text: t("构建机已创建，但 60 秒内没有上线；请到工作室查看主机状态和日志。"),
    };
  }

  async function deployNative() {
    setBusy("native");
    setNotice(null);
    try {
      const displayName = name.trim();
      const out = await editHost(
        host.id,
        {
          role_mode: "builder",
          native_builder: {
            ...(displayName ? { display_name: displayName } : {}),
            ...(selectedAgent ? { agent_profile_id: selectedAgent } : {}),
            api_profile_ids: selectedApi ? [selectedApi] : [],
          },
        },
        async () => {
          if (live.connected) await live.refresh();
        },
      );
      if (out.warning) {
        setNotice({
          tone: "warn",
          text: t("主机角色已切换，但裸机构建机没有启动：{reason}", { reason: out.warning }),
        });
        return;
      }
      if (out.native_builder) {
        // Creating the deployment only records desired state; wait for the host to apply it and the builder to register,
        // otherwise the dialog reports success for a builder that silently never started.
        setDone(t("裸机构建机已创建，正在等待主机上报…"));
        const outcome = await waitForBuilder(out.native_builder.deployment_id);
        setDone(outcome.ok ? outcome.text : null);
        if (!outcome.ok) setNotice({ tone: "bad", text: outcome.text });
        return;
      }
      setDone(t("这台主机已经是裸机构建机。"));
    } catch (e) {
      setNotice({ tone: "bad", text: errorMessage(e) });
    } finally {
      setBusy(null);
    }
  }

  const footer = done ? (
    <Button
      variant="primary"
      onClick={() => {
        void onDone();
        onClose();
      }}
    >
      {t("完成")}
    </Button>
  ) : step === "choice" ? (
    <>
      <Button onClick={onClose} disabled={busy !== null}>
        {t("取消")}
      </Button>
      <Button variant="primary" onClick={() => setStep("native")} disabled={busy !== null}>
        {t("部署裸机构建机")}
      </Button>
    </>
  ) : (
    <>
      <Button onClick={onClose} disabled={busy !== null}>
        {t("取消")}
      </Button>
      <Button variant="primary" onClick={() => void deployNative()} disabled={busy !== null}>
        {busy === "native" ? t("部署中…") : t("部署裸机构建机")}
      </Button>
    </>
  );

  return (
    <Modal open title={t("部署构建机")} onClose={onClose} width={720} footer={footer}>
      {step === "choice" ? (
        <div className="builder-choice">
          <section className="builder-choice-card">
            <header>
              <b>{t("容器构建机")}</b>
            </header>
            <p>{t("Agent 跑在 Docker 容器里，和主机系统隔离。")}</p>
            <ul className="builder-points">
              <li className="is-pro">{t("一台主机可以跑多台，容量按需分配")}</li>
              <li className="is-pro">{t("镜像固定，依赖干净，坏了删掉重建即可")}</li>
              <li className="is-pro">{t("任务之间互不影响，适合标准构建")}</li>
              <li className="is-con">{t("需要 Docker，主机内核和设备能力受限")}</li>
              <li className="is-con">{t("启动和磁盘有额外开销")}</li>
              <li className="is-con">{t("容器里看不到主机上的进程和设备")}</li>
            </ul>
          </section>

          <section className="builder-choice-card">
            <header>
              <b>{t("裸机构建机")}</b>
            </header>
            <p>{t("Agent 直接跑在主机上，不经 Docker。")}</p>
            <ul className="builder-points">
              <li className="is-pro">{t("直接使用主机 CPU、GPU、网络和设备")}</li>
              <li className="is-pro">{t("没有容器开销，能跑 Docker 里跑不了的命令")}</li>
              <li className="is-pro">{t("终端直接登录主机，排查问题方便")}</li>
              <li className="is-con">{t("一台主机只能当构建机，不能再跑容器角色")}</li>
              <li className="is-con">{t("没有 CPU / 内存隔离，任务会争抢资源")}</li>
              <li className="is-con">{t("依赖主机已装好的环境，迁移和回滚更重")}</li>
            </ul>
          </section>
        </div>
      ) : (
        <div className="stack">
          <Callout tone="info">
            {t("裸机构建机会把主机角色切换为构建机；同一台主机不能再跑容器角色。")}
          </Callout>
          <Field label={t("名称")} hint={t("留空时按主机生成唯一名称")}>
            <input
              className="input"
              value={name}
              maxLength={32}
              placeholder={host.name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Field label="Agent">
            <select className="input" value={selectedAgent} onChange={(e) => setAgent(e.target.value)}>
              {builderAgents.length === 0 && <option value="">—</option>}
              {builderAgents.map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
          </Field>
          <Field label={t("API（可选）")}>
            <select className="input" value={selectedApi} onChange={(e) => setApiProfile(e.target.value)}>
              <option value="">—</option>
              {db.apis.map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
          </Field>
          {builderAgents.length === 0 && (
            <Callout tone="warn">
              {t("还没有可用的 Agent Profile，部署后只执行确定性 Shell 任务。")}
            </Callout>
          )}
        </div>
      )}

      {notice && <Callout tone={notice.tone}>{notice.text}</Callout>}
      {done && <Callout tone="info">{done}</Callout>}
    </Modal>
  );
}
