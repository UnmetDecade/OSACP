import { t } from "../i18n";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { db } from "../store";
import { useLive } from "../live/context";
import { errorMessage } from "../live/client";
import { characterState } from "../characters";
import { Character } from "../components/Character";
import { InstanceProfilesModal } from "../components/InstanceProfiles";
import { Badge, Button, Callout, Card, CardTitle, Empty, KeyVal, PageHead, Switch, Tag } from "../components/ui";
import { Icon } from "../components/Icon";
import { builderAction, osLabel, sshCommand, updateDeploymentFeatures } from "../api";

export function BuilderShow() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const live = useLive();
  const builder = db.instances.find((i) => i.id === id && i.role === "builder");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [profilesOpen, setProfilesOpen] = useState(false);

  if (!builder) {
    return (
      <div className="page">
        <Card><Empty text={t("构建机不存在或已被删除。")} /></Card>
        <p style={{ marginTop: 12 }}><Link className="link" to="/builders">{t("返回构建机列表")}</Link></p>
      </div>
    );
  }

  const running = db.tasks.find((t) => t.instance_id === builder.id && t.state === "RUNNING");
  const agent = db.agents.find((a) => a.id === builder.agent_profile_id);
  const recent = db.tasks.filter((t) => t.instance_id === builder.id).slice(0, 6);
  const ssh = sshCommand(builder.ssh_host, builder.ssh_port, builder.ssh_user);

  async function act(action: "start" | "stop" | "restart" | "remove") {
    if (action === "remove" && !window.confirm(t("删除 {name}？容器与数据卷都会被删除。", { name: builder!.name }))) return;
    setBusy(action);
    setError("");
    try {
      await builderAction(builder!.id, action, live.refresh, builder!.host_id);
      if (action === "remove") navigate("/builders");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy("");
    }
  }

  async function copySsh() {
    try {
      await navigator.clipboard.writeText(ssh);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setError(t("剪贴板不可用，请手动复制"));
    }
  }

  /** Toggling a capability recreates the container with the next generation; volumes survive. */
  async function toggleFeature(key: "ssh_enabled" | "chat_enabled", next: boolean) {
    setBusy(key);
    setError("");
    try {
      const features = key === "ssh_enabled" ? { ssh_enabled: next } : { chat_enabled: next };
      await updateDeploymentFeatures(builder!.id, features, live.refresh);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="page page-sched">
      <Link className="back" to="/builders"><Icon name="back" size={13} />{t("构建机")}</Link>
      <PageHead
        title={
          <>
            <Character role="builder" state={characterState(builder, running)} size={46} flat />
            {builder.name}
            <Badge value={builder.state} />
          </>
        }
        meta={
          <>
            <span>{osLabel(builder.os)}</span>
            <span className="sep" />
            <span>{builder.cpu_limit}C / {Math.round(builder.mem_limit_mb / 1024)} GiB / {builder.disk_gb}G</span>
            <span className="sep" />
            <span>{t("配置 v{version}", { version: builder.config_version })}</span>
          </>
        }
        actions={
          <>
            {builder.ssh_enabled !== false && (
              <Link className="btn" to={`/terminal?instance=${encodeURIComponent(builder.key)}`}>
                <Icon name="terminal" size={14} />
                {t("终端")}
              </Link>
            )}
            {builder.chat_enabled !== false && (
              <Link className="btn" to={`/chat?instance=${encodeURIComponent(builder.key)}`}>
                <Icon name="chat" size={14} />
                {t("对话")}
              </Link>
            )}
            <Link className="btn" to={`/builders/${builder.id}/files`}>
              <Icon name="folder" size={14} />
              {t("文件")}
            </Link>
            <Button onClick={() => setProfilesOpen(true)}>
              <Icon name="agent" size={14} />
              {t("配置 Agent")}
            </Button>
            <Button onClick={() => act("restart")} disabled={busy === "restart"}>
              <Icon name="refresh" size={14} />
              {t("重启")}
            </Button>
            <Button onClick={() => act(builder.state === "ONLINE" ? "stop" : "start")} disabled={busy === "stop" || busy === "start"}>
              <Icon name="stop" size={13} />
              {builder.state === "ONLINE" ? t("停止") : t("启动")}
            </Button>
            <Button variant="danger" onClick={() => act("remove")} disabled={busy === "remove"}>
              <Icon name="trash" size={13} />
              {t("删除")}
            </Button>
          </>
        }
      />

      {error && <Callout tone="bad">{error}</Callout>}

      {/* Same fixed-height layout as the scheduler page: runtime info and capability switches
          share the left card, the Agent/SSH card fills the right, and the bottom row takes the
          remaining height so the page itself never scrolls. */}
      <div className="sched-top">
        <Card>
          <CardTitle extra={<Tag tone="warn">{t("修改会重建容器")}</Tag>}>{t("运行信息")}</CardTitle>
          <div className="kv-list">
            <KeyVal label={t("实例 ID")}>{builder.id}</KeyVal>
            <KeyVal label={t("基础系统")}>{osLabel(builder.os)}</KeyVal>
            <KeyVal label={t("镜像")}><code className="digest">{builder.image}</code></KeyVal>
            <KeyVal label={t("资源")}>
              {builder.cpu_limit}C / {Math.round(builder.mem_limit_mb / 1024)} GiB / {builder.disk_gb}G
            </KeyVal>
            <KeyVal label={t("工作目录")}>
              <Link className="link" to={`/builders/${builder.id}/files`}>
                <code>{builder.workspace ?? "/opt/platform/workspace"}</code>
              </Link>
            </KeyVal>
            <KeyVal label={t("最后心跳")}>{new Date(builder.last_heartbeat).toLocaleString("zh-CN")}</KeyVal>
            <KeyVal label={t("创建时间")}>{new Date(builder.created_at).toLocaleString("zh-CN")}</KeyVal>
          </div>
          <div className="stack" style={{ marginTop: 12 }}>
            {builder.execution !== "native" && (
              <Switch
                checked={builder.ssh_enabled !== false}
                disabled={busy !== ""}
                onChange={() => void toggleFeature("ssh_enabled", builder.ssh_enabled === false)}
                label={t("SSH 访问（sshd 与端口映射）")}
              />
            )}
            <Switch
              checked={builder.chat_enabled !== false}
              disabled={busy !== ""}
              onChange={() => void toggleFeature("chat_enabled", builder.chat_enabled === false)}
              label={t("对话（task.chat.builder）")}
            />
            <div className="muted">
              {t("切换后控制面会重建这个容器；工作区卷保留，正在运行的任务会中断。")}
            </div>
          </div>
        </Card>

        <Card>
          <CardTitle
            extra={
              builder.ssh_enabled !== false && (
                <Button size="sm" onClick={copySsh}>
                  <Icon name={copied ? "check" : "copy"} size={13} />
                  {copied ? t("已复制") : t("复制")}
                </Button>
              )
            }
          >
            {t("构建 Agent 与 SSH")}
          </CardTitle>
          <div className="kv-list">
            <KeyVal label="Agent">{agent ? `${agent.name} · v${agent.version}` : t("未绑定")}</KeyVal>
            <KeyVal label={t("适配器")}><code>{agent?.adapter ?? "-"}</code></KeyVal>
            <KeyVal label="API">
              {builder.api_profile_ids
                .map((id) => db.apis.find((a) => a.id === id)?.name ?? id)
                .join(" · ") || "-"}
            </KeyVal>
          </div>
          {builder.ssh_enabled === false ? (
            <Callout tone="warn">{t("SSH 已在部署中关闭：容器内不启动 sshd，也没有端口映射。在左侧「运行信息」里开启会重建容器。")}</Callout>
          ) : (
            <>
              <pre className="code-block ssh-block" style={{ marginTop: 10 }}>{ssh}</pre>
              <div className="kv-list" style={{ marginTop: 10 }}>
                <KeyVal label={t("主机")}>{builder.ssh_host ?? "-"}</KeyVal>
                <KeyVal label={t("端口")}>{builder.ssh_port ?? "-"}</KeyVal>
                <KeyVal label={t("用户")}>root</KeyVal>
                <KeyVal label={t("认证")}>{builder.state === "OFFLINE" ? t("容器未运行") : t("密钥 / 密码（由平台下发）")}</KeyVal>
              </div>
            </>
          )}
        </Card>
      </div>

      <div className="grid-2 sched-split" style={{ marginTop: 12 }}>
        <Card>
          <CardTitle>{t("负载")}</CardTitle>
          <div className="metric-row"><span>CPU</span><div className="meter"><div className="meter-fill meter-ok" style={{ width: `${running ? 62 : 7}%` }} /></div><em>{running ? "62%" : "7%"}</em></div>
          <div className="metric-row"><span>{t("内存")}</span><div className="meter"><div className="meter-fill meter-ok" style={{ width: `${running ? 48 : 21}%` }} /></div><em>{running ? "48%" : "21%"}</em></div>
          <div className="metric-row"><span>{t("磁盘")}</span><div className="meter"><div className="meter-fill meter-ok" style={{ width: "30%" }} /></div><em>30%</em></div>
          <div className="instance-now" style={{ marginTop: 12 }}>
            {running ? <><span className="dot dot-ok" />{running.title}</> : <span className="muted">{t("空闲")}</span>}
          </div>
        </Card>

        <Card>
          <CardTitle extra={<Link className="link" to="/tasks">{t("全部任务")}</Link>}>{t("最近任务")}</CardTitle>
          <div className="rail-list">
            {recent.map((task) => (
              <Link className="rail-row" key={task.id} to={`/tasks/${task.id}`}>
                <div>
                  <b>{task.title}</b>
                  <small>{task.type} · {new Date(task.created_at).toLocaleString("zh-CN")}</small>
                </div>
                <Badge value={task.state} />
              </Link>
            ))}
            {recent.length === 0 && <div className="rail-empty">{t("还没有任务")}</div>}
          </div>
        </Card>
      </div>

      {profilesOpen && (
        <InstanceProfilesModal
          instance={builder}
          role="builder"
          onClose={() => setProfilesOpen(false)}
        />
      )}
    </div>
  );
}
