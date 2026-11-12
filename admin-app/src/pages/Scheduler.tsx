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
 * Scheduler list: this host's subtree (local root + same-host nodes + roots of folded hosts).
 * Like the builder list, it is list-only; queue, Agent and config appear after clicking through.
 */
export function SchedulerPage() {
  const { host } = useHostScope();
  const [query, setQuery] = useState("");
  const [state, setState] = useState("ALL");

  // On a direct page load there is no host on first paint; db.hosts is replaced in place, so depend on an id signature to recompute.
  const hostKey = db.hosts.map((h) => h.id).join(",");
  const hostById = useMemo(() => new Map(db.hosts.map((h) => [h.id, h])), [hostKey]);
  const treeRoot = host ? hostById.get(host.id) : undefined;

  // Folded hosts appear externally as nodes under the local root, so the scheduler page lists them too.
  const scopedHostIds = useMemo(() => hostTreeIds(treeRoot?.id), [treeRoot, hostById]);

  const schedulers = db.instances.filter(
    (i) => i.role === "scheduler" && (!treeRoot || scopedHostIds.has(i.host_id)),
  );
  const shown = schedulers.filter((s) => {
    if (state !== "ALL" && s.state !== state) return false;
    const q = query.trim().toLowerCase();
    return !q || s.name.toLowerCase().includes(q) || (s.id ?? "").toLowerCase().includes(q);
  });
  // The local root is always first; nodes and folded host roots (also nodes externally) come after.
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
    // Attribute by instance name: a scheduler restart changes the deployment_id, and builders may still hold the old one.
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

  // One group per host, collapsed by host name; the local host is expanded by default and folded hosts are collapsed.
  const groups = groupByHost(ordered, treeRoot.id);
  const filtering = query.trim() !== "" || state !== "ALL";

  const renderRow = (s: Instance) => {
    const internalRole = s.scheduler_role ?? "root";
    const h = hostById.get(s.host_id);
    // A folded host's root is, from this host's perspective, a node under the parent host's root.
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
              // With only one host (no folded hosts), no collapsing is needed; the list is laid out flat.
              groups[0]?.items.map(renderRow)
            )}
          </div>
        </Card>
      )}
    </div>
  );
}
