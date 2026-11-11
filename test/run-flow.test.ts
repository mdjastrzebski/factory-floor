import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Harness, HarnessResult, HarnessRunOptions } from "../src/harness.ts";
import { runFlow, FlowRunError } from "../src/run-flow.ts";

class FakeHarness implements Harness {
  calls: HarnessRunOptions[] = [];
  private results: HarnessResult[];

  constructor(results: HarnessResult[]) {
    this.results = results;
  }

  async run(options: HarnessRunOptions): Promise<HarnessResult> {
    this.calls.push(options);
    const index = this.calls.length - 1;
    const result = this.results[index];
    if (!result) {
      throw new Error(
        `FakeHarness called more times (${this.calls.length}) than it has scripted results`,
      );
    }
    options.onOutputChunk?.(result.stdout, "stdout");
    if (result.stderr) {
      options.onOutputChunk?.(result.stderr, "stderr");
    }
    return result;
  }
}

function ok(stdout = "ok"): HarnessResult {
  return { success: true, exitCode: 0, stdout, stderr: "" };
}

function fail(stderr = "boom"): HarnessResult {
  return { success: false, exitCode: 1, stdout: "", stderr };
}

function writeFlow(dir: string, yamlText: string): string {
  const flowPath = join(dir, "flow.yaml");
  writeFileSync(flowPath, yamlText, "utf8");
  return flowPath;
}

test("runs all steps in order and reports success when every step succeeds", async () => {
  const dir = mkdtempSync(join(tmpdir(), "factory-floor-test-"));
  const flowPath = writeFlow(
    dir,
    `
steps:
  - name: Step One
    prompt: do one
  - name: Step Two
    prompt: do two
  - name: Step Three
    prompt: do three
`,
  );
  const harness = new FakeHarness([ok(), ok(), ok()]);

  const started: string[] = [];
  const completed: string[] = [];

  const result = await runFlow({
    flowPath,
    verbose: false,
    harness,
    onStepStart: (info) => started.push(info.name),
    onStepComplete: (info) => completed.push(info.name),
  });

  assert.equal(result.success, true);
  assert.equal(result.failedStepName, undefined);
  assert.deepEqual(started, ["Step One", "Step Two", "Step Three"]);
  assert.deepEqual(completed, ["Step One", "Step Two", "Step Three"]);
  assert.equal(harness.calls.length, 3);
  assert.equal(harness.calls[0].cwd, dir);
  assert.equal(harness.calls[0].prompt, "do one");
});

test("stops immediately after a failing step and does not run later steps", async () => {
  const dir = mkdtempSync(join(tmpdir(), "factory-floor-test-"));
  const flowPath = writeFlow(
    dir,
    `
steps:
  - name: Step One
    prompt: do one
  - name: Step Two
    prompt: do two
  - name: Step Three
    prompt: do three
`,
  );
  const harness = new FakeHarness([ok(), fail(), ok()]);

  const result = await runFlow({ flowPath, verbose: false, harness });

  assert.equal(result.success, false);
  assert.equal(result.failedStepName, "Step Two");
  // Only the first two steps should have been invoked; "Step Three" never runs.
  assert.equal(harness.calls.length, 2);
});

test("constructs log file paths under <cwd>/.factory-floor/runs/<timestamp>/<slug>.log", async () => {
  const dir = mkdtempSync(join(tmpdir(), "factory-floor-test-"));
  const flowPath = writeFlow(
    dir,
    `
steps:
  - name: Build Things!
    prompt: build
`,
  );
  const harness = new FakeHarness([ok("built output")]);

  let logPath = "";
  const result = await runFlow({
    flowPath,
    verbose: false,
    harness,
    onStepComplete: (info) => {
      logPath = info.logPath;
    },
  });

  assert.equal(result.success, true);
  assert.ok(result.runDir.startsWith(join(dir, ".factory-floor", "runs")));
  assert.equal(logPath, join(result.runDir, "build-things.log"));
  assert.ok(existsSync(logPath));
  const logContents = readFileSync(logPath, "utf8");
  assert.match(logContents, /built output/);
});

test("gives collision suffixes to steps whose names slugify to the same thing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "factory-floor-test-"));
  const flowPath = writeFlow(
    dir,
    `
steps:
  - name: Build!
    prompt: one
  - name: Build?
    prompt: two
`,
  );
  const harness = new FakeHarness([ok(), ok()]);
  const logPaths: string[] = [];

  await runFlow({
    flowPath,
    verbose: false,
    harness,
    onStepComplete: (info) => logPaths.push(info.logPath),
  });

  assert.deepEqual(
    logPaths.map((p) => p.split("/").pop()),
    ["build.log", "build-2.log"],
  );
});

test("streams output chunks via onOutputChunk only when verbose is true", async () => {
  const dir = mkdtempSync(join(tmpdir(), "factory-floor-test-"));
  const flowPath = writeFlow(
    dir,
    `
steps:
  - name: Step One
    prompt: do one
`,
  );

  const chunksVerbose: string[] = [];
  const harnessVerbose = new FakeHarness([ok("hello")]);
  await runFlow({
    flowPath,
    verbose: true,
    harness: harnessVerbose,
    onOutputChunk: (_name, chunk) => chunksVerbose.push(chunk),
  });
  assert.deepEqual(chunksVerbose, ["hello"]);

  const chunksQuiet: string[] = [];
  const harnessQuiet = new FakeHarness([ok("hello")]);
  await runFlow({
    flowPath,
    verbose: false,
    harness: harnessQuiet,
    onOutputChunk: (_name, chunk) => chunksQuiet.push(chunk),
  });
  assert.deepEqual(chunksQuiet, []);
});

test("treats a harness.run rejection (e.g. ENOENT spawning the CLI) as a failed step", async () => {
  const dir = mkdtempSync(join(tmpdir(), "factory-floor-test-"));
  const flowPath = writeFlow(
    dir,
    `
steps:
  - name: Step One
    prompt: do one
  - name: Step Two
    prompt: do two
`,
  );

  class RejectingHarness implements Harness {
    async run(): Promise<HarnessResult> {
      throw new Error("spawn claude ENOENT");
    }
  }

  const completed: { name: string; success: boolean }[] = [];

  const result = await runFlow({
    flowPath,
    verbose: false,
    harness: new RejectingHarness(),
    onStepComplete: (info) => completed.push({ name: info.name, success: info.success }),
  });

  assert.equal(result.success, false);
  assert.equal(result.failedStepName, "Step One");
  // onStepComplete must still fire, and only the first step should run.
  assert.deepEqual(completed, [{ name: "Step One", success: false }]);

  const logPath = join(result.runDir, "step-one.log");
  assert.ok(existsSync(logPath));
  const logContents = readFileSync(logPath, "utf8");
  assert.match(logContents, /ENOENT/);
});

test("throws FlowRunError when the flow cwd does not exist", async () => {
  const dir = mkdtempSync(join(tmpdir(), "factory-floor-test-"));
  const flowPath = writeFlow(
    dir,
    `
cwd: ./does-not-exist
steps:
  - name: Step One
    prompt: do one
`,
  );
  const harness = new FakeHarness([ok()]);

  await assert.rejects(() => runFlow({ flowPath, verbose: false, harness }), FlowRunError);
  assert.equal(harness.calls.length, 0);
});

test("forwards harness tool calls to onToolCall with the step name, even when not verbose", async () => {
  const dir = mkdtempSync(join(tmpdir(), "factory-floor-test-"));
  const flowPath = writeFlow(
    dir,
    `
steps:
  - name: Only Step
    prompt: do it
`,
  );

  const harness: Harness = {
    async run(options) {
      options.onToolCall?.({ name: "Edit", detail: "src/a.ts" });
      options.onToolCall?.({ name: "Bash" });
      return ok();
    },
  };

  const calls: unknown[] = [];
  const result = await runFlow({
    flowPath,
    verbose: false,
    harness,
    onToolCall: (stepName, call) => calls.push([stepName, call]),
  });

  assert.equal(result.success, true);
  assert.deepEqual(calls, [
    ["Only Step", { name: "Edit", detail: "src/a.ts" }],
    ["Only Step", { name: "Bash" }],
  ]);
});
