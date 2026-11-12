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
 * AI Agent 工作室的场景树。
 *
 * 结构跟架构图一致：本机根调度机在上，下面挂它名下的构建机和结点调度机；
 * 结点调度机继续递归挂自己的构建机与下一层调度机。并入本机的主机，其根调度机
 * 对外就是本机根下的一个结点，同样递归展开。
 *
 * 连线不再用固定宽度的 CSS 伪元素拼总线，而是按卡片的实际位置画一层 SVG：
 * 每张子卡片一条从父卡片底部中线出发、圆角拐到自己中线的路径。子卡片宽度
 * 不一致时线也能准确落在卡片中线，不会出现「竖线差几像素」的错位。
 */

/** 控制面引用（parent_scheduler_id / scheduler_id）用 deployment_id，实例名只用于显示。 */
const refOf = (i: Instance | undefined) => i?.deployment_id ?? i?.id ?? "";

type TreeNode = {
  scheduler: Instance;
  host: Host | undefined;
  /** 对外角色：本机根 or 结点（含并入主机的根）。 */
  role: "root" | "node";
  children: TreeNode[];
  builders: Instance[];
  score: number;
};

/** 一条连线：目标卡片、路径、是否在线（在线才跑信号）。 */
type Edge = { id: string; d: string; online: boolean; delay: number };

/** 挂到场景里的卡片元素；parent 为空表示它是本机根。 */
type NodeRef = { el: HTMLElement; parent?: string; online: boolean };

function schedulersOn(hostId: string): Instance[] {
  return db.instances.filter((i) => i.role === "scheduler" && i.host_id === hostId);
}

function rootOn(hostId: string): Instance | undefined {
  return schedulersOn(hostId).find((s) => (s.scheduler_role ?? "root") === "root");
}

/**
 * 某台调度机名下的构建机。
 * 构建机的 scheduler_id 是 deployment_id；旧数据没有时归本机根调度机。
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

/** 同主机、以这台调度机为父的结点调度机。 */
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

/** 并入这台主机的主机：它们的根调度机在本机视角里是结点。 */
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
  // 并入的主机如果只有裸机构建机、没有自己的调度机，就没有结点可挂，
  // 直接挂到本机根调度机下面，接入后能立刻在树里看到。
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
  // 只有本机的根会承载并入主机；结点调度机不跨主机。
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

/** 本机这一棵子树；父链中断的结点调度机也挂回根，避免部署后「看不见」。 */
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

/** 父卡片底部中线 → 子卡片顶部中线，中间一次圆角拐弯。 */
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

/** 卡片注册器：记录元素、父节点和在线状态，布局结束后统一算路径。 */
type Register = (key: string, parent: string | undefined, online: boolean) => (el: HTMLElement | null) => void;

export function StudioScene({
  host,
  onAdd,
  onDeployScheduler,
  onDeployBuilder,
}: {
  host: Host | undefined;
  /** 在指定调度机下新增角色；不传表示本机入口（根调度机）。 */
  onAdd: (parent?: Instance) => void;
  onDeployScheduler: () => void;
  /** 工作室还没有调度树时，从构建机卡片进入部署说明。 */
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

  // 按真实布局算连线：父卡片底边中点 → 子卡片顶边中点。
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
        // 只要链路一端活着就出信号：调度机在线时，刚拉起的「启动中」构建机
        // 也能看到派发动画，而不是等它 ONLINE 才有动静。
        // 「＋」占位卡不是真实结点，不跑信号。
        online: !key.startsWith("add:") && (node.online || parent.online),
        // 同一排每条线的节拍错开一点，不要整齐地一起闪。
        delay: -((keys.indexOf(key) % 4) * 0.6),
      });
    }
    setEdges((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
  }, []);

  // 每次渲染后重算，卡片增减或文案变化都能跟上。
  useLayoutEffect(() => {
    measure();
  });

  // 窗口缩放、字体晚到、侧栏展开都会改变卡片位置。
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
  // 没有调度树不代表没有构建机：裸机构建机可以独立于调度机存在，
  // 这时要展示已经在跑的构建机，而不是再让用户部署一次。
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

/** 连线层：先画静态线，再画沿同一条路径往返的信号。 */
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

/** 还没部署角色时的入口卡片：调度机 + 构建机。 */
function EmptyRoleCard({
  role,
  onDeploy,
  builder,
}: {
  role: "scheduler" | "builder";
  onDeploy?: () => void;
  /** 已经有构建机时展示它的真实状态，不再提示部署。 */
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
  // 并入主机的角色要去那台主机上建；本机自己的根和结点都能直接加角色。
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

/** 构建机给人看的状态：工作中 / 休息 / 离线 / 故障，而不是实例生命周期。 */
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
  // 每张卡片底部都标自己的主机名，和调度机卡片一致。
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
