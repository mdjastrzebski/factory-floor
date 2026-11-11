import { test } from "node:test";
import assert from "node:assert/strict";
import { parseStreamJsonLine, describeDenial } from "../src/harnesses/stream-json-parser.ts";

test("parseStreamJsonLine returns undefined for a blank line", () => {
  assert.equal(parseStreamJsonLine(""), undefined);
  assert.equal(parseStreamJsonLine("   \n"), undefined);
});

test("parseStreamJsonLine surfaces non-JSON lines verbatim", () => {
  const result = parseStreamJsonLine("not json at all");
  assert.deepEqual(result, { displayChunks: ["not json at all\n"], denials: [] });
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
  assert.deepEqual(result, { displayChunks: ["hello there"], denials: [] });
});

test("parseStreamJsonLine renders tool_use blocks as an arrow line", () => {
  const line = JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", name: "Bash" }] },
  });
  const result = parseStreamJsonLine(line);
  assert.deepEqual(result, { displayChunks: ["\n→ Bash\n"], denials: [] });
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
    denials: [],
  });
});

test("parseStreamJsonLine ignores assistant events with no content", () => {
  const line = JSON.stringify({ type: "assistant", message: {} });
  assert.deepEqual(parseStreamJsonLine(line), { displayChunks: [], denials: [] });
});

test("parseStreamJsonLine collects permission_denials from a result event", () => {
  const line = JSON.stringify({
    type: "result",
    permission_denials: ["Bash: force-push blocked", { tool_name: "Write", reason: "outside cwd" }],
  });
  const result = parseStreamJsonLine(line);
  assert.deepEqual(result, {
    displayChunks: [],
    denials: ["Bash: force-push blocked", "Write: outside cwd"],
  });
});

test("parseStreamJsonLine treats a result event with no denials as empty", () => {
  const line = JSON.stringify({ type: "result", permission_denials: [] });
  assert.deepEqual(parseStreamJsonLine(line), { displayChunks: [], denials: [] });
});

test("parseStreamJsonLine ignores unrecognized event types", () => {
  const line = JSON.stringify({ type: "system", data: "irrelevant" });
  assert.deepEqual(parseStreamJsonLine(line), { displayChunks: [], denials: [] });
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
