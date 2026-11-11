import { test } from "node:test";
import assert from "node:assert/strict";
import { createVerboseOutputFormatter } from "../src/terminal/verbose-output.ts";

test("prefixes each line of a chunk", () => {
  const format = createVerboseOutputFormatter();
  assert.equal(format("s", "a\nb\n", "stdout"), "[s:stdout] a\n[s:stdout] b\n");
});

test("puts a tool-call line after unterminated text on its own line", () => {
  const format = createVerboseOutputFormatter();
  const out = format("s", "doing a thing", "stdout") + format("s", "→ Edit foo\n", "stdout");
  assert.equal(out, "[s:stdout] doing a thing\n[s:stdout] → Edit foo\n");
});

test("continues a mid-line text chunk without a second prefix", () => {
  const format = createVerboseOutputFormatter();
  const out = format("s", "hello ", "stdout") + format("s", "world\nnext", "stdout");
  assert.equal(out, "[s:stdout] hello world\n[s:stdout] next");
});

test("tracks line position per stream", () => {
  const format = createVerboseOutputFormatter();
  assert.equal(format("s", "partial", "stdout"), "[s:stdout] partial");
  assert.equal(format("s", "err\n", "stderr"), "[s:stderr] err\n");
  assert.equal(format("s", "→ Read x\n", "stdout"), "\n[s:stdout] → Read x\n");
});
