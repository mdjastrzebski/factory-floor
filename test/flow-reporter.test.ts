import { test } from "node:test";
import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { createFlowReporter } from "../src/terminal/flow-reporter.ts";
import { FlowRunError, type StepCompleteInfo } from "../src/run-flow.ts";
import type { Spinner } from "../src/terminal/spinner.ts";

/** Records every terminal call, in order, as `<channel> <plain text>`. */
function setup(verbose: boolean) {
  const calls: string[] = [];
  const rec = (channel: string) => (message: string) => {
    calls.push(`${channel} ${stripVTControlCharacters(message)}`);
  };
  let spinners = 0;
  const createSpinner = (): Spinner => {
    const id = ++spinners;
    return {
      start: rec(`spinner${id}.start`),
      message: rec(`spinner${id}.message`),
      erase: () => calls.push(`spinner${id}.erase`),
      stop: rec(`spinner${id}.stop`),
      error: rec(`spinner${id}.error`),
      cancel: rec(`spinner${id}.cancel`),
    };
  };
  const reporter = createFlowReporter({
    verbose,
    print: { log: rec("print.log"), error: rec("print.error") },
    log: { warn: rec("log.warn"), error: rec("log.error") },
    outro: rec("outro"),
    createSpinner,
    cwd: "/work",
  });
  return { reporter, calls };
}

function complete(overrides: Partial<StepCompleteInfo> = {}): StepCompleteInfo {
  return {
    index: 1,
    total: 2,
    name: "plan",
    success: true,
    durationMs: 1234,
    logPath: "/work/.factory-floor/runs/r1/plan.log",
    ...overrides,
  };
}

const runDir = "/work/.factory-floor/runs/r1";

test("spinner mode: renders a successful run", () => {
  const { reporter, calls } = setup(false);
  reporter.onStepStart({ index: 1, total: 2, name: "plan" });
  reporter.onToolCall!("plan", { name: "Bash", activity: "Running", detail: "cd /x && ls   -la" });
  reporter.onToolCall!("other", { name: "Read" });
  reporter.onToolCall!("plan", { name: "Read" });
  reporter.onWarning("plan", "permission denied: rm");
  reporter.onStepComplete(complete());
  reporter.onStepStart({ index: 2, total: 2, name: "build" });
  reporter.onStepComplete(complete({ index: 2, name: "build", durationMs: 50 }));
  const code = reporter.finish({ success: true, runDir }, 3000);

  assert.equal(code, 0);
  assert.deepEqual(calls, [
    "spinner1.start [1/2] plan",
    "spinner1.message [1/2] plan → Running: ls -la (#1)",
    "spinner1.message [1/2] plan → Read (#2)",
    "spinner1.erase",
    "log.warn [plan] permission denied: rm",
    "spinner1.stop ✓ plan (1.2s)",
    "spinner2.start [2/2] build",
    "spinner2.stop ✓ build (0.1s)",
    "outro ✓ Flow succeeded: 2 steps in 3.0s logs: .factory-floor/runs/r1",
  ]);
});

test("spinner mode: truncates long tool-call details", () => {
  const { reporter, calls } = setup(false);
  reporter.onStepStart({ index: 1, total: 1, name: "s" });
  reporter.onToolCall!("s", { name: "Bash", detail: "x".repeat(80) });
  assert.equal(calls[1], `spinner1.message [1/1] s → Bash: ${"x".repeat(49)}… (#1)`);
});

test("spinner mode: a failed step points the summary at its log", () => {
  const { reporter, calls } = setup(false);
  reporter.onStepStart({ index: 1, total: 1, name: "plan" });
  reporter.onStepComplete(complete({ total: 1, success: false }));
  const code = reporter.finish({ success: false, failedStepName: "plan", runDir }, 2000);

  assert.equal(code, 1);
  assert.deepEqual(calls, [
    "spinner1.start [1/1] plan",
    "spinner1.error ✗ plan (1.2s)",
    'outro ✗ Flow failed at step "plan" after 2.0s log: .factory-floor/runs/r1/plan.log',
  ]);
});

test("spinner mode: cancel stops the spinner once and the later completion is ignored", () => {
  const { reporter, calls } = setup(false);
  reporter.onStepStart({ index: 1, total: 1, name: "plan" });
  reporter.cancel();
  reporter.onToolCall!("plan", { name: "Read" });
  reporter.onStepComplete(complete({ total: 1, success: false }));
  const code = reporter.finish({ success: false, failedStepName: "plan", runDir }, 500);

  assert.equal(code, 1);
  assert.deepEqual(calls, [
    "spinner1.start [1/1] plan",
    "spinner1.cancel plan cancelled",
    'outro Flow cancelled during step "plan" after 0.5s log: .factory-floor/runs/r1/plan.log',
  ]);
});

test("cancel with no active step warns instead", () => {
  const { reporter, calls } = setup(false);
  reporter.cancel();
  assert.deepEqual(calls, ["log.warn Received SIGINT, stopping the current step..."]);
});

test("fail stops the active spinner, then reports the error", () => {
  const { reporter, calls } = setup(false);
  reporter.onStepStart({ index: 1, total: 1, name: "plan" });
  const code = reporter.fail(new FlowRunError("cwd does not exist"));

  assert.equal(code, 1);
  assert.deepEqual(calls, [
    "spinner1.start [1/1] plan",
    "spinner1.error ✗ plan",
    "log.error cwd does not exist",
    "outro ✗ Flow failed",
  ]);
});

test("fail prints the stack of an unexpected error", () => {
  const { reporter, calls } = setup(false);
  const error = new Error("boom");
  reporter.fail(error);
  assert.equal(calls[0], `log.error ${error.stack}`);
  reporter.fail("plain");
  assert.equal(calls[2], "log.error plain");
});

test("verbose mode: prints plain lines and no spinner", () => {
  const { reporter, calls } = setup(true);
  assert.equal(reporter.onToolCall, undefined);
  reporter.onStepStart({ index: 1, total: 1, name: "plan" });
  reporter.onWarning("plan", "permission denied: rm");
  reporter.onStepComplete(complete({ total: 1 }));
  const code = reporter.finish({ success: true, runDir }, 1000);

  assert.equal(code, 0);
  assert.deepEqual(calls, [
    "print.log [1/1] plan...",
    "print.error warning: [plan] permission denied: rm",
    "print.log [1/1] plan done (1.2s)",
    "outro ✓ Flow succeeded: 1 step in 1.0s logs: .factory-floor/runs/r1",
  ]);
});

test("verbose mode: a failed step prints its log path", () => {
  const { reporter, calls } = setup(true);
  reporter.onStepStart({ index: 1, total: 1, name: "plan" });
  reporter.onStepComplete(complete({ total: 1, success: false }));
  reporter.finish({ success: false, failedStepName: "plan", runDir }, 1000);

  assert.deepEqual(calls, [
    "print.log [1/1] plan...",
    "print.error [1/1] plan failed (1.2s)",
    "print.error   log: .factory-floor/runs/r1/plan.log",
    'outro ✗ Flow failed at step "plan" after 1.0s log: .factory-floor/runs/r1/plan.log',
  ]);
});

test("verbose mode: cancel warns, and the summary says cancelled", () => {
  const { reporter, calls } = setup(true);
  reporter.onStepStart({ index: 1, total: 1, name: "plan" });
  reporter.cancel();
  reporter.onStepComplete(complete({ total: 1, success: false }));
  reporter.finish({ success: false, failedStepName: "plan", runDir }, 1000);

  assert.deepEqual(calls.slice(1), [
    "log.warn Received SIGINT, stopping the current step...",
    "print.error [1/1] plan failed (1.2s)",
    "print.error   log: .factory-floor/runs/r1/plan.log",
    'outro Flow cancelled during step "plan" after 1.0s log: .factory-floor/runs/r1/plan.log',
  ]);
});

test("summary falls back to the run directory when no step log was recorded", () => {
  const { reporter, calls } = setup(false);
  reporter.finish({ success: false, failedStepName: "plan", runDir: "/elsewhere/run" }, 0);
  assert.deepEqual(calls, ['outro ✗ Flow failed at step "plan" after 0.0s log: /elsewhere/run']);
});
