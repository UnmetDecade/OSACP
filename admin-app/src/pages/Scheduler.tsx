import { t } from "../i18n";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { db } from "../store";
import { useHostScope } from "../host-context";
import { groupByHost, hostTreeIds } from "../host-tree";
import { Character } from "../components/Character";
import { HostFold } from "../components/HostFold";
import { Badge, Card, Empty, PageHead, Tag } from "../components/ui";
import { Icon } from "../components/Icon";
import type { Instance } from "../types";

/**
 * 调度机列表：本机这一棵子树（本机根 + 同机结点 + 并入主机的根）。
 * 和构建机列表一样只放列表，点进去才看队列、Agent 和配置。
 */
export function SchedulerPage() {
  const { host } = useHostScope();
  const [query, setQuery] = useState("");
  const [state, setState] = useState("ALL");

  // 直接打开页面时首屏还没有主机；db.hosts 是原地替换的，用 id 签名做依赖才能重算。
  const hostKey = db.hosts.map((h) => h.id).join(",");
  const hostById = useMemo(() => new Map(db.hosts.map((h) => [h.id, h])), [hostKey]);
  const treeRoot = host ? hostById.get(host.id) : undefined;

  // 并入主机在外部看是本机根下的结点，所以调度台把它们一起列出来。
  const scopedHostIds = useMemo(() => hostTreeIds(treeRoot?.id), [treeRoot, hostById]);

  const schedulers = db.instances.filter(
    (i) => i.role === "scheduler" && (!treeRoot || scopedHostIds.has(i.host_id)),
  );
  const shown = schedulers.filter((s) => {
    if (state !== "ALL" && s.state !== state) return false;
    const q = query.trim().toLowerCase();
    return !q || s.name.toLowerCase().includes(q) || (s.id ?? "").toLowerCase().includes(q);
  });
  // 本机根永远第一；结点与并入主机的根（对外也是结点）排在后面。
  const externalRank = (s: Instance) => {
    const internalRoot = (s.scheduler_role ?? "root") === "root";
    if (internalRoot && s.host_id === treeRoot?.id) return 0;
    return 1;
  };
  const ordered = [...shown].sort(
    (a, b) =>
      externalRank(a) - externalRank(b) ||
      a.host_id.localeCompare(b.host_id) ||
      a.name.localeCompare(b.name),
  );

  const rootByHost = useMemo(() => {
    const map = new Map<string, Instance>();
    for (const s of schedulers) {
      if ((s.scheduler_role ?? "root") !== "root") continue;
      map.set(s.host_id, s);
    }
    return map;
  }, [schedulers]);

  const subtreeScore = treeRoot
    ? db.fleet.hosts.find((h) => h.host_id === treeRoot.id)?.subtree_score ??
      db.instances
        .filter((i) => i.role === "builder" && scopedHostIds.has(i.host_id))
        .reduce((sum, b) => sum + (b.capability_score ?? 0), 0)
    : 0;

  function buildersOf(s: Instance): Instance[] {
    // 按实例名归属：调度机重启会换 deployment_id，构建机手里可能还是旧的。
    const fallback = rootByHost.get(s.host_id)?.id;
    return db.instances.filter(
      (b) =>
        b.role === "builder" &&
        b.host_id === s.host_id &&
        (b.scheduler_instance_id ?? fallback) === s.id,
    );
  }

  if (!host || !treeRoot) {
    return (
      <div className="page">
        <PageHead title={t("调度机")} />
        <Card><Empty text={t("先在主机页添加主机。")} /></Card>
      </div>
    );
  }

  // 每台主机一组、按主机名折叠；本机默认展开，并入主机默认收起。
  const groups = groupByHost(ordered, treeRoot.id);
  const filtering = query.trim() !== "" || state !== "ALL";

  const renderRow = (s: Instance) => {
    const internalRole = s.scheduler_role ?? "root";
    const h = hostById.get(s.host_id);
    // 并入主机的根，在本机视角里就是父主机根下的一个结点。
    const merged = internalRole === "root" && s.host_id !== treeRoot.id;
    const externalNode = internalRole === "node" || merged;
    const parent = s.parent_scheduler_id
      ? db.instances.find(
          (p) =>
            p.role === "scheduler" &&
            p.host_id === s.host_id &&
            (s.parent_scheduler_instance_id
              ? p.id === s.parent_scheduler_instance_id
              : (p.deployment_id ?? p.id) === s.parent_scheduler_id),
        )
      : merged && h?.parent_host_id
        ? rootByHost.get(h.parent_host_id)
        : undefined;
    const list = buildersOf(s);
    const w = list
      .filter((b) => b.state === "ONLINE")
      .reduce((sum, b) => sum + (b.capability_score ?? 0), 0);
    const agent = db.agents.find((a) => a.id === s.agent_profile_id);
    const offline = s.state !== "ONLINE";
    return (
      <div className="list-row" key={s.key}>
        <Character role="scheduler" state={offline ? "offline" : "idle"} size={32} flat />
        <div className="list-main">
          <div className="list-title">
            <Link className="strong" to={`/scheduler/${s.id}`}>{s.name}</Link>
            <Badge value={s.state} />
            <Tag tone={externalNode ? "accent" : "ok"}>{externalNode ? t("结点") : t("根")}</Tag>
          </div>
          <div className="list-meta">
            <span>{s.port ? `:${s.port}` : t("未分配端口")}</span>
            {externalNode && (
              <span>{parent ? `← ${parent.name}` : t("父调度机缺失")}</span>
            )}
            <span>{s.cpu_limit}C / {Math.round(s.mem_limit_mb / 1024)}G</span>
            <span>{t("{count} 构建机", { count: list.length })}</span>
            <span>ΣW {w}</span>
            <span>{agent?.name ?? t("未绑定 Agent")}</span>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="page">
      <PageHead
        title={t("调度机")}
        meta={
          <>
            <span>{treeRoot.name}</span>
            <span className="sep" />
            <span>{t("{count} 个", { count: schedulers.length })}</span>
            <span className="sep" />
            <span>{t("{count} 在线", { count: schedulers.filter((s) => s.state === "ONLINE").length })}</span>
            <span className="sep" />
            <span>ΣW {subtreeScore}</span>
          </>
        }
      />

      <div className="toolbar">
        <div className="search">
          <Icon name="search" size={14} />
          <input className="input" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("按名称或 ID 搜索")} />
        </div>
        <div className="segmented">
          {["ALL", "ONLINE", "SUSPECT", "OFFLINE"].map((s) => (
            <button key={s} className={`segment${state === s ? " active" : ""}`} onClick={() => setState(s)}>
              {s === "ALL" ? t("全部") : s}
              <em>{s === "ALL" ? schedulers.length : schedulers.filter((x) => x.state === s).length}</em>
            </button>
          ))}
        </div>
      </div>

      {ordered.length === 0 ? (
        <Card><Empty text={t("{host} 上还没有匹配的调度机。到总览的 AI Agent 工作室添加。", { host: treeRoot.name })} /></Card>
      ) : (
        <Card flush>
          <div className="list">
            {groups.length > 1 ? (
              groups.map((g) => (
                <HostFold
                  key={g.hostId}
                  name={g.name}
                  label={t("{count} 个", { count: g.items.length })}
                  foldKey={`scheduler:${g.hostId}`}
                  defaultOpen={g.current}
                  forceOpen={filtering}
                >
                  {g.items.map(renderRow)}
                </HostFold>
              ))
            ) : (
              // 只有一台主机（没有并入主机）时不用折叠，列表直接铺开。
              groups[0]?.items.map(renderRow)
            )}
          </div>
        </Card>
      )}
    </div>
  );
}
