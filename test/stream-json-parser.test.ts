import { test } from "node:test";
import assert from "node:assert/strict";
import { parseStreamJsonLine, describeDenial } from "../src/harnesses/stream-json-parser.ts";

test("parseStreamJsonLine returns undefined for a blank line", () => {
  assert.equal(parseStreamJsonLine(""), undefined);
  assert.equal(parseStreamJsonLine("   \n"), undefined);
});

test("parseStreamJsonLine surfaces non-JSON lines verbatim", () => {
  const result = parseStreamJsonLine("not json at all");
  assert.deepEqual(result, {
    displayChunks: ["not json at all\n"],
    toolCalls: [],
    denials: [],
  });
});

test("parseStreamJsonLine ignores non-object JSON values", () => {
  assert.equal(parseStreamJsonLine("42"), undefined);
  assert.equal(parseStreamJsonLine('"a string"'), undefined);
  assert.equal(parseStreamJsonLine("null"), undefined);
});

test("parseStreamJsonLine extracts assistant text blocks", () => {
  const line = JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "text", text: "hello there" }] },
  });
  const result = parseStreamJsonLine(line);
  assert.deepEqual(result, { displayChunks: ["hello there"], toolCalls: [], denials: [] });
});

test("parseStreamJsonLine renders tool_use blocks as an arrow line", () => {
  const line = JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", name: "Bash" }] },
  });
  const result = parseStreamJsonLine(line);
  assert.deepEqual(result, {
    displayChunks: ["\n→ Bash\n"],
    toolCalls: [{ name: "Bash", activity: "Running command" }],
    denials: [],
  });
});

test("parseStreamJsonLine handles multiple content blocks in order", () => {
  const line = JSON.stringify({
    type: "assistant",
    message: {
      content: [
        { type: "text", text: "doing a thing" },
        { type: "tool_use", name: "Edit" },
        { type: "text", text: "done" },
      ],
    },
  });
  const result = parseStreamJsonLine(line);
  assert.deepEqual(result, {
    displayChunks: ["doing a thing", "\n→ Edit\n", "done"],
    toolCalls: [{ name: "Edit", activity: "Editing file" }],
    denials: [],
  });
});

test("parseStreamJsonLine ignores assistant events with no content", () => {
  const line = JSON.stringify({ type: "assistant", message: {} });
  assert.deepEqual(parseStreamJsonLine(line), { displayChunks: [], toolCalls: [], denials: [] });
});

test("parseStreamJsonLine collects permission_denials from a result event", () => {
  const line = JSON.stringify({
    type: "result",
    permission_denials: ["Bash: force-push blocked", { tool_name: "Write", reason: "outside cwd" }],
  });
  const result = parseStreamJsonLine(line);
  assert.deepEqual(result, {
    displayChunks: [],
    toolCalls: [],
    denials: ["Bash: force-push blocked", "Write: outside cwd"],
  });
});

test("parseStreamJsonLine treats a result event with no denials as empty", () => {
  const line = JSON.stringify({ type: "result", permission_denials: [] });
  assert.deepEqual(parseStreamJsonLine(line), { displayChunks: [], toolCalls: [], denials: [] });
});

test("parseStreamJsonLine ignores unrecognized event types", () => {
  const line = JSON.stringify({ type: "system", data: "irrelevant" });
  assert.deepEqual(parseStreamJsonLine(line), { displayChunks: [], toolCalls: [], denials: [] });
});

test("parseStreamJsonLine exposes tool_use blocks as structured tool calls with their primary argument", () => {
  const line = JSON.stringify({
    type: "assistant",
    message: {
      content: [
        { type: "tool_use", name: "Edit", input: { file_path: "src/foo.ts", old_string: "a" } },
        { type: "text", text: "now testing" },
        { type: "tool_use", name: "Bash", input: { command: "npm test", description: "run" } },
        { type: "tool_use", name: "Grep", input: { pattern: "TODO", path: "src" } },
        { type: "tool_use", name: "TodoWrite", input: { todos: [] } },
      ],
    },
  });
  const result = parseStreamJsonLine(line);
  assert.deepEqual(result?.toolCalls, [
    { name: "Edit", detail: "src/foo.ts", activity: "Editing file" },
    { name: "Bash", detail: "npm test", activity: "Running command" },
    { name: "Grep", detail: "TODO", activity: "Searching" },
    { name: "TodoWrite", activity: "Updating todos" },
  ]);
  // The display text includes the detail, for verbose mode.
  assert.deepEqual(result?.displayChunks, [
    "\n→ Edit src/foo.ts\n",
    "now testing",
    "\n→ Bash npm test\n",
    "\n→ Grep TODO\n",
    "\n→ TodoWrite\n",
  ]);
});

test("parseStreamJsonLine omits a tool call's detail when its input is missing or blank", () => {
  const line = JSON.stringify({
    type: "assistant",
    message: {
      content: [
        { type: "tool_use", name: "Read" },
        { type: "tool_use", name: "Read", input: "not an object" },
        { type: "tool_use", name: "Read", input: { file_path: "   " } },
        { type: "tool_use", name: "Read", input: { file_path: 42 } },
      ],
    },
  });
  assert.deepEqual(parseStreamJsonLine(line)?.toolCalls, [
    { name: "Read", activity: "Reading file" },
    { name: "Read", activity: "Reading file" },
    { name: "Read", activity: "Reading file" },
    { name: "Read", activity: "Reading file" },
  ]);
});

test("describeDenial renders a string denial verbatim", () => {
  assert.equal(describeDenial("plain string denial"), "plain string denial");
});

test("describeDenial renders tool + reason from an object denial", () => {
  assert.equal(describeDenial({ tool_name: "Bash", reason: "blocked" }), "Bash: blocked");
  assert.equal(describeDenial({ toolName: "Bash", message: "blocked" }), "Bash: blocked");
  assert.equal(describeDenial({ tool: "Bash" }), "Bash");
});

test("describeDenial falls back to JSON for unrecognized shapes", () => {
  assert.equal(describeDenial({ foo: "bar" }), JSON.stringify({ foo: "bar" }));
  assert.equal(describeDenial(42), "42");
});
