import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { execFileSync } from "node:child_process";
import type { Harness, HarnessResult, HarnessRunOptions } from "../src/harness.ts";
import { FlowValidationError, parseFlow } from "../src/flow-schema.ts";
import { FlowRunError, resolveInputs, runFlow } from "../src/run-flow.ts";

class FakeHarness implements Harness {
  calls: HarnessRunOptions[] = [];
  private results: HarnessResult[];

  constructor(results: HarnessResult[]) {
    this.results = results;
  }

  async run(options: HarnessRunOptions): Promise<HarnessResult> {
    this.calls.push(options);
    const result = this.results[this.calls.length - 1];
    if (!result) throw new Error("FakeHarness has no scripted result left");
    return result;
  }
}

const ok = (stdout = "ok"): HarnessResult => ({ success: true, exitCode: 0, stdout, stderr: "" });

function setup(yamlText: string, results: HarnessResult[] = [ok(), ok(), ok()]) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "factory-floor-inputs-test-")));
  const flowPath = join(dir, "flow.yaml");
  writeFileSync(flowPath, yamlText, "utf8");
  return { dir, flowPath, harness: new FakeHarness(results) };
}

const FLOW = `
id: demo
name: Demo flow
inputs:
  idea:
    description: The idea
  branch:
    default: main
  note:
    required: false
steps:
  - id: spec
    prompt: "idea=[\${{ inputs.idea }}] branch=[\${{inputs.branch}}] note=[\${{   inputs.note   }}]"
  - id: build
    prompt: |
      step=\${{ step.id }} flow=\${{ flow.id }}/\${{ flow.name }} cwd=\${{ flow.cwd }}
      run=\${{ run.id }} dir=\${{ run.dir }} again=\${{ inputs.idea }}
`;

test("the harness receives fully substituted prompts, including built-ins", async () => {
  const { dir, flowPath, harness } = setup(FLOW, [ok(), ok()]);
  const result = await runFlow({
    flowPath,
    verbose: false,
    harness,
    inputs: ["idea=make it fast", "branch=dev"],
  });

  assert.equal(result.success, true);
  assert.equal(harness.calls[0].prompt, "idea=[make it fast] branch=[dev] note=[]");
  const runId = basename(result.runDir);
  assert.equal(
    harness.calls[1].prompt,
    `step=build flow=demo/Demo flow cwd=${dir}\nrun=${runId} dir=${result.runDir} again=make it fast\n`,
  );
  assert.equal(result.runDir, join(dir, ".factory-floor", "runs", runId));
});

test("multi-line values and values containing = are inserted verbatim, not re-expanded", async () => {
  const { flowPath, harness } = setup(FLOW, [ok(), ok()]);
  await runFlow({
    flowPath,
    verbose: false,
    harness,
    inputs: ["idea=a\nb=c", "branch=${{ inputs.idea }}", "note=q=a=b"],
  });
  assert.equal(harness.calls[0].prompt, "idea=[a\nb=c] branch=[${{ inputs.idea }}] note=[q=a=b]");
});

test("defaults apply when not supplied; optional inputs without a default are empty", async () => {
  const { flowPath, harness } = setup(FLOW, [ok(), ok()]);
  await runFlow({ flowPath, verbose: false, harness, inputs: ["idea=x"] });
  assert.equal(harness.calls[0].prompt, "idea=[x] branch=[main] note=[]");
});

test("--input with an empty value counts as supplied and satisfies required", async () => {
  const { flowPath, harness } = setup(FLOW, [ok(), ok()]);
  await runFlow({ flowPath, verbose: false, harness, inputs: ["idea=", "branch="] });
  assert.equal(harness.calls[0].prompt, "idea=[] branch=[] note=[]");
});

test("inputs.json holds the resolved values in declaration order, always written", async () => {
  const { flowPath, harness } = setup(FLOW, [ok(), ok()]);
  const result = await runFlow({ flowPath, verbose: false, harness, inputs: ["idea=x"] });
  const text = readFileSync(join(result.runDir, "inputs.json"), "utf8");
  assert.equal(text, JSON.stringify({ idea: "x", branch: "main", note: "" }, null, 2) + "\n");
  assert.deepEqual(Object.keys(JSON.parse(text)), ["idea", "branch", "note"]);

  const plain = setup("steps:\n  - {name: a, prompt: p}\n", [ok()]);
  const plainResult = await runFlow({
    flowPath: plain.flowPath,
    verbose: false,
    harness: plain.harness,
  });
  assert.equal(readFileSync(join(plainResult.runDir, "inputs.json"), "utf8"), "{}\n");
});

test("the step log starts with the rendered prompt", async () => {
  const { flowPath, harness } = setup(FLOW, [ok("OUT-1"), ok("OUT-2")]);
  const result = await runFlow({ flowPath, verbose: false, harness, inputs: ["idea=x"] });
  const log = readFileSync(join(result.runDir, "spec.log"), "utf8");
  assert.equal(
    log,
    "=== prompt ===\nidea=[x] branch=[main] note=[]\n=== stdout ===\nOUT-1\n=== stderr ===\n\n",
  );
});

test("a flow without inputs passes the prompt through unchanged", async () => {
  const { flowPath, harness } = setup(
    "steps:\n  - name: A\n    prompt: |\n      keep $5 and {{ x }} and ${ y } as is\n",
    [ok()],
  );
  const result = await runFlow({ flowPath, verbose: false, harness });
  assert.equal(harness.calls[0].prompt, "keep $5 and {{ x }} and ${ y } as is\n");
  assert.ok(
    readFileSync(join(result.runDir, "a.log"), "utf8").startsWith("=== prompt ===\nkeep $5"),
  );
});

const runTimeErrors: Array<[string, string[], RegExp]> = [
  ["missing required input", [], /missing required input "idea"/],
  [
    "unknown --input",
    ["idea=x", "foo=1"],
    /unknown input "foo" \(flow declares: idea, branch, note\)/,
  ],
  ["malformed --input without =", ["idea"], /invalid --input "idea": expected key=value/],
  ["malformed --input with empty key", ["=x"], /expected key=value/],
  ["duplicate --input", ["idea=a", "idea=b"], /duplicate --input "idea"/],
];

for (const [label, inputs, pattern] of runTimeErrors) {
  test(`run-time error (${label}) throws FlowRunError before any harness call or run dir`, async () => {
    const { dir, flowPath, harness } = setup(FLOW);
    await assert.rejects(
      () => runFlow({ flowPath, verbose: false, harness, inputs }),
      (error) => {
        assert.ok(error instanceof FlowRunError);
        assert.match(error.message, pattern);
        return true;
      },
    );
    assert.equal(harness.calls.length, 0);
    assert.equal(existsSync(join(dir, ".factory-floor")), false);
  });
}

test("every missing required input is listed at once", async () => {
  const { flowPath, harness } = setup(
    "inputs:\n  a: {}\n  b: {}\n  c: {default: z}\nsteps:\n  - {name: s, prompt: p}\n",
  );
  await assert.rejects(
    () => runFlow({ flowPath, verbose: false, harness }),
    /missing required input "a".*missing required input "b"/,
  );
});

test("--input for a flow that declares no inputs says so", async () => {
  const { dir, flowPath, harness } = setup("steps:\n  - {name: a, prompt: p}\n", [ok()]);
  await assert.rejects(
    () => runFlow({ flowPath, verbose: false, harness, inputs: ["x=1"] }),
    /unknown input "x" \(flow declares no inputs\)/,
  );
  assert.equal(harness.calls.length, 0);
  assert.equal(existsSync(join(dir, ".factory-floor")), false);
});

const loadTimeErrors: Array<[string, string]> = [
  ["undeclared input reference", "steps:\n  - {name: a, prompt: '${{ inputs.nope }}'}\n"],
  ["unknown variable", "steps:\n  - {name: a, prompt: '${{ run.nope }}'}\n"],
  ["malformed syntax", "steps:\n  - {name: a, prompt: '${{ oops'}\n"],
  [
    "default with required: true",
    "inputs:\n  a: {default: x, required: true}\nsteps:\n  - {name: a, prompt: p}\n",
  ],
];

for (const [label, yamlText] of loadTimeErrors) {
  test(`load-time error (${label}) rejects before any harness call or run dir`, async () => {
    const { dir, flowPath, harness } = setup(yamlText);
    await assert.rejects(() => runFlow({ flowPath, verbose: false, harness }), FlowValidationError);
    assert.equal(harness.calls.length, 0);
    assert.equal(existsSync(join(dir, ".factory-floor")), false);
  });
}

test("resolveInputs is pure: resolves values against a parsed flow", () => {
  const flow = parseFlow(
    "inputs:\n  a: {}\n  b: {default: d}\n  c: {required: false}\nsteps:\n  - {name: s, prompt: p}\n",
    "flow.yaml",
  );
  assert.deepEqual(resolveInputs(flow, ["a=1"]), { a: "1", b: "d", c: "" });
  assert.deepEqual(resolveInputs(flow, ["c=x=y", "a=", "b=z"]), { a: "", b: "z", c: "x=y" });
  assert.throws(() => resolveInputs(flow, []), FlowRunError);
});

const PROMPT_FLOW = `
inputs:
  idea: {}
  branch: {default: "\${{ git.branch }}"}
  note: {required: false}
steps:
  - id: s
    prompt: "\${{ inputs.idea }}|\${{ inputs.branch }}|\${{ inputs.note }}"
`;

test("a default can reference git.branch: the branch checked out in cwd", async () => {
  const { dir, flowPath, harness } = setup(PROMPT_FLOW);
  execFileSync("git", ["init", "-q", "-b", "feat/demo"], { cwd: dir });
  await runFlow({ flowPath, verbose: false, harness, inputs: ["idea=x"] });
  assert.equal(harness.calls[0].prompt, "x|feat/demo|");
});

test("git.branch is empty outside a git repo", async () => {
  const { flowPath, harness } = setup(PROMPT_FLOW);
  await runFlow({ flowPath, verbose: false, harness, inputs: ["idea=x"] });
  assert.equal(harness.calls[0].prompt, "x||");
});

test("promptInput asks for each unsupplied input in order, with its rendered default", async () => {
  const { dir, flowPath, harness } = setup(PROMPT_FLOW);
  execFileSync("git", ["init", "-q", "-b", "feat/demo"], { cwd: dir });
  const asked: unknown[] = [];
  await runFlow({
    flowPath,
    verbose: false,
    harness,
    inputs: ["note=n"],
    promptInput: async (input) => {
      asked.push(input);
      return input.id === "idea" ? "typed" : `${input.default}-edited`;
    },
  });
  assert.deepEqual(asked, [
    { id: "idea", required: true, default: "" },
    { id: "branch", required: false, default: "feat/demo" },
  ]);
  assert.equal(harness.calls[0].prompt, "typed|feat/demo-edited|n");
});
