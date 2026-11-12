import { t } from "../i18n";
import { useState } from "react";
import { Link } from "react-router-dom";
import { db } from "../store";
import { useHostScope } from "../host-context";
import { groupByHost, hostTreeIds } from "../host-tree";
import type { Instance } from "../types";
import { characterState } from "../characters";
import { Character } from "../components/Character";
import { HostFold } from "../components/HostFold";
import { Badge, Card, Empty, PageHead, Tag } from "../components/ui";
import { Icon } from "../components/Icon";
import { osLabel } from "../api";

export function Builders() {
  const { host } = useHostScope();
  const [query, setQuery] = useState("");
  const [state, setState] = useState("ALL");

  // 和调度台一样按主机子树看：并入本机的主机上的构建机也一起列出来。
  const scopedHostIds = hostTreeIds(host?.id);
  const builders = db.instances.filter(
    (i) => i.role === "builder" && (!host || scopedHostIds.has(i.host_id)),
  );
  const shown = builders.filter((b) => {
    if (state !== "ALL" && b.state !== state) return false;
    const q = query.trim().toLowerCase();
    return !q || b.name.toLowerCase().includes(q) || (b.os ?? "").includes(q);
  });
  // 每台主机一组、按主机名折叠；本机默认展开，并入主机默认收起。
  const groups = groupByHost(shown, host?.id);
  const filtering = query.trim() !== "" || state !== "ALL";

  return (
    <div className="page">
      <PageHead
        title={t("构建机")}
        meta={
          <>
            <span>{host?.name ?? t("未选择主机")}</span>
            <span className="sep" />
            <span>{t("{count} 台", { count: builders.length })}</span>
            <span className="sep" />
            <span>{t("{count} 在线", { count: builders.filter((b) => b.state === "ONLINE").length })}</span>
          </>
        }
      />

      <div className="toolbar">
        <div className="search">
          <Icon name="search" size={14} />
          <input className="input" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("按名称或系统搜索")} />
        </div>
        <div className="segmented">
          {["ALL", "ONLINE", "SUSPECT", "OFFLINE"].map((s) => (
            <button key={s} className={`segment${state === s ? " active" : ""}`} onClick={() => setState(s)}>
              {s === "ALL" ? t("全部") : s}
              <em>{s === "ALL" ? builders.length : builders.filter((b) => b.state === s).length}</em>
            </button>
          ))}
        </div>
      </div>

      {shown.length === 0 ? (
        <Card><Empty text={host ? t("{host} 上还没有匹配的构建机。", { host: host.name }) : t("先添加一台主机。")} /></Card>
      ) : (
        <Card flush>
          <div className="list">
            {groups.length > 1 ? (
              groups.map((g) => (
                <HostFold
                  key={g.hostId}
                  name={g.name}
                  label={t("{count} 台", { count: g.items.length })}
                  foldKey={`builders:${g.hostId}`}
                  defaultOpen={g.current}
                  forceOpen={filtering}
                >
                  {g.items.map((b) => (
                    <BuilderRow key={b.key} builder={b} />
                  ))}
                </HostFold>
              ))
            ) : (
              // 只有一台主机（没有并入主机）时不用折叠，列表直接铺开。
              groups[0]?.items.map((b) => <BuilderRow key={b.key} builder={b} />)
            )}
          </div>
        </Card>
      )}
    </div>
  );
}

function BuilderRow({ builder }: { builder: Instance }) {
  const running = db.tasks.find((t) => t.instance_id === builder.id && t.state === "RUNNING");
  const agent = db.agents.find((a) => a.id === builder.agent_profile_id);
  // 构建机注册到指定调度机；旧数据没有 scheduler_id 时归本机根调度机。
  const hostRoot = db.instances.find(
    (i) =>
      i.role === "scheduler" &&
      i.host_id === builder.host_id &&
      (i.scheduler_role ?? "root") === "root",
  );
  // 按实例名归属；调度机重启换了 deployment_id 也能对上。
  const scheduler = db.instances.find(
    (i) =>
      i.role === "scheduler" &&
      i.host_id === builder.host_id &&
      i.id === (builder.scheduler_instance_id ?? hostRoot?.id),
  );
  return (
    <div className="list-row">
      <Character role="builder" state={characterState(builder, running)} size={32} flat />
      <div className="list-main">
        <div className="list-title">
          <Link className="strong" to={`/builders/${builder.id}`}>{builder.name}</Link>
          <Badge value={builder.state} />
          {builder.capability_score !== undefined && (
            <Tag tone="accent" title={t("工作能力值：调度机按任务难度选择构建机")}>
              W {builder.capability_score}
            </Tag>
          )}
        </div>
        <div className="list-meta">
          <span>{osLabel(builder.os)}</span>
          <span>{t("配置 v{version}", { version: builder.config_version })}</span>
          <span>{scheduler ? `→ ${scheduler.name}` : t("未分配调度机")}</span>
          <span>{agent?.name ?? t("未绑定 Agent")}</span>
          <span>{builder.cpu_limit}C / {Math.round(builder.mem_limit_mb / 1024)}G / {builder.disk_gb}G</span>
          {builder.ssh_port && <code>ssh :{builder.ssh_port}</code>}
          <span className="sep" />
          {running ? (
            <span className="list-live"><span className="dot dot-ok" />{running.title}</span>
          ) : (
            <span>{t("空闲")}</span>
          )}
        </div>
      </div>
    </div>
  );
}
