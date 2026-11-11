import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Harness, HarnessResult, HarnessRunOptions } from "../src/harness.ts";
import { FlowValidationError } from "../src/flow-schema.ts";
import { runFlow, FlowRunError } from "../src/run-flow.ts";

function tmp(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "factory-floor-test-")));
}

function scripted(results: HarnessResult[]) {
  const calls: HarnessRunOptions[] = [];
  const harness: Harness = {
    async run(options) {
      calls.push(options);
      const next = results[calls.length - 1];
      if (next === undefined) throw new Error("no scripted result");
      return next;
    },
  };
  return { harness, calls };
}

const ok = (extra: Partial<HarnessResult> = {}): HarnessResult => ({
  success: true,
  exitCode: 0,
  stdout: "out",
  stderr: "err",
  ...extra,
});
const bad = (extra: Partial<HarnessResult> = {}): HarnessResult => ({
  success: false,
  exitCode: 1,
  stdout: "o",
  stderr: "e",
  ...extra,
});

function writeFlow(dir: string, text: string, file = "flow.yaml"): string {
  const p = join(dir, file);
  writeFileSync(p, text, "utf8");
  return p;
}

const oneStep = `steps:\n  - name: S\n    prompt: p\n`;

// ---- cwd resolution ----

test("cwd omitted defaults to the flow file's directory, not process.cwd()", async () => {
  const dir = tmp();
  const { harness, calls } = scripted([ok()]);
  const r = await runFlow({ flowPath: writeFlow(dir, oneStep), verbose: false, harness });
  assert.notEqual(dir, process.cwd());
  assert.equal(calls[0].cwd, dir);
  assert.ok(r.runDir.startsWith(join(dir, ".factory-floor", "runs")));
});

test("relative cwd resolves against the flow file's dir", async () => {
  const root = tmp();
  mkdirSync(join(root, "flows"));
  mkdirSync(join(root, "other"));
  const flowPath = writeFlow(root, `cwd: ../other\n${oneStep}`, "flows/flow.yaml");
  const { harness, calls } = scripted([ok()]);
  const r = await runFlow({ flowPath, verbose: false, harness });
  assert.equal(calls[0].cwd, join(root, "other"));
  assert.ok(r.runDir.startsWith(join(root, "other", ".factory-floor", "runs")));
});

test("absolute cwd is used as-is", async () => {
  const dir = tmp();
  const target = tmp();
  const { harness, calls } = scripted([ok()]);
  await runFlow({
    flowPath: writeFlow(dir, `cwd: ${JSON.stringify(target)}\n${oneStep}`),
    verbose: false,
    harness,
  });
  assert.equal(calls[0].cwd, target);
  assert.ok(!existsSync(join(dir, ".factory-floor")));
});

test("cwd pointing at a file throws FlowRunError 'is not a directory'", async () => {
  const dir = tmp();
  writeFileSync(join(dir, "afile"), "x");
  const { harness, calls } = scripted([ok()]);
  await assert.rejects(
    () =>
      runFlow({ flowPath: writeFlow(dir, `cwd: ./afile\n${oneStep}`), verbose: false, harness }),
    (e: Error) => e instanceof FlowRunError && /is not a directory/.test(e.message),
  );
  assert.equal(calls.length, 0);
});

test("a relative flow path resolves against process.cwd()", async () => {
  const dir = tmp();
  writeFlow(dir, oneStep);
  const { harness, calls } = scripted([ok()]);
  const original = process.cwd();
  let r;
  process.chdir(dir);
  try {
    r = await runFlow({ flowPath: "flow.yaml", verbose: false, harness });
  } finally {
    process.chdir(original);
  }
  assert.equal(calls[0].cwd, dir);
  assert.ok(r!.runDir.startsWith(join(dir, ".factory-floor", "runs")));
});

test("invalid flow YAML rejects with FlowValidationError before creating any run dir", async () => {
  const dir = tmp();
  const { harness, calls } = scripted([ok()]);
  await assert.rejects(
    () => runFlow({ flowPath: writeFlow(dir, "steps: []\n"), verbose: false, harness }),
    FlowValidationError,
  );
  assert.equal(calls.length, 0);
  assert.ok(!existsSync(join(dir, ".factory-floor")));
});

// ---- warnings, logs and abort ----

test("onWarning fires once per permission denial, only when there are denials", async () => {
  const dir = tmp();
  const { harness } = scripted([
    ok(),
    ok({ permissionDenials: [] }),
    ok({ permissionDenials: ["Bash: rm", "Edit: x"] }),
  ]);
  const warnings: Array<[string, string]> = [];
  await runFlow({
    flowPath: writeFlow(
      dir,
      `steps:\n  - {name: A, prompt: p}\n  - {name: B, prompt: p}\n  - {name: C, prompt: p}\n`,
    ),
    verbose: false,
    harness,
    onWarning: (s, m) => warnings.push([s, m]),
  });
  assert.deepEqual(warnings, [
    ["c", "permission denied: Bash: rm"],
    ["c", "permission denied: Edit: x"],
  ]);
});

test("warnings are emitted for a failing step, before onStepComplete", async () => {
  const dir = tmp();
  const { harness } = scripted([bad({ permissionDenials: ["nope"] })]);
  const events: string[] = [];
  await runFlow({
    flowPath: writeFlow(dir, oneStep),
    verbose: false,
    harness,
    onWarning: (s, m) => events.push(`warn:${s}:${m}`),
    onStepComplete: (i) => events.push(`complete:${i.success}`),
  });
  assert.deepEqual(events, ["warn:s:permission denied: nope", "complete:false"]);
});

test("log file has the exact stdout/stderr format, for successful and failed steps", async () => {
  const dir = tmp();
  const { harness } = scripted([
    ok({ stdout: "OUT", stderr: "ERR" }),
    bad({ stdout: "x", stderr: "y" }),
  ]);
  const r = await runFlow({
    flowPath: writeFlow(dir, `steps:\n  - {name: A, prompt: p}\n  - {name: B, prompt: p}\n`),
    verbose: false,
    harness,
  });
  assert.equal(
    readFileSync(join(r.runDir, "a.log"), "utf8"),
    "=== stdout ===\nOUT\n=== stderr ===\nERR\n",
  );
  assert.equal(
    readFileSync(join(r.runDir, "b.log"), "utf8"),
    "=== stdout ===\nx\n=== stderr ===\ny\n",
  );
});

test("signal is passed to every harness.run; an aborted signal fails step 1 and skips the rest", async () => {
  const dir = tmp();
  const ac = new AbortController();
  const calls: HarnessRunOptions[] = [];
  const harness: Harness = {
    async run(o) {
      calls.push(o);
      if (o.signal?.aborted)
        return { success: false, exitCode: null, stdout: "", stderr: "aborted" };
      return ok();
    },
  };
  const flowPath = writeFlow(dir, `steps:\n  - {name: A, prompt: p}\n  - {name: B, prompt: p}\n`);

  await runFlow({ flowPath, verbose: false, harness, signal: ac.signal });
  assert.equal(calls.length, 2);
  assert.ok(calls.every((c) => c.signal === ac.signal));

  calls.length = 0;
  ac.abort();
  const r = await runFlow({ flowPath, verbose: false, harness, signal: ac.signal });
  assert.equal(r.success, false);
  assert.equal(r.failedStepName, "A");
  assert.equal(calls.length, 1);
});
