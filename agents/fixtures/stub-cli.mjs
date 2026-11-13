#!/usr/bin/env node
/**
 * Test fixture: simulates an external CLI Agent that accepts a prompt argument.
 * Used only to verify the protocol, workspace and environment isolation of agents/cli-agent.mjs; not used in production.
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

const chat = /Operator.s current message: (.*)/.exec(prompt);
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
