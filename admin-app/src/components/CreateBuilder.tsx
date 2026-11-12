import { t } from "../i18n";
import { useEffect, useState } from "react";
import { db } from "../store";
import { errorMessage } from "../live/client";
import { BUILDER_OS, type BuilderOs, type Instance } from "../types";
import { createBuilder, type BuilderDraft } from "../api";
import { Button, Callout, Field, Modal, Tag } from "./ui";
import { Icon } from "./Icon";

// 档位文案在渲染时再翻译；模块级常量只求值一次，不能在这里调 t()。
const PRESETS = [
  { id: "small", label: "轻量", cpus: 1, mem: 2048, disk: 16, note: "小脚本 / 对话" },
  { id: "medium", label: "标准", cpus: 2, mem: 4096, disk: 32, note: "日常编译" },
  { id: "large", label: "重型", cpus: 4, mem: 8192, disk: 64, note: "内核 / 大型工程" },
];

/**
 * 新建构建机：只在 AI Agent 工作室里打开。
 * 构建机必须挂到目标主机的一台调度机上，默认根调度机。
 */
export function CreateBuilderModal({
  open,
  defaultHostId,
  defaultSchedulerId,
  onClose,
  onCreated,
}: {
  open: boolean;
  defaultHostId?: string;
  /** 从某台结点调度机的「＋」进来时，默认挂到它下面。 */
  defaultSchedulerId?: string;
  onClose: () => void;
  onCreated: () => Promise<void>;
}) {
  const builderAgents = db.agents.filter((a) => a.enabled !== false && a.role === "builder");
  const deployableHosts = db.hosts.filter((h) => h.state === "ONLINE" || h.state === "WARNING");
  const [hostId, setHostId] = useState(defaultHostId ?? "");
  const [os, setOs] = useState<BuilderOs>("ubuntu22.04");
  const [preset, setPreset] = useState("medium");
  const [customCpus, setCustomCpus] = useState(2);
  const [customMem, setCustomMem] = useState(4096);
  const [customDisk, setCustomDisk] = useState(32);
  const [count, setCount] = useState(1);
  const [name, setName] = useState("");
  const [agent, setAgent] = useState(builderAgents[0]?.id ?? "");
  const [apis, setApis] = useState<string[]>([]);
  const selectedApi =
    apis[0] && db.apis.some((a) => a.id === apis[0]) ? apis[0] : db.apis[0]?.id ?? "";
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (open) {
      setError("");
      if (!db.agents.find((a) => a.id === agent && a.role === "builder")) {
        setAgent(db.agents.find((a) => a.role === "builder" && a.enabled !== false)?.id ?? "");
      }
      // 弹窗固定在工作台当前主机上，不再让用户在这里换主机。
      if (defaultHostId) {
        setHostId(defaultHostId);
      } else if (!deployableHosts.some((h) => h.id === hostId)) {
        setHostId(deployableHosts[0]?.id ?? "");
      }
    }
    // deployableHosts 每次同步都会重建；用 host id 列表做依赖，避免打开弹窗时反复重置。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, agent, defaultHostId, deployableHosts.map((h) => h.id).join(",")]);

  const targetHost = db.hosts.find((h) => h.id === hostId);
  const hostOnline = targetHost?.state === "ONLINE" || targetHost?.state === "WARNING";
  const availMb = targetHost?.mem_available_mb ?? 0;
  // 控制面按「可用内存」做准入；开弹窗时落到能装下的最大档位，避免提交后才报错。
  useEffect(() => {
    if (!open || availMb <= 0) return;
    const fits = [...PRESETS].reverse().find((x) => x.mem * count <= availMb);
    if (fits) setPreset(fits.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, hostId, count, availMb]);

  // 构建机必须挂到本机的一台调度机上。父结点不再让用户选：
  // 从哪台调度机的「＋」进来就挂哪台；没有指定时用主机入口（根）。
  const hostSchedulers = db.instances
    .filter((i) => i.role === "scheduler" && i.host_id === hostId)
    .sort((a, b) =>
      (a.scheduler_role ?? "root") === (b.scheduler_role ?? "root")
        ? a.name.localeCompare(b.name)
        : (a.scheduler_role ?? "root") === "root" ? -1 : 1,
    );
  // 控制面用 deployment_id 引用调度机；实例名只用于显示。
  const refOf = (s: Instance | undefined) => s?.deployment_id ?? s?.id ?? "";
  const selectedScheduler =
    (defaultSchedulerId
      ? hostSchedulers.find((s) => refOf(s) === defaultSchedulerId)
      : undefined) ??
    hostSchedulers.find((s) => (s.scheduler_role ?? "root") === "root") ??
    hostSchedulers[0];

  const base = PRESETS.find((x) => x.id === preset) ?? PRESETS[1];
  const p = preset === "custom"
    ? { id: "custom", label: t("自定义"), cpus: customCpus, mem: customMem, disk: customDisk, note: t("自定义档位") }
    : base;
  async function submit() {
    setBusy(true);
    setError("");
    try {
      if (!Number.isFinite(p.cpus) || p.cpus < 0.5 || p.cpus > 16) {
        throw new Error(t("CPU 需在 0.5–16 核之间"));
      }
      if (!Number.isInteger(p.mem) || p.mem < 512 || p.mem > 65536 || p.mem % 128 !== 0) {
        throw new Error(t("内存需为 128MiB 的整数倍，范围 512–65536 MiB"));
      }
      if (!Number.isInteger(p.disk) || p.disk < 8 || p.disk > 1024) {
        throw new Error(t("磁盘需在 8–1024 GiB 之间"));
      }
      if (!hostId) throw new Error(t("先选择一台在线主机，或到「主机」页添加主机"));
      if (!selectedScheduler) throw new Error(t("主机 {name} 还没有调度机，先部署调度机", { name: targetHost?.name ?? "" }));
      const draft: BuilderDraft = {
        host_id: hostId,
        name: name.trim() || undefined,
        os,
        count,
        tier: preset,
        cpus: p.cpus,
        mem_mb: p.mem,
        disk_gb: p.disk,
        agent_profile_id: agent,
        api_profile_ids: selectedApi ? [selectedApi] : [],
        scheduler_id: refOf(selectedScheduler),
      };
      await createBuilder(draft, onCreated);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      title={t("新建构建机")}
      onClose={onClose}
      width={720}
      footer={
        <>
          <Button onClick={onClose}>{t("取消")}</Button>
          <Button
            variant="primary"
            onClick={submit}
            disabled={busy || !agent || !hostId || !selectedScheduler || !hostOnline}
          >
            {busy ? t("创建中…") : t("创建 {count} 台", { count })}
          </Button>
        </>
      }
    >
      <div className="stack">
        {targetHost && !hostOnline && (
          <Callout tone="warn">{t("这台主机还没上线，不能部署容器。")}</Callout>
        )}
        {hostSchedulers.length === 0 && (
          <Callout tone="warn">{t("这台主机还没有调度机，先部署根调度机。")}</Callout>
        )}

        <Field label={t("基础系统")}>
          <div className="os-grid">
            {BUILDER_OS.map((item) => {
              // 只有 digest 固定且已构建的镜像能真正部署；其余暂不可选。
              const pinned = item.image.includes("@sha256:");
              return (
              <button
                key={item.id}
                className={`select-card${os === item.id ? " selected" : ""}`}
                disabled={!pinned}
                onClick={() => setOs(item.id)}
              >
                <span className="select-head">
                  <b>{t(item.label)}</b>
                  {!pinned ? (
                    <Tag tone="warn">{t("待构建")}</Tag>
                  ) : item.preview ? (
                    <Tag tone="warn">preview</Tag>
                  ) : (
                    <Tag tone="ok">LTS</Tag>
                  )}
                </span>
                <code>{item.tag}</code>
                <small className="footnote">{t(item.note)}</small>
              </button>
              );
            })}
          </div>
        </Field>

        <Field
          label={t("资源档位")}
          hint={availMb > 0 ? t("{tier} · 可用 {mem}G", { tier: t(p.note), mem: (availMb / 1024).toFixed(1) }) : t(p.note)}
        >
          <div className="tier-grid">
            {PRESETS.map((item) => {
              const active = preset === item.id;
              const overflow = availMb > 0 && item.mem * count > availMb;
              return (
                <button
                  key={item.id}
                  type="button"
                  className={`tier-card${active ? " selected" : ""}`}
                  aria-pressed={active}
                  disabled={overflow}
                  title={overflow ? t("可用内存不足（{mem}G）", { mem: (availMb / 1024).toFixed(1) }) : undefined}
                  onClick={() => setPreset(item.id)}
                >
                  <span className="tier-check"><Icon name="check" size={11} /></span>
                  <b>{t(item.label)}</b>
                  <span className="tier-spec">{item.cpus}C / {item.mem / 1024}G</span>
                  <small>{t(item.note)}</small>
                </button>
              );
            })}
            <button
              type="button"
              className={`tier-card${preset === "custom" ? " selected" : ""}`}
              aria-pressed={preset === "custom"}
              onClick={() => setPreset("custom")}
            >
              <span className="tier-check"><Icon name="check" size={11} /></span>
              <b>{t("自定义")}</b>
              <span className="tier-spec">{t("自己填")}</span>
              <small>{t("CPU / 内存 / 磁盘")}</small>
            </button>
          </div>
        </Field>

        {preset === "custom" && (
          <div className="row">
            <Field label={t("CPU（核）")} hint={t("0.5–16，可填小数")}>
              <input
                className="input"
                type="number"
                min={0.5}
                max={16}
                step={0.5}
                value={customCpus}
                onChange={(e) => setCustomCpus(Number(e.target.value))}
              />
            </Field>
            <Field label={t("内存（MiB）")} hint={t("512–65536，128 的倍数")}>
              <input
                className="input"
                type="number"
                min={512}
                max={65536}
                step={128}
                value={customMem}
                onChange={(e) => setCustomMem(Number(e.target.value))}
              />
            </Field>
            <Field label={t("磁盘（GiB）")} hint="8–1024">
              <input
                className="input"
                type="number"
                min={8}
                max={1024}
                step={1}
                value={customDisk}
                onChange={(e) => setCustomDisk(Number(e.target.value))}
              />
            </Field>
          </div>
        )}

        <div className="row">
          <div className="shrink">
            <Field label={t("数量")}>
              <select className="input" value={count} onChange={(e) => setCount(Number(e.target.value))}>
                {[1, 2, 3, 4].map((n) => <option key={n} value={n}>{t("{count} 台", { count: n })}</option>)}
              </select>
            </Field>
          </div>
          <Field label={t("名称")}>
            <input
              className="input"
              value={name}
              maxLength={32}
              placeholder="builder-a"
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
        </div>

        <Field label="Agent">
          <select className="input" value={agent} onChange={(e) => setAgent(e.target.value)}>
            {builderAgents.map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
        </Field>

        <Field label="API">
          <select
            className="input"
            value={selectedApi}
            onChange={(e) => setApis(e.target.value ? [e.target.value] : [])}
          >
            {db.apis.length === 0 && <option value="">—</option>}
            {db.apis.map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
        </Field>

        {error && <Callout tone="bad">{error}</Callout>}
      </div>
    </Modal>
  );
}
