import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeCliHarness } from "../src/harnesses/claude-cli-harness.ts";

/**
 * Writes a fake `claude` executable that emits a multi-byte UTF-8 character
 * (an emoji, 4 bytes) split across two separate stdout writes, with a tick
 * in between so they are delivered as two distinct `data` chunks rather than
 * being coalesced into one. This reproduces the scenario in F-001: a
 * multi-byte character split at a chunk boundary.
 */
function writeFakeClaude(dir: string): string {
  const scriptPath = join(dir, "claude");
  const emoji = Buffer.from("😀", "utf8"); // F0 9F 98 80 (4 bytes)
  const script = `#!/usr/bin/env node
const part1 = Buffer.from(${JSON.stringify([...emoji.subarray(0, 3)])});
const part2 = Buffer.from(${JSON.stringify([...emoji.subarray(3)])});
process.stdout.write(Buffer.concat([Buffer.from("hello "), part1]));
setTimeout(() => {
  process.stdout.write(Buffer.concat([part2, Buffer.from(" world\\n")]));
  process.exit(0);
}, 20);
`;
  writeFileSync(scriptPath, script, "utf8");
  chmodSync(scriptPath, 0o755);
  return dir;
}

test("ClaudeCliHarness does not corrupt a multi-byte UTF-8 character split across stdout chunks", async () => {
  const dir = mkdtempSync(join(tmpdir(), "factory-floor-fake-claude-"));
  writeFakeClaude(dir);

  const harness = new ClaudeCliHarness();
  const chunks: string[] = [];

  // `spawn` in the harness inherits process.env, so prepend the fake
  // `claude` to PATH for the duration of this call and restore it after.
  const originalPath = process.env.PATH ?? "";
  process.env.PATH = `${dir}:${originalPath}`;
  let result;
  try {
    result = await harness.run({
      cwd: dir,
      prompt: "irrelevant",
      onOutputChunk: (chunk, stream) => {
        if (stream === "stdout") chunks.push(chunk);
      },
    });
  } finally {
    process.env.PATH = originalPath;
  }

  assert.ok(
    result.stdout.includes("hello 😀 world"),
    `expected stdout to contain the intact emoji, got: ${JSON.stringify(result.stdout)}`,
  );
  assert.ok(
    !result.stdout.includes("�"),
    `expected no replacement characters in stdout, got: ${JSON.stringify(result.stdout)}`,
  );

  const streamed = chunks.join("");
  assert.ok(
    !streamed.includes("�"),
    `expected no replacement characters in streamed chunks, got: ${JSON.stringify(streamed)}`,
  );
});
