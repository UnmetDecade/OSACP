import { t } from "../i18n";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { db } from "../store";
import { useHostScope } from "../host-context";
import { useLive } from "../live/context";
import { errorMessage } from "../live/client";
import {
  addHost,
  bootstrapHost,
  editHost,
  mergeHost,
  probeHost,
  removeHostContainers,
  removeHostFromList,
  unmergeHost,
  type HostDraft,
} from "../api";
import type { Host, HostProbe, HostRoleMode } from "../types";
import { Badge, Button, Callout, Card, Empty, Field, Modal, PageHead, Tag } from "../components/ui";
import { Icon } from "../components/Icon";

/**
 * Hosts page: one host = one machine running Docker; schedulers and builders are containers on it.
 * The local host is the machine running the admin app; remote hosts are onboarded over SSH and the private key is stored encrypted by PCS.
 */

/** On probe failure, give an actionable reason instead of dumping raw ssh output on the user. */
function probeHint(error?: string): string {
  if (!error) return t("未知错误");
  if (/Permission denied \(publickey/i.test(error)) {
    return t("远程主机拒绝了这把私钥：公钥还没加入远程机的 ~/.ssh/authorized_keys，或私钥有口令/不完整。");
  }
  if (/Host key verification failed/i.test(error)) {
    return t("远程主机的 SSH 指纹和记录不一致，先确认这台机器没有被替换。");
  }
  if (/timed out|ETIMEDOUT/i.test(error)) {
    return t("连接超时：检查地址、端口和防火墙。");
  }
  if (/Connection refused|ECONNREFUSED/i.test(error)) {
    return t("端口拒绝连接：确认 sshd 正在监听这个端口。");
  }
  return error;
}
export function HostsPage() {
  const live = useLive();
  const [addOpen, setAddOpen] = useState(false);
  const [settingsTarget, setSettingsTarget] = useState<Host | null>(null);
  const [mergeTarget, setMergeTarget] = useState<Host | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Host | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState<{ tone: "info" | "warn" | "bad"; text: string; log?: string } | null>(null);

  const { host: current, setHostId } = useHostScope();
  const hosts = db.hosts;
  const local = hosts.filter((h) => h.transport === "local").length;
  const online = hosts.filter((h) => h.state === "ONLINE").length;

  async function probe(id: string) {
    setBusy(`${id}:probe`);
    setError("");
    try {
      await probeHost(id, live.refresh);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy("");
    }
  }

  async function unmerge(host: Host) {
    const parent = host.parent_host_id
      ? hosts.find((h) => h.id === host.parent_host_id)?.name ?? host.parent_host_id
      : t("上级主机");
    if (!window.confirm(t("解除 {host} 与 {parent} 的并入关系？{host} 将重新成为联邦树的根，不再向上汇总能力。容器不会重启。", { host: host.name, parent }))) return;
    setBusy(`${host.id}:unmerge`);
    setError("");
    try {
      await unmergeHost(host.id, live.refresh);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy("");
    }
  }

  async function bootstrap(id: string) {
    setBusy(`${id}:bootstrap`);
    setError("");
    setNotice(null);
    try {
      const out = await bootstrapHost(id, live.refresh);
      setNotice(
        out.online
          ? { tone: "info", text: t("host-runtime 已启动，主机已入网，可以部署组件了。") }
          : {
              tone: "warn",
              text: t("host-runtime 已启动，但主机还没入网（{status}）。检查下面的日志。", { status: out.status }),
              log: out.log,
            },
      );
    } catch (e) {
      setNotice({ tone: "bad", text: errorMessage(e) });
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="page">
      <PageHead
        title={t("主机")}
        meta={
          <>
            <span>{t("{count} 台", { count: hosts.length })}</span>
            <span className="sep" />
            <span>{t("{count} 在线", { count: online })}</span>
            <span className="sep" />
            <span>{t("本地 {count}", { count: local })}</span>
            {db.fleet.total_score > 0 && (
              <>
                <span className="sep" />
                <span>ΣW {db.fleet.total_score}</span>
              </>
            )}
          </>
        }
        actions={
          <Button variant="primary" onClick={() => setAddOpen(true)}>
            <Icon name="plus" size={14} />
            {t("添加主机")}
          </Button>
        }
      />

      {error && <Callout tone="bad">{error}</Callout>}
      {notice && (
        <Callout tone={notice.tone}>
          {notice.text}
          {notice.log && <pre className="payload" style={{ marginTop: 10, marginBottom: 0 }}>{notice.log}</pre>}
        </Callout>
      )}

      {hosts.length === 0 ? (
        <Card>
          <Empty text={t("还没有主机。先添加运行管理页面的本地主机，或通过 SSH 接入一台远程机器。")} />
        </Card>
      ) : (
        <Card flush>
          <div className="list">
            {hosts.map((h) => (
              <HostRow
                key={h.id}
                host={h}
                current={h.id === current?.id}
                onSelect={setHostId}
                busy={busy}
                onProbe={probe}
                onBootstrap={bootstrap}
                onSettings={setSettingsTarget}
                onMerge={setMergeTarget}
                onUnmerge={unmerge}
                onDelete={setDeleteTarget}
              />
            ))}
          </div>
        </Card>
      )}

      <AddHostModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onDone={async () => {
          if (live.connected) await live.refresh();
        }}
      />

      <HostSettingsModal
        host={settingsTarget}
        onClose={() => setSettingsTarget(null)}
        onDone={async () => {
          if (live.connected) await live.refresh();
        }}
      />

      <DeleteHostModal
        host={deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onDone={async () => {
          if (live.connected) await live.refresh();
        }}
      />

      <MergeHostModal
        host={mergeTarget}
        onClose={() => setMergeTarget(null)}
        onDone={async () => {
          if (live.connected) await live.refresh();
          setMergeTarget(null);
        }}
      />

    </div>
  );
}

function HostRow({
  host,
  current,
  onSelect,
  busy,
  onProbe,
  onBootstrap,
  onSettings,
  onMerge,
  onUnmerge,
  onDelete,
}: {
  host: Host;
  current: boolean;
  onSelect: (id: string) => void;
  busy: string;
  onProbe: (id: string) => void;
  onBootstrap: (id: string) => void;
  onSettings: (host: Host) => void;
  onMerge: (host: Host) => void;
  onUnmerge: (host: Host) => void;
  onDelete: (host: Host) => void;
}) {
  const components = db.instances.filter((i) => i.host_id === host.id);
  const parent = host.parent_host_id ? db.hosts.find((h) => h.id === host.parent_host_id) : undefined;
  const subtreeScore = host.subtree_score ?? 0;
  const roleMode = host.role_mode ?? "containers";
  const probe = host.last_probe;
  const probeOk = probe?.ok === true;
  const address = host.address || host.name;
  const probeDetail = probe
    ? `${probeOk
        ? t("Docker {version}{perm}", { version: probe.docker_version ?? t("已安装"), perm: probe.docker_ok === false ? t("（无 Docker 权限）") : "" })
        : probeHint(probe.error)} · ${new Date(probe.checked_at).toLocaleString("zh-CN")}${host.key_fingerprint ? ` · ${host.key_fingerprint}` : ""}`
    : undefined;

  return (
    <div className="list-row">
      <div className="list-main">
        <div className="list-title">
          <button className="list-name" onClick={() => onSelect(host.id)} title={t("切换到这个主机")}>
            {host.name}
          </button>
          {current && <Tag tone="accent">{t("当前")}</Tag>}
          <Badge value={host.state} />
          <Tag tone={host.transport === "local" ? "accent" : undefined}>
            {host.transport === "local" ? t("本地") : host.transport === "ssh" ? "SSH" : t("手工")}
          </Tag>
          {roleMode !== "containers" && (
            <Tag tone="warn">{roleMode === "builder" ? t("裸机构建机") : t("裸机调度机")}</Tag>
          )}
          {parent && <Tag title={t("并入的上级主机")}>{t("并入 {host}", { host: parent.name })}</Tag>}
          {subtreeScore > 0 && (
            <Tag tone="accent" title={t("本机与全部下级构建机的 ΣW")}>
              ΣW {subtreeScore}
            </Tag>
          )}
          {probe && (
            <Tag tone={probeOk ? "ok" : "bad"} title={probeDetail}>
              {probeOk ? t("可达") : t("不可达")}
            </Tag>
          )}
        </div>
        <div className="list-meta">
          <span>{host.os} {host.arch}</span>
          <span>Docker {host.runtime_version.replace(/^docker\s+/i, "")}</span>
          {host.transport === "ssh" && (
            <code>{host.ssh_user ?? "root"}@{address}:{host.ssh_port ?? 22}</code>
          )}
          <span className="sep" />
          <span>{host.cpu_total}C / {Math.round(host.mem_total_mb / 1024)}G</span>
          {host.local_score ? <span>{t("本机 W {score}", { score: host.local_score })}</span> : null}
          <span>CPU {host.cpu}%</span>
          <span>{t("内存 {pct}%", { pct: host.mem })}</span>
          <span>{t("磁盘 {pct}%", { pct: host.disk })}</span>
        </div>
        <div className="list-meta">
          {components.length === 0 ? (
            <span>{t("无组件")}</span>
          ) : (
            components.map((c) => (
              <Link
                key={c.id}
                className="tag"
                to={c.role === "scheduler" ? "/scheduler" : `/builders/${c.id}`}
                title={c.name}
              >
                {c.role === "scheduler" ? t("调度机容器") : t("构建机容器")} · {c.name}
              </Link>
            ))
          )}
        </div>
      </div>
      <div className="list-actions">
        {(host.transport === "local" || host.transport === "ssh") && (
          <>
            <Button size="sm" onClick={() => onSettings(host)} title={t("修改名称、地址或密钥")}>
              <Icon name="settings" size={13} />
              {t("设置")}
            </Button>
            <Button size="sm" onClick={() => onProbe(host.id)} disabled={busy === `${host.id}:probe`}>
              <Icon name="refresh" size={13} />
              {busy === `${host.id}:probe` ? t("探测中…") : t("探测")}
            </Button>
            <Button
              size="sm"
              onClick={() => onBootstrap(host.id)}
              disabled={busy === `${host.id}:bootstrap`}
              title={t("补齐 Node / Docker 并启动 host-runtime")}
            >
              <Icon name="play" size={13} />
              {busy === `${host.id}:bootstrap`
                ? t("准备环境…")
                : host.state === "ONLINE"
                  ? t("重新引导")
                  : t("启动 runtime")}
            </Button>
          </>
        )}
        {/* A folded host keeps only "Unfold"; to change parents, unfold and fold it again. */}
        {!parent && (
          <Button size="sm" onClick={() => onMerge(host)} title={t("把本机并入另一台主机的联邦树")}>
            <Icon name="layers" size={13} />
            {t("并入")}
          </Button>
        )}
        {parent && (
          <Button
            size="sm"
            onClick={() => onUnmerge(host)}
            disabled={busy === `${host.id}:unmerge`}
            title={t("解除并入，本机重新成为根")}
          >
            <Icon name="unlink" size={13} />
            {t("解除")}
          </Button>
        )}
        <Button
          variant="danger"
          size="sm"
          onClick={() => onDelete(host)}
          title={t("删除主机上的容器，或整台主机连同数据一起清除")}
        >
          <Icon name="trash" size={13} />
          {t("删除")}
        </Button>
      </div>
    </div>
  );
}

/**
 * Delete host: remove checked containers one by one, or delete the whole host.
 *
 * Single deletion removes only containers and data volumes; "Delete all" waits for the host to confirm every container is removed
 * before deleting the host record, after which the host disappears from the list. A mid-way failure preserves the state and shows the reason.
 */
function DeleteHostModal({
  host,
  onClose,
  onDone,
}: {
  host: Host | null;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [clearData, setClearData] = useState(false);
  const [busy, setBusy] = useState<"" | "all" | "list">("");
  const [error, setError] = useState("");
  const containers = host ? db.instances.filter((i) => i.host_id === host.id) : [];
  const allSelected = containers.length > 0 && selected.length === containers.length;

  useEffect(() => {
    setSelected([]);
    setClearData(false);
    setBusy("");
    setError("");
  }, [host?.id]);

  if (!host) return null;

  function toggle(id: string) {
    setSelected((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  }

  async function remove(ids: string[], purge: boolean, kind: "all" | "list") {
    const ask = purge
      ? ids.length
        ? t("删除 {host} 上的全部 {count} 个容器与数据卷，并清除主机数据？不可恢复。", { host: host!.name, count: ids.length })
        : t("清除 {host} 的主机数据并把它从列表中移除吗？", { host: host!.name })
      : ids.length
        ? t("把 {host} 从列表中移除？勾选的 {count} 个容器会连同数据卷一起删除，其余容器和数据保留。", { host: host!.name, count: ids.length })
        : t("把 {host} 从列表中移除？容器和数据都会保留，下次接入同一台主机可以直接使用。", { host: host!.name });
    if (!window.confirm(ask)) return;
    setBusy(kind);
    setError("");
    try {
      if (kind === "list") await removeHostFromList(host!.id, ids, onDone);
      else await removeHostContainers(host!.id, ids, purge, onDone);
      onClose();
    } catch (e) {
      setError(errorMessage(e));
      setBusy("");
    }
  }

  return (
    <Modal
      open
      title={t("删除主机 · {name}", { name: host.name })}
      onClose={onClose}
      width={560}
      footer={
        <>
          <Button onClick={onClose} disabled={Boolean(busy)}>{t("取消")}</Button>
          <Button
            variant={clearData ? "danger" : "primary"}
            onClick={() =>
              clearData
                ? remove(containers.map((c) => c.id), true, "all")
                : remove(selected, false, "list")
            }
            disabled={Boolean(busy)}
          >
            {busy === "all" || busy === "list"
              ? t("正在处理…")
              : clearData
                ? t("全部删除并清除数据")
                : t("从列表移除")}
          </Button>
        </>
      }
    >
      <div className="stack">
        <Callout tone="warn">
          {t("从列表移除会保留未勾选的容器和数据，下次接入同一台主机可以直接使用；勾选下方选项则删除全部容器并清除主机记录。")}
        </Callout>

        <div className="list-title">
          <b>{t("容器")} · {containers.length}</b>
          {containers.length > 0 && (
            <button
              type="button"
              className="link"
              onClick={() => setSelected(allSelected ? [] : containers.map((c) => c.id))}
              disabled={Boolean(busy) || clearData}
            >
              {allSelected ? t("取消全选") : t("全选")}
            </button>
          )}
        </div>

        {containers.length === 0 ? (
          <Empty text={t("这台主机上还没有容器。")} />
        ) : (
          <div className="stack" style={{ gap: 6, maxHeight: 320, overflowY: "auto" }}>
            {containers.map((c) => {
              const checked = selected.includes(c.id);
              return (
                <label key={c.key} className={`check-row${checked ? " checked" : ""}`}>
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={Boolean(busy) || clearData}
                    onChange={() => toggle(c.id)}
                  />
                  <div>
                    <b>{c.name}</b>
                    <span className="small">
                      {" · "}{c.role === "scheduler" ? t("调度机容器") : t("构建机容器")} · {c.state}
                    </span>
                  </div>
                </label>
              );
            })}
          </div>
        )}

        <label className={`check-row${clearData ? " checked" : ""}`}>
          <input
            type="checkbox"
            checked={clearData}
            disabled={Boolean(busy)}
            onChange={() => setClearData((v) => !v)}
          />
          <div>
            <b>{t("同时删除容器并清除数据")}</b>
            <span className="small">
              {" · "}{t("容器、数据卷和主机记录都会被删除，不可恢复")}
            </span>
          </div>
        </label>

        {error && <Callout tone="bad">{error}</Callout>}
      </div>
    </Modal>
  );
}

/** Host settings: change the name, address, port, user, or replace the private key; re-probe immediately after saving. */
function HostSettingsModal({
  host,
  onClose,
  onDone,
}: {
  host: Host | null;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [port, setPort] = useState(22);
  const [user, setUser] = useState("root");
  const [password, setPassword] = useState("");
  const [key, setKey] = useState("");
  const [roleMode, setRoleMode] = useState<HostRoleMode>("containers");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [probe, setProbe] = useState<HostProbe | null>(null);
  const [saved, setSaved] = useState(false);
  // After switching to a bare-metal builder, the control plane also starts a builder process; the result is reported separately.
  const [roleNotice, setRoleNotice] = useState<{ tone: "info" | "warn"; text: string } | null>(null);

  useEffect(() => {
    if (!host) return;
    setName(host.name);
    setAddress(host.address ?? "");
    setPort(host.ssh_port ?? 22);
    setUser(host.ssh_user ?? "root");
    setRoleMode(host.role_mode ?? "containers");
    setPassword("");
    setKey("");
    setError("");
    setProbe(null);
    setSaved(false);
    setRoleNotice(null);
    setBusy(false);
  }, [host?.id]);

  if (!host) return null;

  const ssh = host.transport === "ssh";

  async function submit() {
    setBusy(true);
    setError("");
    try {
      const out = await editHost(
        host!.id,
        ssh
          ? {
              name: name.trim() || undefined,
              address: address.trim(),
              port,
              user: user.trim() || "root",
              role_mode: roleMode,
              // Leaving it empty keeps the existing credential; filling in a private key switches to key auth.
              ...(key.trim() ? { private_key: key } : password ? { password } : {}),
            }
          : { name: name.trim() || undefined, role_mode: roleMode },
        onDone,
      );
      setProbe(out.probe ?? null);
      setRoleNotice(
        out.warning
          ? { tone: "warn", text: t("角色已切换，但裸机构建机没有启动：{reason}", { reason: out.warning }) }
          : out.native_builder
            ? {
                tone: "info",
                text: t("裸机构建机已创建（{status}），主机上报后即可接任务。", {
                  status: out.native_builder.status,
                }),
              }
            : null,
      );
      setSaved(true);
      // The credential is submitted only this once; clear it from memory right after saving.
      setPassword("");
      setKey("");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  function close() {
    setPassword("");
    setKey("");
    onClose();
  }

  return (
    <Modal
      open
      title={t("主机设置")}
      onClose={close}
      width={620}
      footer={
        saved ? (
          <Button variant="primary" onClick={close}>{t("完成")}</Button>
        ) : (
          <>
            <Button onClick={close}>{t("取消")}</Button>
            <Button
              variant="primary"
              onClick={submit}
              disabled={busy || (ssh && !address.trim())}
            >
              {busy ? t("保存中…") : t("保存并探测")}
            </Button>
          </>
        )
      }
    >
      <div className="stack">
        <Field label={t("显示名")}>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={ssh ? address || t("主机") : t("本地主机")} />
        </Field>

        <Field label={t("主机角色")} hint={t("裸机角色与容器二选一；同一台主机不能既是构建机又是调度机")}>
          <select
            className="input"
            value={roleMode}
            onChange={(e) => setRoleMode(e.target.value as HostRoleMode)}
          >
            <option value="containers">{t("容器宿主")}</option>
            <option value="builder">{t("裸机构建机")}</option>
            <option value="scheduler">{t("裸机调度机")}</option>
          </select>
        </Field>

        {ssh && (
          <>
            <div className="row">
              <Field label={t("地址")}>
                <input className="input" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="192.0.2.10" />
              </Field>
              <div className="shrink">
                <Field label={t("端口")}>
                  <input className="input" type="number" min={1} max={65535} value={port} onChange={(e) => setPort(Number(e.target.value))} />
                </Field>
              </div>
              <div className="shrink">
                <Field label={t("用户")}>
                  <input className="input" value={user} onChange={(e) => setUser(e.target.value)} placeholder="root" />
                </Field>
              </div>
            </div>
            <Field
              label={t("密码")}
              hint={
                host.auth_type === "password"
                  ? t("留空则沿用现有密码。")
                  : t("填密码会切换为密码登录；密码加密保存，不回显。")
              }
            >
              <input
                className="input"
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={t("留空不修改")}
              />
            </Field>
            <Field
              label={t("SSH 私钥")}
              hint={
                host.auth_type === "key"
                  ? host.key_fingerprint ? t("留空则沿用现有私钥（{fp}）。", { fp: host.key_fingerprint }) : t("留空则沿用现有私钥。")
                  : t("填私钥会切换为私钥登录。")
              }
            >
              <textarea
                className="input code-editor"
                rows={7}
                value={key}
                onChange={(e) => setKey(e.target.value)}
                placeholder={t("留空不修改，或粘贴新的私钥全文\n-----BEGIN OPENSSH PRIVATE KEY-----\n…")}
                spellCheck={false}
              />
            </Field>
          </>
        )}

        {saved && (
          <Callout tone={probe?.ok ? "info" : "warn"}>
            {probe?.ok
              ? t("已保存：{host}，Docker {docker}。", { host: probe.hostname ?? address, docker: probe.docker_version ?? t("已安装") })
              : t("已保存，但探测未通过：{reason}。", { reason: probeHint(probe?.error) })}
          </Callout>
        )}
        {saved && roleNotice && <Callout tone={roleNotice.tone}>{roleNotice.text}</Callout>}
        {error && <Callout tone="bad">{error}</Callout>}
      </div>
    </Modal>
  );
}

/**
 * Host fold: attach this host's root scheduler into another host's federation tree.
 * Only the control plane's parent_host_id changes; the local scheduling chain, containers and internal identity stay the same.
 */
function MergeHostModal({
  host,
  onClose,
  onDone,
}: {
  host: Host | null;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const [parentId, setParentId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!host) return;
    setParentId(host.parent_host_id ?? "");
    setBusy(false);
    setError("");
  }, [host?.id]);

  if (!host) return null;

  // Cannot fold into itself or its own descendants: the server blocks it too, but obviously invalid options are filtered out here.
  const descendants = new Set<string>();
  const collect = (id: string) => {
    for (const h of db.hosts) {
      if (h.parent_host_id === id) {
        descendants.add(h.id);
        collect(h.id);
      }
    }
  };
  collect(host.id);
  const candidates = db.hosts.filter((h) => h.id !== host.id && !descendants.has(h.id));

  async function submit() {
    if (!parentId) {
      setError(t("选择一台上级主机"));
      return;
    }
    setBusy(true);
    setError("");
    try {
      await mergeHost(host!.id, parentId, onDone);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      title={t("并入主机")}
      onClose={onClose}
      width={560}
      footer={
        <>
          <Button onClick={onClose}>{t("取消")}</Button>
          <Button variant="primary" onClick={submit} disabled={busy || !parentId}>
            {busy ? t("并入中…") : t("并入")}
          </Button>
        </>
      }
    >
      <div className="stack">
        <Field label={t("主机")}>
          <div className="list-title">
            <b>{host.name}</b>
            <Tag>{host.role_mode === "containers" ? t("容器宿主") : host.role_mode === "builder" ? t("裸机构建机") : t("裸机调度机")}</Tag>
          </div>
        </Field>
        <Field label={t("上级主机")} hint={t("上级必须已经部署根调度机")}>
          {candidates.length === 0 ? (
            <Callout tone="warn">{t("没有可并入的主机。")}</Callout>
          ) : (
            <select className="input" value={parentId} onChange={(e) => setParentId(e.target.value)}>
              <option value="">{t("选择上级主机…")}</option>
              {candidates.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.name} · {h.state} · ΣW {h.subtree_score ?? 0}
                </option>
              ))}
            </select>
          )}
        </Field>
        {error && <Callout tone="bad">{error}</Callout>}
      </div>
    </Modal>
  );
}

function AddHostModal({
  open,
  onClose,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const [transport, setTransport] = useState<"local" | "ssh">("local");
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [port, setPort] = useState(22);
  const [user, setUser] = useState("root");
  const [password, setPassword] = useState("");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [probe, setProbe] = useState<HostProbe | null>(null);
  const [created, setCreated] = useState(false);
  const [authKind, setAuthKind] = useState<"password" | "key" | null>(null);
  const [booting, setBooting] = useState(false);
  const [boot, setBoot] = useState<{ online: boolean; status: string; error?: string; log?: string } | null>(null);

  function reset() {
    setName("");
    setAddress("");
    setPort(22);
    setUser("root");
    setPassword("");
    setKey("");
    setError("");
    setProbe(null);
    setCreated(false);
    setAuthKind(null);
    setBooting(false);
    setBoot(null);
    setBusy(false);
  }

  async function submit() {
    setBusy(true);
    setError("");
    try {
      const input: HostDraft =
        transport === "local"
          ? { transport: "local", name: name.trim() || undefined }
          : {
              transport: "ssh",
              name: name.trim() || undefined,
              address: address.trim(),
              port,
              user: user.trim() || "root",
              // Private key wins; when both are filled, use the key and do not send the password.
              ...(key.trim()
                ? { private_key: key }
                : { password }),
            };
      if (transport === "ssh" && !address.trim()) throw new Error(t("请填写主机地址"));
      if (transport === "ssh" && !key.trim() && !password) {
        throw new Error(t("请填写密码或私钥"));
      }
      setAuthKind(transport === "ssh" && !key.trim() && password ? "password" : transport === "ssh" ? "key" : null);
      const out = await addHost(input, onDone);
      setProbe(out.probe ?? null);
      setCreated(true);
      // The credential is submitted once; clear it from memory immediately regardless of the probe result.
      setPassword("");
      setKey("");
      // On a successful probe, start the runtime at the same time to save a click; if that fails it can still be retried from the host row.
      if (out.probe?.ok) {
        setBooting(true);
        try {
          const b = await bootstrapHost(out.host_id, onDone);
          setBoot({ online: b.online, status: b.status, log: b.log });
        } catch (e) {
          setBoot({ online: false, status: "FAILED", error: errorMessage(e) });
        } finally {
          setBooting(false);
        }
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  function close() {
    reset();
    onClose();
  }

  return (
    <Modal
      open={open}
      title={t("添加主机")}
      onClose={close}
      width={620}
      footer={
        created ? (
          <Button variant="primary" onClick={close} disabled={booting}>
            {booting ? t("正在安装环境…") : t("完成")}
          </Button>
        ) : (
          <>
            <Button onClick={close}>{t("取消")}</Button>
            <Button
              variant="primary"
              onClick={submit}
              disabled={
                busy ||
                (transport === "ssh" && (!address.trim() || (!key.trim() && !password)))
              }
            >
              {busy ? (booting ? t("正在安装环境…") : t("接入中…")) : t("接入并启动")}
            </Button>
          </>
        )
      }
    >
      <div className="stack">
        {!created && (
          <Field label={t("接入方式")}>
            <div className="host-grid">
              <button
                type="button"
                className={`select-card${transport === "local" ? " selected" : ""}`}
                onClick={() => setTransport("local")}
              >
                <span className="select-head"><b>{t("本地主机")}</b><Tag tone="ok">{t("本机")}</Tag></span>
                <small className="footnote">{t("运行管理页面 / PCS 的机器，直接在本机执行 Docker。")}</small>
              </button>
              <button
                type="button"
                className={`select-card${transport === "ssh" ? " selected" : ""}`}
                onClick={() => setTransport("ssh")}
              >
                <span className="select-head"><b>{t("SSH 远程主机")}</b><Tag>ssh</Tag></span>
                <small className="footnote">{t("用私钥连接，要求已安装 Docker，当前用户能访问 Docker。")}</small>
              </button>
            </div>
          </Field>
        )}

        {!created && (
          <>
            <Field label={t("显示名")}>
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={transport === "local" ? t("本地主机") : t("例如 构建机-02")} />
            </Field>

            {transport === "ssh" && (
              <>
                <div className="row">
                  <Field label={t("地址")}>
                    <input className="input" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="192.0.2.10" />
                  </Field>
                  <div className="shrink">
                    <Field label={t("端口")}>
                      <input className="input" type="number" min={1} max={65535} value={port} onChange={(e) => setPort(Number(e.target.value))} />
                    </Field>
                  </div>
                  <div className="shrink">
                    <Field label={t("用户")}>
                      <input className="input" value={user} onChange={(e) => setUser(e.target.value)} placeholder="root" />
                    </Field>
                  </div>
                </div>
                <Field label={t("密码")} hint={t("加密保存，不回显。填了下面的私钥时以私钥为准。")}>
                  <input
                    className="input"
                    type="password"
                    autoComplete="new-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder={t("SSH 登录密码")}
                  />
                </Field>
                <Field
                  label={t("SSH 私钥")}
                  hint={t("可选，粘贴私钥全文；留空则用上面的密码登录。")}
                >
                  <textarea
                    className="input code-editor"
                    rows={7}
                    value={key}
                    onChange={(e) => setKey(e.target.value)}
                    placeholder={t("留空则用密码登录，或粘贴私钥全文\n-----BEGIN OPENSSH PRIVATE KEY-----\n…")}
                    spellCheck={false}
                  />
                </Field>
              </>
            )}

            {error && <Callout tone="bad">{error}</Callout>}
          </>
        )}

        {created && (
          <>
            <Callout tone={booting || boot?.online ? "info" : boot || !probe?.ok ? "warn" : "info"}>
              {booting
                ? authKind === "key" && probe?.ok && probe.docker === false
                  ? t("已接入，正在准备环境：远程主机缺少 Docker，私钥接入没有密码，只能靠免密 sudo 安装…")
                  : t("已接入，正在安装环境并启动 runtime…")
                : boot
                  ? boot.online
                    ? t("已接入，runtime 已启动，主机已入网。")
                    : t("已接入，但 runtime 启动失败：{reason}。可以在主机行点「启动 runtime」重试。", { reason: boot.error ?? t("主机未入网（{status}）", { status: boot.status }) })
                  : probe?.ok
                    ? t("已接入：{host}，Docker {docker}。", { host: probe.hostname ?? (address || t("本地主机")), docker: probe.docker_version ?? t("已安装") })
                    : t("主机已保存，但探测未通过：{reason}。", { reason: probeHint(probe?.error) })}
            </Callout>
            {boot?.log && (
              <pre className="payload" style={{ marginTop: 0 }}>{boot.log}</pre>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
