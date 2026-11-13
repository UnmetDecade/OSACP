#!/usr/bin/env node
/**
 * Test fixture: simulates Claude Code's `--output-format stream-json` output.
 *
 * Used only to verify that cli-agent parses tool results and stops a run that keeps failing the
 * same way. Arguments are ignored; FAKE_MODE selects the scripted run.
 */
import fs from "node:fs";

const out = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const toolError = () =>
  out({
    type: "user",
    message: { content: [{ type: "tool_result", is_error: true, content: "ENOENT: /nope" }] },
  });
const toolOk = () => out({ type: "user", message: { content: [{ type: "tool_result", content: "ok" }] } });

const mode = process.env.FAKE_MODE || "ok";
out({ type: "system", subtype: "init" });

if (mode === "stall") {
  toolError();
  toolError();
  toolError();
  // Keep running until the adapter kills the process group; a real agent would keep going too.
  setInterval(() => {}, 1000);
} else if (mode === "recover") {
  // Two failures, a success, then two more: the adapter must reset its counter on the success.
  toolError();
  toolError();
  toolOk();
  toolError();
  toolError();
  out({ type: "result", subtype: "success", result: "STREAM_RECOVERED", is_error: false });
} else if (mode === "need_input") {
  out({ type: "assistant", message: { content: [{ type: "text", text: "I need a decision" }] } });
  fs.writeFileSync("result.json", JSON.stringify({ status: "need_input", question: "Which branch should I push to?" }));
  out({ type: "result", subtype: "success", result: "PARKED", is_error: false });
} else if (mode === "split") {
  fs.writeFileSync(
    "result.json",
    JSON.stringify({
      status: "split",
      summary: "Two independent parts",
      children: [
        { title: "Part A", instruction: "Build the API" },
        { title: "Part B", instruction: "Build the UI" },
      ],
    }),
  );
  out({ type: "result", subtype: "success", result: "SPLIT", is_error: false });
} else if (mode === "outward") {
  out({
    type: "assistant",
    message: {
      content: [
        { type: "text", text: "pushing" },
        { type: "tool_use", name: "Bash", input: { command: "git push origin main" } },
      ],
    },
  });
  toolOk();
  out({ type: "result", subtype: "success", result: "PUSHED", is_error: false });
} else {
  out({ type: "assistant", message: { content: [{ type: "text", text: "working" }] } });
  toolOk();
  out({ type: "result", subtype: "success", result: "STREAM_OK", is_error: false });
}
