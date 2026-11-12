import type { AgentProfile, ApiProfile, Fleet, Host, Instance, LogEntry, Task } from "./types";

/**
 * 运行时数据仓库：页面只读，由实时同步写入。
 * 应用不再内置演示数据，首次渲染为空，同步完成后填充。
 */
export const db = {
  hosts: [] as Host[],
  instances: [] as Instance[],
  agents: [] as AgentProfile[],
  apis: [] as ApiProfile[],
  tasks: [] as Task[],
  logs: [] as LogEntry[],
  /** 控制面的联邦树（ΣW / 并入关系）；控制面不可达时保持上一次结果。 */
  fleet: { hosts: [], total_score: 0, generated_at: "" } as Fleet,
};
