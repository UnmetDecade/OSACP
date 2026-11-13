import { t } from "../i18n";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { db } from "../store";
import { useHostScope } from "../host-context";
import { useLive } from "../live/context";
import { errorMessage } from "../live/client";
import { bootstrapHost, probeHost, unmergeHost } from "../api";
import { Badge, Button, Callout, Card, CardTitle, Empty, KeyVal, PageHead, Tag } from "../components/ui";
import { Icon } from "../components/Icon";
import { DeleteHostModal, HostSettingsModal, MergeHostModal, probeHint } from "./Hosts";

/**
 * Host detail: everything that acts on a machine lives here (settings, probe, bootstrap, federation,
 * deletion), so the host list stays a readable summary instead of a wall of buttons.
 */
export function HostShow() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const live = useLive();
  const { host: current, setHostId } = useHostScope();
  const host = db.hosts.find((h) => h.id === id);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState<{ tone: "info" | "warn" | "bad"; text: string; log?: string } | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  if (!host) {
    return (
      <div className="page">
        <Card><Empty text={t("主机不存在或已被删除。")} /></Card>
        <p style={{ marginTop: 12 }}><Link className="link" to="/hosts">{t("返回主机列表")}</Link></p>
      </div>
    );
  }

  const components = db.instances.filter((i) => i.host_id === host.id);
  const parent = host.parent_host_id ? db.hosts.find((h) => h.id === host.parent_host_id) : undefined;
  const children = db.hosts.filter((h) => h.parent_host_id === host.id);
  const subtreeScore = host.subtree_score ?? 0;
  const roleMode = host.role_mode ?? "containers";
  const probe = host.last_probe;
  const probeOk = probe?.ok === true;
  const address = host.address || host.name;
  const isCurrent = current?.id === host.id;
  const canManage = host.transport === "local" || host.transport === "ssh";

  async function probeNow() {
    setBusy("probe");
    setError("");
    try {
      await probeHost(host!.id, live.refresh);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy("");
    }
  }

  async function bootstrap() {
    setBusy("bootstrap");
    setError("");
    setNotice(null);
    try {
      const out = await bootstrapHost(host!.id, live.refresh);
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

  async function unmerge() {
    if (!parent) return;
    if (!window.confirm(t("解除 {host} 与 {parent} 的并入关系？{host} 将重新成为联邦树的根，不再向上汇总能力。容器不会重启。", { host: host!.name, parent: parent.name }))) return;
    setBusy("unmerge");
    setError("");
    try {
      await unmergeHost(host!.id, live.refresh);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="page page-host">
      <Link className="back" to="/hosts"><Icon name="back" size={13} />{t("主机")}</Link>
      <PageHead
        title={
          <>
            {host.name}
            <Badge value={host.state} />
            {isCurrent && <Tag tone="accent">{t("当前")}</Tag>}
          </>
        }
        meta={
          <>
            <span>{host.os} {host.arch}</span>
            <span className="sep" />
            <span>Docker {host.runtime_version.replace(/^docker\s+/i, "")}</span>
            <span className="sep" />
            <span>{host.cpu_total}C / {Math.round(host.mem_total_mb / 1024)} GiB</span>
          </>
        }
        actions={
          <>
            {!isCurrent && (
              <Button onClick={() => setHostId(host.id)}>
                <Icon name="check" size={14} />
                {t("设为当前主机")}
              </Button>
            )}
            {canManage && (
              <>
                <Button onClick={() => setSettingsOpen(true)}>
                  <Icon name="settings" size={14} />
                  {t("设置")}
                </Button>
                <Button onClick={probeNow} disabled={busy === "probe"}>
                  <Icon name="refresh" size={14} />
                  {busy === "probe" ? t("探测中…") : t("探测")}
                </Button>
                <Button onClick={bootstrap} disabled={busy === "bootstrap"}>
                  <Icon name="play" size={14} />
                  {busy === "bootstrap"
                    ? t("准备环境…")
                    : host.state === "ONLINE"
                      ? t("重新引导")
                      : t("启动 runtime")}
                </Button>
              </>
            )}
            {/* A folded host keeps only "Unfold"; to change parents, unfold and fold it again. */}
            {parent ? (
              <Button onClick={unmerge} disabled={busy === "unmerge"}>
                <Icon name="unlink" size={14} />
                {t("解除并入")}
              </Button>
            ) : (
              <Button onClick={() => setMergeOpen(true)}>
                <Icon name="layers" size={14} />
                {t("并入")}
              </Button>
            )}
            <Button variant="danger" onClick={() => setDeleteOpen(true)}>
              <Icon name="trash" size={13} />
              {t("删除")}
            </Button>
          </>
        }
      />

      {error && <Callout tone="bad">{error}</Callout>}
      {notice && (
        <Callout tone={notice.tone}>
          {notice.text}
          {notice.log && <pre className="payload" style={{ marginTop: 10, marginBottom: 0 }}>{notice.log}</pre>}
        </Callout>
      )}

      {/*
        This page fits the viewport instead of scrolling: reachability, identity and capacity stack in
        the left column, while the federation tree and the component list share the right one, where
        the list takes every pixel left over. Only card interiors scroll, and only when the window is
        too short for their content.
      */}
      <div className="host-detail-grid">
        <div className="host-cell">
          {/* The access card is a status strip: its values are short, and stacking them as rows cost the
              component list the height it now owns. */}
          {host.transport === "ssh" ? (
            <Card>
              <CardTitle>{t("SSH 访问")}</CardTitle>
              <pre className="code-block ssh-block">
                {`ssh -p ${host.ssh_port ?? 22} ${host.ssh_user ?? "root"}@${address}`}
              </pre>
              <div className="host-strip">
                <span><em>{t("认证")}</em>{host.auth_type === "key" ? t("私钥") : host.auth_type === "password" ? t("密码") : "-"}</span>
                <span className="sep" />
                <span><em>{t("指纹")}</em><code>{host.key_fingerprint ?? "-"}</code></span>
              </div>
            </Card>
          ) : (
            <Card>
              <CardTitle>{t("探测结果")}</CardTitle>
              <div className="host-strip">
                {probe ? (
                  <Tag tone={probeOk ? "ok" : "bad"}>{probeOk ? t("可达") : t("不可达")}</Tag>
                ) : (
                  <span className="muted">{t("尚未探测")}</span>
                )}
                <span className="sep" />
                <span>{probe ? (probe.docker_version ?? (probe.docker ? t("已安装") : t("未安装"))) : "-"}</span>
                <span className="sep" />
                <span className="muted">{probe ? new Date(probe.checked_at).toLocaleString("zh-CN") : "-"}</span>
              </div>
              {probe && !probeOk && (
                <div className="inline-note text-bad">{t("失败原因")}：{probeHint(probe.error)}</div>
              )}
            </Card>
          )}

          <Card>
            <CardTitle>{t("主机信息")}</CardTitle>
            <div className="kv-list">
              <KeyVal label={t("主机 ID")}>{host.id}</KeyVal>
              <KeyVal label={t("基础系统")}>{host.os} · {host.arch}</KeyVal>
              <KeyVal label="Docker">{host.runtime_version}</KeyVal>
              <KeyVal label={t("主机角色")}>
                {roleMode === "containers"
                  ? t("容器宿主")
                  : roleMode === "builder"
                    ? t("裸机构建机")
                    : t("裸机调度机")}
              </KeyVal>
              <KeyVal label={t("接入方式")}>
                {host.transport === "local" ? t("本地") : host.transport === "ssh" ? "SSH" : t("手工")}
              </KeyVal>
              <KeyVal label={t("注册时间")}>{new Date(host.registered_at).toLocaleString("zh-CN")}</KeyVal>
              <KeyVal label={t("最后上报")}>
                {host.last_report_at ? new Date(host.last_report_at).toLocaleString("zh-CN") : "-"}
              </KeyVal>
            </div>
          </Card>

          <Card>
            <CardTitle>{t("资源")}</CardTitle>
            <div className="metric-row"><span>CPU</span><div className="meter"><div className="meter-fill meter-ok" style={{ width: `${host.cpu}%` }} /></div><em>{host.cpu}%</em></div>
            <div className="metric-row"><span>{t("内存")}</span><div className="meter"><div className="meter-fill meter-ok" style={{ width: `${host.mem}%` }} /></div><em>{host.mem}%</em></div>
            <div className="metric-row"><span>{t("磁盘")}</span><div className="meter"><div className="meter-fill meter-ok" style={{ width: `${host.disk}%` }} /></div><em>{host.disk}%</em></div>
            <div className="kv-list" style={{ marginTop: 12 }}>
              <KeyVal label={t("处理器")}>{host.cpu_total}C</KeyVal>
              <KeyVal label={t("内存总量")}>{Math.round(host.mem_total_mb / 1024)} GiB</KeyVal>
              <KeyVal label={t("可用内存")}>{Math.round(host.mem_available_mb / 1024)} GiB</KeyVal>
            </div>
          </Card>
        </div>

        <div className="host-cell host-cell-list">
          <Card>
            <CardTitle>{t("联邦树")}</CardTitle>
            <div className="kv-list">
              <KeyVal label={t("上级主机")}>{parent ? parent.name : t("无（本机是根）")}</KeyVal>
              <KeyVal label={t("下级主机")}>
                {children.length === 0 ? "-" : children.map((c) => c.name).join(" · ")}
              </KeyVal>
              <KeyVal label={t("本机 ΣW")}>{host.local_score ?? 0}</KeyVal>
              <KeyVal label={t("本机与下级 ΣW")}>{subtreeScore}</KeyVal>
            </div>
          </Card>

          <Card>
            <CardTitle extra={<Link className="link" to="/builders">{t("查看构建机")}</Link>}>
              {t("组件")} · {components.length}
            </CardTitle>
            {components.length === 0 ? (
              <Empty text={t("这台主机上还没有组件。")} />
            ) : (
              <div className="rail-list">
                {components.map((c) => (
                  <Link
                    className="rail-row"
                    key={c.id}
                    to={c.role === "scheduler" ? `/scheduler/${c.id}` : `/builders/${c.id}`}
                  >
                    <div>
                      <b>{c.name}</b>
                      <small>{c.role === "scheduler" ? t("调度机") : t("构建机")} · {c.state}</small>
                    </div>
                    <Badge value={c.state} />
                  </Link>
                ))}
              </div>
            )}
          </Card>
        </div>
      </div>

      <HostSettingsModal
        host={settingsOpen ? host : null}
        onClose={() => setSettingsOpen(false)}
        onDone={async () => {
          if (live.connected) await live.refresh();
        }}
      />
      <MergeHostModal
        host={mergeOpen ? host : null}
        onClose={() => setMergeOpen(false)}
        onDone={async () => {
          if (live.connected) await live.refresh();
          setMergeOpen(false);
        }}
      />
      <DeleteHostModal
        host={deleteOpen ? host : null}
        onClose={() => setDeleteOpen(false)}
        onDone={async () => {
          if (live.connected) await live.refresh();
        }}
        onDeleted={() => navigate("/hosts")}
      />
    </div>
  );
}
