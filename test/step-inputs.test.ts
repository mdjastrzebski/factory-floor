import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Harness, HarnessResult, HarnessRunOptions } from "../src/harness.ts";
import { FlowValidationError, parseFlow } from "../src/flow-schema.ts";
import { runFlow } from "../src/run-flow.ts";

function loadError(yamlText: string): string {
  try {
    parseFlow(yamlText, "flow.yaml");
  } catch (error) {
    assert.ok(error instanceof FlowValidationError);
    return error.message;
  }
  assert.fail("expected the flow to be rejected");
}

test("a step without an inputs key has inputs undefined and sees every flow input", () => {
  const flow = parseFlow(
    "inputs:\n  a: {}\nsteps:\n  - {name: s, prompt: '${{ inputs.a }}'}\n",
    "flow.yaml",
  );
  assert.equal(flow.steps[0].inputs, undefined);
});

test("list form binds every input by name to the flow input", () => {
  const flow = parseFlow(
    "inputs:\n  a: {}\n  b: {}\nsteps:\n  - {name: s, inputs: [a, b], prompt: '${{ inputs.a }}'}\n",
    "flow.yaml",
  );
  assert.deepEqual(flow.steps[0].inputs, [
    { id: "a", source: { kind: "flowInput", id: "a" } },
    { id: "b", source: { kind: "flowInput", id: "b" } },
  ]);
});

test("map form: by name, explicit binding, literal and default", () => {
  const flow = parseFlow(
    `
inputs:
  area: {}
steps:
  - id: s
    inputs:
      area:
      where: "\${{ inputs.area }}/lib"
      depth: thorough
      tone: { description: Voice, default: dry }
      extra: { required: false }
    prompt: p
`,
    "flow.yaml",
  );
  assert.deepEqual(flow.steps[0].inputs, [
    { id: "area", source: { kind: "flowInput", id: "area" } },
    { id: "where", source: { kind: "binding", template: "${{ inputs.area }}/lib" } },
    { id: "depth", source: { kind: "binding", template: "thorough" } },
    { id: "tone", description: "Voice", source: { kind: "value", value: "dry" } },
    { id: "extra", source: { kind: "value", value: "" } },
  ]);
});

test("by name takes precedence over the step input's default", () => {
  const flow = parseFlow(
    "inputs:\n  a: {}\nsteps:\n  - {name: s, inputs: {a: {default: d}}, prompt: p}\n",
    "flow.yaml",
  );
  assert.deepEqual(flow.steps[0].inputs, [{ id: "a", source: { kind: "flowInput", id: "a" } }]);
});

test("a step that declares inputs sees only those in its prompt", () => {
  const message = loadError(
    "inputs:\n  a: {}\n  b: {}\nsteps:\n  - {name: s, inputs: [a], prompt: '${{ inputs.b }}'}\n",
  );
  assert.match(message, /unknown input "b" in \$\{\{ inputs\.b \}\} at steps\.0\.prompt/);
  assert.match(
    loadError("inputs:\n  a: {}\nsteps:\n  - {name: s, inputs: [], prompt: '${{ inputs.a }}'}\n"),
    /unknown input "a"/,
  );
});

test("an input with no source fails to load, naming the step and input", () => {
  for (const inputs of ["[x]", "{x: }", "{x: {description: d}}", "{x: {required: true}}"]) {
    const message = loadError(`steps:\n  - {id: s, inputs: ${inputs}, prompt: p}\n`);
    assert.match(message, /step "s" input "x" has no source/, inputs);
  }
});

test("every load-time issue is reported at once, with its path", () => {
  const message = loadError(
    "steps:\n  - {id: s, inputs: [x], prompt: '${{ inputs.y }}'}\n  - {id: s, prompt: p}\n",
  );
  assert.match(message, /step "s" input "x" has no source.* at steps\.0\.inputs\.x/);
  assert.match(message, /unknown input "y".* at steps\.0\.prompt/);
  assert.match(message, /duplicate step id "s".* at steps\.1\.id/);
});

test("bindings are checked in flow scope", () => {
  const yaml = (binding: string) =>
    `inputs:\n  a: {}\nsteps:\n  - id: first\n    prompt: p\n  - id: s\n    inputs: {x: '${binding}'}\n    prompt: p\n  - id: later\n    prompt: p\n`;
  assert.match(loadError(yaml("${{ inputs.nope }}")), /step "s" input "x": unknown input "nope"/);
  assert.match(loadError(yaml("${{ steps.ghost.outputs.y }}")), /unknown step "ghost"/);
  assert.match(loadError(yaml("${{ steps.later.outputs.y }}")), /forward reference/);
  assert.match(loadError(yaml("${{ steps.s.outputs.y }}")), /forward reference/);
  assert.match(loadError(yaml("${{ steps.first.outputs.y }}")), /declares no output "y"/);
  assert.match(loadError(yaml("${{ outputs.y }}")), /unknown variable "outputs\.y"/);
  assert.doesNotThrow(() => parseFlow(yaml("${{ inputs.a }} ${{ run.dir }}"), "flow.yaml"));
});

test("step prompts cannot reference steps.* directly", () => {
  const message = loadError(
    "steps:\n  - {id: a, prompt: p}\n  - {id: b, prompt: '${{ steps.a.outputs.x }}'}\n",
  );
  assert.match(message, /unknown variable "steps\.a\.outputs\.x"/);
});

test("bad step input definitions are rejected", () => {
  assert.match(
    loadError("steps:\n  - {id: s, inputs: [x, x], prompt: p}\n"),
    /duplicate input "x" at steps\.0\.inputs/,
  );
  assert.match(loadError("steps:\n  - {id: s, inputs: [Bad], prompt: p}\n"), /input id must/);
  assert.match(
    loadError("steps:\n  - {id: s, inputs: {x: {default: d, required: true}}, prompt: p}\n"),
    /step "s" input "x" has a default, so it cannot be required: true/,
  );
  assert.match(
    loadError("steps:\n  - {id: s, inputs: {x: 5}, prompt: p}\n"),
    /step input must be a binding string/,
  );
  assert.match(loadError("steps:\n  - {id: s, inputs: a, prompt: p}\n"), /step inputs must be/);
});

class FakeHarness implements Harness {
  calls: HarnessRunOptions[] = [];
  async run(options: HarnessRunOptions): Promise<HarnessResult> {
    this.calls.push(options);
    return { success: true, exitCode: 0, stdout: "", stderr: "" };
  }
}

test("runFlow renders each step's prompt with its own resolved inputs", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "factory-floor-step-inputs-")));
  const flowPath = join(dir, "flow.yaml");
  writeFileSync(
    flowPath,
    `
inputs:
  area: {}
  branch: { default: main }
steps:
  - id: all
    prompt: "\${{ inputs.area }} \${{ inputs.branch }}"
  - id: own
    inputs:
      area:
      where: "\${{ inputs.area }}/\${{ inputs.branch }} in \${{ step.id }}"
      depth: thorough
      tone: { default: dry }
    prompt: "[\${{ inputs.area }}] [\${{ inputs.where }}] [\${{ inputs.depth }}] [\${{ inputs.tone }}]"
`,
    "utf8",
  );
  const harness = new FakeHarness();
  const result = await runFlow({ flowPath, verbose: false, harness, inputs: ["area=src"] });
  assert.equal(result.success, true);
  assert.equal(harness.calls[0].prompt, "src main");
  assert.equal(harness.calls[1].prompt, "[src] [src/main in own] [thorough] [dry]");
});
