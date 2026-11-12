#!/usr/bin/env node
/**
 * 测试夹具：模拟一个接受 prompt 参数的外部 CLI Agent。
 * 只用于验证 agents/cli-agent.mjs 的协议、工作区和环境隔离，不参与生产。
 */
import fs from "node:fs";

const prompt = process.argv[2] ?? "";
const hasToken = Boolean(process.env.PLATFORM_TOOL_TOKEN);
const hasProxy = Boolean(process.env.PLATFORM_API_PROXY);

if (hasToken || hasProxy) {
  process.stderr.write("STUB_LEAK: platform credentials visible\n");
  process.exit(9);
}
const ambient = process.env.AMBIENT_SECRET ? "visible" : "hidden";

const chat = /操作员当前消息：(.*)/.exec(prompt);
if (chat) {
  process.stdout.write(`STUB_REPLY(${chat[1].trim()}) token=stripped ambient=${ambient}\n`);
  process.exit(0);
}

fs.writeFileSync("artifact.txt", "stub artifact\n");
fs.writeFileSync(
  "result.json",
  JSON.stringify({ summary: "STUB_BUILD_OK", outputs: ["artifact.txt"] }, null, 2),
);
process.stdout.write("STUB_BUILD_OK\n");
