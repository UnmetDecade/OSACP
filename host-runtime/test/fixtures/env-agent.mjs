#!/usr/bin/env node
/**
 * Minimal stdio JSON-RPC Agent used by tests that care about the environment the Agent is launched with.
 * It never calls a tool: prepare succeeds immediately and execute reports the model variables it saw.
 */
import readline from "node:readline";

const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.method === "agent.health") {
    send({ jsonrpc: "2.0", id: msg.id, result: { healthy: true, version: "1.0.0" } });
    return;
  }
  if (msg.method === "agent.prepare") {
    send({ jsonrpc: "2.0", id: msg.id, result: { ready: true } });
    return;
  }
  if (msg.method === "agent.execute") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        status: "SUCCEEDED",
        summary: `base=${process.env.ANTHROPIC_BASE_URL ?? "<unset>"} key=${process.env.ANTHROPIC_API_KEY ?? "<unset>"}`,
        outputs: [],
      },
    });
    return;
  }
  if (msg.method === "agent.cancel") {
    send({ jsonrpc: "2.0", id: msg.id, result: {} });
  }
});
