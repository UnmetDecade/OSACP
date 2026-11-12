import type { Instance, Role, Task } from "./types";

/**
 * v4 机器人形象注册表。
 *
 * 只有两个角色：构建机器人「夯台」与调度机器人「派令」。
 * 全部为自绘 SVG，不引入外部图片；状态决定表情与动画，不是装饰。
 */
export type CharacterState = "working" | "idle" | "rest" | "alert" | "offline";

export interface RoleCharacter {
  role: Role;
  name: string;
  title: string;
  tagline: string;
  /** 外壳主色 */
  color: string;
  /** 深色描边 / 阴影 */
  accent: string;
  /** 屏幕脸底色 */
  screen: string;
  /** LED 眼睛 / 指示灯 */
  led: string;
  props: string;
  quotes: Record<CharacterState, string>;
  skills: string[];
  agentHints: string[];
}

export const CHARACTERS: Record<Role, RoleCharacter> = {
  builder: {
    role: "builder",
    name: "夯台",
    title: "构建机器人 · Builder",
    tagline: "给我一条命令，我给你一个能跑的结果。",
    color: "#e08a2e",
    accent: "#a45a12",
    screen: "#1f2430",
    led: "#5fe0c0",
    props: "橙色工装 · 扳手天线 · 代码粒子",
    quotes: {
      working: "正在编译，别催，风扇都转起来了。",
      idle: "工位热好了，下一条命令呢？",
      rest: "待机中……有任务我会亮灯。",
      alert: "构建失败了，我正在翻日志。",
      offline: "构建机不在线。",
    },
    skills: ["shell", "build", "ssh"],
    agentHints: ["Claude Code", "Codex", "DeepSeek Coder"],
  },
  scheduler: {
    role: "scheduler",
    name: "派令",
    title: "调度机器人 · Scheduler",
    tagline: "规则派发，Agent 解释；不猜、不抢、不插队。",
    color: "#2f8f83",
    accent: "#1c5f57",
    screen: "#16202a",
    led: "#f0c75e",
    props: "悬浮光环 · 胸口时钟 · 任务清单",
    quotes: {
      working: "正在排队和派发，队列不会插队。",
      idle: "队列平稳，等任务进门。",
      rest: "夜里不调度，除非租约到期。",
      alert: "队列积压或构建机失联，正在核对。",
      offline: "调度台停摆。",
    },
    skills: ["queue", "lease", "fencing"],
    agentHints: ["DeepSeek 调度助手"],
  },
};

/** 由实例与任务推导机器人当前状态。 */
export function characterState(instance: Instance | undefined, runningTask?: Task): CharacterState {
  if (!instance) return "idle";
  if (instance.state === "OFFLINE" || instance.state === "FAILED") return "offline";
  if (instance.state === "SUSPECT" || instance.state === "DRAINING") return "alert";
  if (runningTask) return "working";
  if (instance.state === "ONLINE") return "idle";
  return "rest";
}

export function characterOf(role: Role): RoleCharacter {
  return CHARACTERS[role];
}
