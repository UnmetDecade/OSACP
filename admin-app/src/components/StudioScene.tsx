import { t } from "../i18n";
import { Link } from "react-router-dom";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { db } from "../store";
import { CHARACTERS, characterState } from "../characters";
import { Character } from "./Character";
import { Badge, Tag } from "./ui";
import { osLabel } from "../api";
import type { Host, Instance } from "../types";

/**
 * Scene tree for the AI Agent studio.
 *
 * The structure matches the architecture diagram: the local root scheduler on top, with its builders and node schedulers below;
 * node schedulers recursively hold their own builders and next-level schedulers. For hosts folded into this one, their root schedulers
 * appear externally as nodes under the local root and expand recursively in the same way.
 *
 * Connections no longer use fixed-width CSS pseudo-elements to build a bus; instead an SVG layer is drawn from the cards' actual positions:
 * each child card gets a path from the parent's bottom center, rounding a corner to its own center line. Even when child cards have
 * different widths the lines land exactly on the center line, with no "vertical line off by a few pixels" misalignment.
 */

/** Control plane references (parent_scheduler_id / scheduler_id) use deployment_id; instance names are for display only. */
const refOf = (i: Instance | undefined) => i?.deployment_id ?? i?.id ?? "";

type TreeNode = {
  scheduler: Instance;
  host: Host | undefined;
  /** External role: local root or node (including the root of a folded host). */
  role: "root" | "node";
  children: TreeNode[];
  builders: Instance[];
  score: number;
};

/** One connection: target card, path, and whether it is online (signals run only when online). */
type Edge = { id: string; d: string; online: boolean; delay: number };

/** Card element mounted in the scene; an empty parent means it is the local root. */
type NodeRef = { el: HTMLElement; parent?: string; online: boolean };

function schedulersOn(hostId: string): Instance[] {
  return db.instances.filter((i) => i.role === "scheduler" && i.host_id === hostId);
}

function rootOn(hostId: string): Instance | undefined {
  return schedulersOn(hostId).find((s) => (s.scheduler_role ?? "root") === "root");
}

/**
 * Builders owned by a scheduler.
 * A builder's scheduler_id is a deployment_id; legacy data without one falls back to the local root scheduler.
 */
function buildersOwnedBy(s: Instance, hostRoot: Instance | undefined): Instance[] {
  const own = s.id;
  const fallback = hostRoot?.id;
  return db.instances.filter(
    (b) =>
      b.role === "builder" &&
      b.host_id === s.host_id &&
      (b.scheduler_instance_id ?? fallback) === own,
  );
}

/** Node schedulers on the same host whose parent is this scheduler. */
function nodeSchedulersUnder(parent: Instance): Instance[] {
  const ref = refOf(parent);
  return schedulersOn(parent.host_id).filter(
    (s) =>
      (s.scheduler_role ?? "root") === "node" &&
      (s.parent_scheduler_instance_id
        ? s.parent_scheduler_instance_id === parent.id
        : s.parent_scheduler_id === ref),
  );
}

/** Hosts folded into this host: their root schedulers appear as nodes from this host's perspective. */
function mergedChildHosts(hostId: string): Host[] {
  return db.hosts.filter((h) => h.parent_host_id === hostId);
}

function buildNode(
  scheduler: Instance,
  role: "root" | "node",
  visited: Set<string>,
): TreeNode {
  visited.add(scheduler.key);
  const hostRoot = rootOn(scheduler.host_id);
  const builders = buildersOwnedBy(scheduler, hostRoot);
  // A folded host with only bare-metal builders and no scheduler of its own has no node to attach to, so
  // it is attached directly under the local root scheduler, and appears in the tree immediately after onboarding.
  if ((scheduler.scheduler_role ?? "root") === "root") {
    for (const childHost of mergedChildHosts(scheduler.host_id)) {
      if (rootOn(childHost.id)) continue;
      builders.push(
        ...db.instances.filter((b) => b.role === "builder" && b.host_id === childHost.id),
      );
    }
  }

  const children: TreeNode[] = [];
  for (const child of nodeSchedulersUnder(scheduler)) {
    if (visited.has(child.key)) continue;
    children.push(buildNode(child, "node", visited));
  }
  // Only the local root carries folded hosts; node schedulers never span hosts.
  if ((scheduler.scheduler_role ?? "root") === "root") {
    for (const childHost of mergedChildHosts(scheduler.host_id)) {
      const childRoot = rootOn(childHost.id);
      if (!childRoot || visited.has(childRoot.key)) continue;
      children.push(buildNode(childRoot, "node", visited));
    }
  }

  const own = builders
    .filter((b) => b.state === "ONLINE")
    .reduce((sum, b) => sum + (b.capability_score ?? 0), 0);
  const score = children.reduce((sum, c) => sum + c.score, own);

  return {
    scheduler,
    host: db.hosts.find((h) => h.id === scheduler.host_id),
    role,
    children,
    builders,
    score,
  };
}

/** This host's subtree; node schedulers with a broken parent chain also fall back to the root so they are not "invisible" after deployment. */
function buildTree(host: Host): TreeNode | undefined {
  const root = rootOn(host.id);
  if (!root) return undefined;
  const visited = new Set<string>();
  const tree = buildNode(root, "root", visited);

  const orphans = schedulersOn(host.id).filter(
    (s) => (s.scheduler_role ?? "root") === "node" && !visited.has(s.key),
  );
  for (const orphan of orphans) {
    tree.children.push(buildNode(orphan, "node", visited));
  }
  return tree;
}

/** From the parent's bottom center to the child's top center, with one rounded corner in between. */
function elbow(x0: number, y0: number, x1: number, y1: number): string {
  const dy = y1 - y0;
  const dx = Math.abs(x1 - x0);
  if (dx < 1) return `M${x0},${y0} V${y1}`;
  const r = Math.min(10, dx / 2, dy / 2);
  const ym = y0 + dy / 2;
  const dir = x1 > x0 ? 1 : -1;
  return [
    `M${x0},${y0}`,
    `V${ym - r}`,
    `Q${x0},${ym} ${x0 + dir * r},${ym}`,
    `H${x1 - dir * r}`,
    `Q${x1},${ym} ${x1},${ym + r}`,
    `V${y1}`,
  ].join(" ");
}

/** Card registry: records elements, parents and online state, then computes paths after layout. */
type Register = (key: string, parent: string | undefined, online: boolean) => (el: HTMLElement | null) => void;

export function StudioScene({
  host,
  onAdd,
  onDeployScheduler,
  onDeployBuilder,
}: {
  host: Host | undefined;
  /** Add a character under a given scheduler; omitting it means the local entry point (root scheduler). */
  onAdd: (parent?: Instance) => void;
  onDeployScheduler: () => void;
  /** When the studio has no scheduling tree yet, go from the builder card to the deployment instructions. */
  onDeployBuilder: () => void;
}) {
  const treeRef = useRef<HTMLDivElement>(null);
  const nodes = useRef(new Map<string, NodeRef>());
  const [edges, setEdges] = useState<Edge[]>([]);

  const register = useCallback<Register>(
    (key, parent, online) => (el) => {
      if (el) nodes.current.set(key, { el, parent, online });
      else nodes.current.delete(key);
    },
    [],
  );

  // Compute connections from the real layout: parent's bottom center → child's top center.
  const measure = useCallback(() => {
    const tree = treeRef.current;
    if (!tree) return;
    const origin = tree.getBoundingClientRect();
    const next: Edge[] = [];
    const keys = [...nodes.current.keys()].sort();
    for (const key of keys) {
      const node = nodes.current.get(key);
      if (!node?.parent) continue;
      const parent = nodes.current.get(node.parent);
      if (!parent) continue;
      const a = parent.el.getBoundingClientRect();
      const b = node.el.getBoundingClientRect();
      const x0 = a.left + a.width / 2 - origin.left;
      const y0 = a.bottom - origin.top;
      const x1 = b.left + b.width / 2 - origin.left;
      const y1 = b.top - origin.top;
      if (y1 - y0 < 2) continue;
      next.push({
        id: key,
        d: elbow(x0, y0, x1, y1),
        // Emit a signal when either end of the link is alive: while the scheduler is online, a just-started builder
        // also shows the dispatch animation instead of waiting until it is ONLINE.
        // The "+" placeholder card is not a real node and runs no signal.
        online: !key.startsWith("add:") && (node.online || parent.online),
        // Stagger the timing of lines in the same row slightly so they do not all flash in unison.
        delay: -((keys.indexOf(key) % 4) * 0.6),
      });
    }
    setEdges((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
  }, []);

  // Recompute after every render so added/removed cards or copy changes are picked up.
  useLayoutEffect(() => {
    measure();
  });

  // Window resize, late-loading fonts and sidebar expansion all change card positions.
  useEffect(() => {
    const tree = treeRef.current;
    if (!tree) return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(tree);
    return () => ro.disconnect();
  }, [measure]);

  if (!host) {
    return (
      <div className="scene">
        <div className="scene-tree" ref={treeRef}>
          <SceneEdges edges={edges} />
          <div className="scene-empty-roles">
            <EmptyRoleCard role="scheduler" />
            <EmptyRoleCard role="builder" />
          </div>
        </div>
      </div>
    );
  }

  const tree = buildTree(host);
  // No scheduling tree does not mean no builders: a bare-metal builder can exist independently of a scheduler,
  // so show the builders already running instead of asking the user to deploy again.
  const builders = db.instances.filter((i) => i.role === "builder" && i.host_id === host.id);
  return (
    <div className="scene">
      <div className="scene-tree" ref={treeRef}>
        <SceneEdges edges={edges} />
        {tree ? (
          <Subtree node={tree} scopeHostId={host.id} onAdd={onAdd} register={register} isRoot />
        ) : (
          <div className="scene-empty-roles">
            <EmptyRoleCard role="scheduler" onDeploy={onDeployScheduler} />
            {builders.length === 0 ? (
              <EmptyRoleCard role="builder" onDeploy={onDeployBuilder} />
            ) : (
              builders.map((b) => <EmptyRoleCard key={b.key} role="builder" builder={b} />)
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** Connection layer: draw static lines first, then signals traveling back and forth along the same paths. */
function SceneEdges({ edges }: { edges: Edge[] }) {
  return (
    <svg className="scene-edges" width="100%" height="100%" aria-hidden>
      {edges.map((e) => (
        <path key={e.id} className="scene-edge" d={e.d} />
      ))}
      {edges
        .filter((e) => e.online)
        .map((e) => (
          <path
            key={`flow-${e.id}`}
            className="scene-edge-flow"
            d={e.d}
            pathLength={100}
            style={{ animationDelay: `${e.delay}s` }}
          />
        ))}
    </svg>
  );
}

/** Entry cards before any role is deployed: scheduler + builder. */
function EmptyRoleCard({
  role,
  onDeploy,
  builder,
}: {
  role: "scheduler" | "builder";
  onDeploy?: () => void;
  /** When a builder already exists show its real state instead of prompting to deploy. */
  builder?: Instance;
}) {
  const isScheduler = role === "scheduler";
  const runningTask = builder
    ? db.tasks.find((t) => t.instance_id === builder.id && t.state === "RUNNING")
    : undefined;
  const status = builder ? builderStatus(builder, runningTask) : undefined;
  return (
    <div className={`scene-scheduler${builder ? "" : " is-empty"} is-${role}`}>
      <div className="scene-node-head">
        <span>{isScheduler ? t("调度机") : t("构建机")}</span>
        {builder ? (
          <Badge value={status!.value} text={status!.text} />
        ) : (
          <Tag tone={onDeploy ? "warn" : "neutral"}>{onDeploy ? t("未部署") : t("未选择主机")}</Tag>
        )}
      </div>
      <div className="scene-node-body">
        <Character
          role={role}
          state={builder ? characterState(builder, runningTask) : "offline"}
          size={72}
          flat
        />
        <div className="scene-node-copy">
          <b>
            {builder
              ? builder.name
              : t(isScheduler ? "调度机器人 · {name}" : "构建机器人 · {name}", {
                  name: t(CHARACTERS[role].name),
                })}
          </b>
          <p>
            {builder
              ? `${osLabel(builder.os)} · ${builder.cpu_limit}C / ${Math.round(builder.mem_limit_mb / 1024)}G`
              : t("还没有部署")}
          </p>
          <div className="chips">
            {builder ? (
              <Tag tone="accent">W {builder.capability_score ?? 0}</Tag>
            ) : isScheduler ? (
              <Tag tone="accent">ΣW 0</Tag>
            ) : (
              <Tag>{t("容器 / 裸机")}</Tag>
            )}
          </div>
        </div>
      </div>
      {builder ? (
        <Link className="scene-action" to={`/builders/${builder.id}`}>{t("打开构建机")}</Link>
      ) : (
        <button
          type="button"
          className="scene-action"
          onClick={onDeploy}
          disabled={!onDeploy}
        >
          {isScheduler ? t("部署调度机") : t("部署构建机")}
        </button>
      )}
    </div>
  );
}

function Subtree({
  node,
  scopeHostId,
  onAdd,
  register,
  parentKey,
  isRoot = false,
}: {
  node: TreeNode;
  scopeHostId: string;
  onAdd: (parent?: Instance) => void;
  register: Register;
  parentKey?: string;
  isRoot?: boolean;
}) {
  const s = node.scheduler;
  const online = s.state === "ONLINE";
  const merged = node.host !== undefined && node.host.id !== scopeHostId;
  // Roles for a folded host must be created on that host; the local root and its nodes can add roles directly.
  const canAddHere = !merged;
  const hasBranch =
    isRoot || node.children.length > 0 || node.builders.length > 0 || canAddHere;

  return (
    <div className={`scene-subtree${isRoot ? " is-root" : ""}`}>
      <Link
        className="scene-scheduler"
        to={`/scheduler/${s.id}`}
        title={t("打开调度台")}
        ref={register(s.key, parentKey, online)}
      >
        <div className="scene-node-head">
          <span className="scene-node-title">
            {isRoot ? t("根调度机") : t("结点调度机")}
          </span>
          <Badge value={s.state} />
        </div>
        <Character role="scheduler" state={online ? "idle" : "offline"} size={60} flat />
        <b className="scene-node-name">{s.name}</b>
        <small className="scene-node-meta">{s.cpu_limit}C / {Math.round(s.mem_limit_mb / 1024)}G</small>
        <div className="chips">
          <Tag tone="accent" title={t("这台调度机可派发的整棵子树工作能力之和")}>ΣW {node.score}</Tag>
        </div>
        {node.host && (
          <small className="scene-node-host" title={t("所属主机：{name}", { name: node.host.name })}>
            {node.host.name}
          </small>
        )}
      </Link>

      {hasBranch && (
        <div className="scene-branch">
          {node.children.map((child) => (
            <Subtree
              key={child.scheduler.key}
              node={child}
              scopeHostId={scopeHostId}
              onAdd={onAdd}
              register={register}
              parentKey={s.key}
            />
          ))}
          {node.builders.map((b) => (
            <BuilderLeaf key={b.key} builder={b} register={register} parentKey={s.key} />
          ))}
          {canAddHere && (
            <div className="scene-subtree is-add">
              <button
                type="button"
                className="scene-builder is-empty"
                onClick={() => onAdd(s)}
                title={t("在 {name} 下添加角色", { name: s.name })}
                ref={register(`add:${s.key}`, s.key, false)}
              >
                <span className="empty-plus">＋</span>
                <b>{t("添加构建机/调度机")}</b>
                <small>{t("接入主机")}</small>
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Builder state as people see it: working / idle / offline / failed, not the instance lifecycle. */
function builderStatus(builder: Instance, runningTask: ReturnType<typeof db.tasks.find>) {
  if (runningTask) return { value: "RUNNING", text: t("工作") };
  switch (builder.state) {
    case "ONLINE":
      return { value: "ONLINE", text: t("休息") };
    case "SUSPECT":
      return { value: "SUSPECT", text: t("故障") };
    case "OFFLINE":
    case "FAILED":
      return { value: "OFFLINE", text: t("离线") };
    case "DRAINING":
      return { value: "DRAINING", text: t("维护") };
    default:
      return { value: builder.state, text: t("启动中") };
  }
}

function BuilderLeaf({
  builder,
  register,
  parentKey,
}: {
  builder: Instance;
  register: Register;
  parentKey?: string;
}) {
  const runningTask = db.tasks.find(
    (t) => t.instance_id === builder.id && t.state === "RUNNING",
  );
  const online = builder.state === "ONLINE";
  const status = builderStatus(builder, runningTask);
  // Every card labels its own host name at the bottom, matching the scheduler cards.
  const host = db.hosts.find((h) => h.id === builder.host_id);
  return (
    <div className="scene-subtree">
      <Link
        className="scene-builder"
        to={`/builders/${builder.id}`}
        title={runningTask ? runningTask.title : undefined}
        ref={register(builder.key, parentKey, online)}
      >
        <div className="scene-node-head">
          <span className="scene-node-title">{t("构建机")}</span>
          <Badge value={status.value} text={status.text} />
        </div>
        <Character role="builder" state={characterState(builder, runningTask)} size={60} flat />
        <b>{builder.name}</b>
        <small>{osLabel(builder.os)} · {builder.cpu_limit}C / {Math.round(builder.mem_limit_mb / 1024)}G</small>
        <span className="scene-builder-w">W {builder.capability_score ?? 0}</span>
        {host && (
          <small className="scene-node-host" title={t("所属主机：{name}", { name: host.name })}>
            {host.name}
          </small>
        )}
      </Link>
    </div>
  );
}
