import { baseEnv, runShell, tail } from "./shell.js";
import { TaskAborted, TaskFailed, type Executor } from "../exec-types.js";

/**
 * 角色对话与构建机 Shell。
 *
 * 两者都是普通调度任务，不绕过 claim / lease / fencing / 审计：
 *   - task.chat.<role>：把一条消息交给该角色的 Agent。未绑定可对话 Agent 时，
 *     返回确定性的角色说明，并明确标记 mode=deterministic，不假装是模型回复。
 *   - task.console.builder：在构建机容器里执行完整 shell 命令，与 SSH 等价。
 *     v4 取消了白名单；隔离由容器边界、资源限额和网络策略负责。
 */

const ROLE_PERSONA: Record<string, { name: string; duty: string; line: string }> = {
  builder: {
    name: "夯台",
    duty: "编译、执行与容器内取证",
    line: "给我一条命令，我给你一个能跑的结果。",
  },
  scheduler: {
    name: "派令",
    duty: "排队、租约与派发",
    line: "不猜、不抢；按规则把任务放到该去的构建机。",
  },
};

function roleOf(taskType: string): string {
  const role = taskType.split(".")[2] ?? "";
  return ROLE_PERSONA[role] ? role : "builder";
}

function chatOf(task: { requirements?: Record<string, unknown> }): {
  message: string;
  sessionId: string;
  history: Array<{ role: string; text: string }>;
} {
  const raw = (task.requirements?.chat ?? {}) as Record<string, unknown>;
  const message = typeof raw.message === "string" ? raw.message.slice(0, 4000) : "";
  const sessionId = typeof raw.session_id === "string" ? raw.session_id.slice(0, 120) : "";
  const history = Array.isArray(raw.history)
    ? raw.history
        .filter((h): h is Record<string, unknown> => !!h && typeof h === "object")
        .slice(-12)
        .map((h) => ({
          role: String(h.role ?? "user").slice(0, 20),
          text: String(h.text ?? "").slice(0, 2000),
        }))
    : [];
  return { message, sessionId, history };
}

/**
 * 确定性对话：没有可用的对话 Agent 时也要给出可核对的回答，
 * 但必须让调用方知道这不是模型生成的。答案只使用任务信封里的公开字段。
 */
export function chatExecutorFor(role: string): Executor {
  const persona = ROLE_PERSONA[role] ?? ROLE_PERSONA.builder;
  return async (task, ctx) => {
    const { message, history } = chatOf(task);
    if (!message.trim()) {
      throw new TaskFailed("CHAT_MESSAGE_EMPTY", "消息为空");
    }
    ctx.progress(30, "读取角色上下文");
    const lower = message.toLowerCase();
    const agent = task.agent?.profile_id
      ? `${task.agent.profile_id}${task.agent.version ? `@${task.agent.version}` : ""}`
      : "未绑定 Agent";

    let reply: string;
    if (lower.includes("agent") || message.includes("模型") || message.includes("绑定")) {
      reply = `我是${persona.name}，当前工位绑定的是 ${agent}。我只会看到这条对话和显式携带的历史，不会读取工作流的其他会话。`;
    } else if (message.includes("进度") || message.includes("状态") || message.includes("忙")) {
      reply = `这条消息本身是一次 task.chat.${role} 任务；进度以任务中心为准。${persona.line}`;
    } else if (message.includes("ssh") || message.includes("终端") || message.includes("shell")) {
      reply =
        role === "builder"
          ? "终端就是完整 SSH：root 登录、任意命令、可 apt、可编译。地址和端口在构建机详情里。"
          : "调度机不执行构建，只排队和派发；SSH 在构建机上。";
    } else if (message.includes("磁盘") || message.includes("空间")) {
      reply = "在终端执行 df -h 就能看到；构建机产物目录建议每周清一次。";
    } else if (message.includes("你好") || lower.includes("hello") || lower.includes("hi")) {
      reply = `你好，我是${persona.name}，负责${persona.duty}。${persona.line}`;
    } else {
      reply = `收到。我是${persona.name}，负责${persona.duty}。当前没有绑定可对话的模型，所以这条是平台生成的确定性回复；配置 Agent Profile 后，同样的任务会交给指定 Agent 执行。`;
    }

    ctx.progress(80, "生成回复");
    ctx.log(`chat ${task.task_id}: mode=deterministic history=${history.length}`);
    return {
      summary: `${persona.name} 回复（确定性）`,
      outputs: {
        reply,
        mode: "deterministic",
        role,
        task_id: task.task_id,
        agent_profile_id: task.agent?.profile_id ?? null,
        history_turns: history.length,
      },
    };
  };
}

/* ------------------------------------------------------------------ */
/* 构建机 Shell（完整权限）                                            */
/* ------------------------------------------------------------------ */

export function consoleExecutorFor(role: string): Executor {
  return async (task, ctx) => {
    const raw = (task.requirements?.console ?? {}) as Record<string, unknown>;
    const command = typeof raw.command === "string" ? raw.command.slice(0, 4000) : "";
    const operator = typeof raw.operator === "string" ? raw.operator.slice(0, 80) : "unknown";
    if (!command.trim()) throw new TaskFailed("CONSOLE_COMMAND_EMPTY", "命令为空");
    // 安装/编译类命令要几分钟：允许调用方指定，上限 15 分钟，默认 60 秒。
    const requestedSeconds = Number(raw.timeout_seconds);
    const timeoutMs =
      Number.isFinite(requestedSeconds) && requestedSeconds > 0
        ? Math.min(Math.max(requestedSeconds * 1000, 5_000), 15 * 60_000)
        : 60_000;

    ctx.progress(20, "在构建机内执行命令");
    const result = await runShell({
      command,
      cwd: ctx.workspaceDir,
      env: baseEnv({
        PLATFORM_INSTANCE_ID: ctx.instanceId,
        PLATFORM_TASK_ID: task.task_id,
        PLATFORM_TASK_TYPE: task.task_type,
        PLATFORM_WORKSPACE: ctx.workspaceDir,
      }),
      signal: ctx.signal,
      timeoutMs,
    });

    if (ctx.signal.aborted) {
      const reason = ctx.signal.reason;
      throw new TaskAborted(reason === "cancelled" || reason === "shutdown" ? reason : "lease_lost");
    }

    // 审计只记命令与结果元数据，不记录完整输出，避免把业务数据写进日志。
    ctx.log(
      `console ${task.task_id}: role=${role} operator=${operator} command=${command.slice(0, 120)} exit=${result.exitCode} duration_ms=${result.durationMs}`,
    );
    ctx.progress(100, "命令执行完成");

    return {
      summary: `${command.slice(0, 60)} 执行完成（exit ${result.exitCode}）`,
      outputs: {
        stdout: tail(result.stdout, 64 * 1024),
        stderr: tail(result.stderr, 64 * 1024),
        exit_code: result.timedOut ? 124 : result.exitCode,
        duration_ms: result.durationMs,
        command,
        operator,
        role,
      },
    };
  };
}

/**
 * 供 Agent 执行器复用：console 任务永远不交给外部 Agent。
 * 返回 true 表示该任务类型必须走确定性执行器。
 */
export function mustUseDeterministicExecutor(taskType: string): boolean {
  return taskType.startsWith("task.console.");
}
