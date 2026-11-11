import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Harness, HarnessRunOptions } from "../src/harness.ts";
import type { FlowReporter } from "../src/terminal/flow-reporter.ts";
import { buildProgram, type CliProcess } from "../src/program.ts";

function writeFlow(yamlText: string): string {
  const dir = mkdtempSync(join(tmpdir(), "factory-floor-program-test-"));
  const flowPath = join(dir, "flow.yaml");
  writeFileSync(flowPath, yamlText, "utf8");
  return flowPath;
}

class FakeProcess implements CliProcess {
  sigintListeners: Array<() => void> = [];
  stdoutText = "";
  stderrText = "";
  exitCode?: number | string | null;
  stdout = { write: (chunk: string) => (this.stdoutText += chunk) };
  stderr = { write: (chunk: string) => (this.stderrText += chunk) };

  once(_event: "SIGINT", listener: () => void): void {
    this.sigintListeners.push(listener);
  }

  off(_event: "SIGINT", listener: () => void): void {
    this.sigintListeners = this.sigintListeners.filter((l) => l !== listener);
  }

  sigint(): void {
    for (const listener of this.sigintListeners) listener();
  }
}

function recordingReporter(events: string[]): FlowReporter {
  return {
    onFlowStart: () => {},
    onStepStart: () => {},
    onWarning: () => {},
    onStepComplete: () => {},
    cancel: () => events.push("reporter.cancel"),
    finish: (result) => {
      events.push("reporter.finish");
      return result.success ? 0 : 1;
    },
    fail: () => {
      events.push("reporter.fail");
      return 1;
    },
  };
}

test("SIGINT cancels the reporter before aborting the harness, then unregisters", async () => {
  const flowPath = writeFlow("steps:\n  - name: Slow\n    prompt: wait\n");
  const proc = new FakeProcess();
  const events: string[] = [];

  const harness: Harness = {
    run: ({ signal }: HarnessRunOptions) =>
      new Promise((resolve) => {
        signal?.addEventListener("abort", () => {
          events.push("signal.abort");
          resolve({ success: false, exitCode: null, stdout: "", stderr: "aborted" });
        });
        proc.sigint();
      }),
  };

  await buildProgram({
    createHarness: () => harness,
    proc,
    createReporter: () => recordingReporter(events),
  }).parseAsync(["run", flowPath], { from: "user" });

  assert.deepEqual(events, ["reporter.cancel", "signal.abort", "reporter.finish"]);
  assert.equal(proc.exitCode, 1);
  assert.equal(proc.sigintListeners.length, 0);
});

test("--verbose streams prefixed harness output to the process streams", async () => {
  const flowPath = writeFlow("steps:\n  - name: Talk\n    prompt: hi\n");
  const proc = new FakeProcess();
  let verboseSeen: boolean | undefined;

  const harness: Harness = {
    run: async ({ onOutputChunk }: HarnessRunOptions) => {
      onOutputChunk?.("hello\n", "stdout");
      onOutputChunk?.("oops\n", "stderr");
      return { success: true, exitCode: 0, stdout: "hello\n", stderr: "oops\n" };
    },
  };

  await buildProgram({
    createHarness: () => harness,
    proc,
    createReporter: (verbose) => {
      verboseSeen = verbose;
      return recordingReporter([]);
    },
  }).parseAsync(["run", "--verbose", flowPath], { from: "user" });

  assert.equal(verboseSeen, true);
  assert.equal(proc.stdoutText, "[talk:stdout] hello\n");
  assert.equal(proc.stderrText, "[talk:stderr] oops\n");
  assert.equal(proc.exitCode, 0);
});
