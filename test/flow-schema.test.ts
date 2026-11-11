import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadFlow, parseFlow, FlowValidationError } from "../src/flow-schema.ts";

test("parses a minimal valid flow (steps only)", () => {
  const flow = parseFlow(
    `
steps:
  - name: step-one
    prompt: |
      Do the first thing.
`,
    "flow.yaml",
  );
  assert.equal(flow.id, "flow");
  assert.equal(flow.name, "flow");
  assert.equal(flow.cwd, undefined);
  assert.equal(flow.steps.length, 1);
  assert.equal(flow.steps[0].name, "step-one");
  assert.equal(flow.steps[0].prompt, "Do the first thing.\n");
});

test("parses a full valid flow with name, cwd, and multiple steps", () => {
  const flow = parseFlow(
    `
name: my-flow
cwd: ./somewhere
steps:
  - name: step-one
    prompt: Do the first thing.
  - name: step-two
    prompt: Do the second thing.
`,
    "flow.yaml",
  );
  assert.equal(flow.name, "my-flow");
  assert.equal(flow.cwd, "./somewhere");
  assert.equal(flow.steps.length, 2);
  assert.deepEqual(
    flow.steps.map((s) => s.name),
    ["step-one", "step-two"],
  );
});

test("rejects a flow with no steps field", () => {
  assert.throws(() => parseFlow("name: my-flow\n", "flow.yaml"), FlowValidationError);
});

test("rejects a flow with an empty steps array", () => {
  assert.throws(() => parseFlow("steps: []\n", "flow.yaml"), FlowValidationError);
});

test("rejects a step missing a name", () => {
  assert.throws(
    () =>
      parseFlow(
        `
steps:
  - prompt: Do something.
`,
        "flow.yaml",
      ),
    FlowValidationError,
  );
});

test("rejects a step missing a prompt", () => {
  assert.throws(
    () =>
      parseFlow(
        `
steps:
  - name: step-one
`,
        "flow.yaml",
      ),
    FlowValidationError,
  );
});

test("rejects a step with a non-string prompt", () => {
  assert.throws(
    () =>
      parseFlow(
        `
steps:
  - name: step-one
    prompt: 12345
`,
        "flow.yaml",
      ),
    FlowValidationError,
  );
});

test("rejects duplicate step names", () => {
  assert.throws(() => {
    try {
      parseFlow(
        `
steps:
  - name: step-one
    prompt: Do the first thing.
  - name: step-one
    prompt: Do it again.
`,
        "flow.yaml",
      );
    } catch (error) {
      assert.ok(error instanceof FlowValidationError);
      assert.match(error.message, /duplicate step name/);
      throw error;
    }
  }, FlowValidationError);
});

test("rejects malformed YAML with a clear error", () => {
  assert.throws(() => parseFlow("steps: [\n", "flow.yaml"), FlowValidationError);
});

test("error message includes the flow path", () => {
  try {
    parseFlow("name: my-flow\n", "/some/path/flow.yaml");
    assert.fail("expected parseFlow to throw");
  } catch (error) {
    assert.ok(error instanceof FlowValidationError);
    assert.match(error.message, /\/some\/path\/flow\.yaml/);
  }
});

test("flow id defaults to a slug of the file name; name defaults to the id", () => {
  const flow = parseFlow("steps:\n  - {name: a, prompt: p}\n", "/x/Add Missing Tests.yaml");
  assert.equal(flow.id, "add-missing-tests");
  assert.equal(flow.name, "add-missing-tests");
});

test("explicit flow id and human-readable name are kept as-is", () => {
  const flow = parseFlow(
    "id: add-tests\nname: Add missing tests\nsteps:\n  - {name: a, prompt: p}\n",
    "flow.yaml",
  );
  assert.equal(flow.id, "add-tests");
  assert.equal(flow.name, "Add missing tests");
});

test("step id and name: explicit, id-only, and name-only steps resolve both", () => {
  const flow = parseFlow(
    `
steps:
  - id: plan
    name: Plan the work
    prompt: p
  - id: build
    prompt: p
  - name: Review & Refine
    prompt: p
`,
    "flow.yaml",
  );
  assert.deepEqual(
    flow.steps.map(({ id, name }) => ({ id, name })),
    [
      { id: "plan", name: "Plan the work" },
      { id: "build", name: "build" },
      { id: "review-refine", name: "Review & Refine" },
    ],
  );
});

test("derived step ids never take an explicit id; they get a suffix instead", () => {
  const flow = parseFlow(
    "steps:\n  - {name: Build, prompt: p}\n  - {id: build, name: Other, prompt: p}\n",
    "flow.yaml",
  );
  assert.deepEqual(
    flow.steps.map((s) => s.id),
    ["build-2", "build"],
  );
});

test("rejects a step with neither id nor name", () => {
  assert.throws(
    () => parseFlow("steps:\n  - prompt: p\n", "flow.yaml"),
    /step must have an id or a name/,
  );
});

test("rejects ids that are not lowercase slugs", () => {
  for (const id of ["Plan", "-plan", "plan step", "plan.step"]) {
    assert.throws(
      () => parseFlow(`steps:\n  - {id: "${id}", prompt: p}\n`, "flow.yaml"),
      /step id must start with a lowercase letter or digit/,
      id,
    );
  }
  assert.throws(
    () => parseFlow("id: My Flow\nsteps:\n  - {id: a, prompt: p}\n", "flow.yaml"),
    /flow id must start/,
  );
});

test("rejects duplicate step ids, even with different names", () => {
  assert.throws(
    () =>
      parseFlow(
        "steps:\n  - {id: a, name: One, prompt: p}\n  - {id: a, name: Two, prompt: p}\n",
        "flow.yaml",
      ),
    /duplicate step id "a"/,
  );
});

test("allows duplicate step names when the steps have distinct ids", () => {
  const flow = parseFlow(
    "steps:\n  - {id: a, name: Check, prompt: p}\n  - {id: b, name: Check, prompt: p}\n",
    "flow.yaml",
  );
  assert.deepEqual(
    flow.steps.map((s) => s.id),
    ["a", "b"],
  );
});

function validationMessage(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof FlowValidationError, `expected FlowValidationError, got ${e}`);
    return e.message;
  }
  assert.fail("expected throw");
}

test("loadFlow: a missing path or a directory gives a FlowValidationError", () => {
  const dir = mkdtempSync(join(tmpdir(), "ff-"));
  assert.match(
    validationMessage(() => loadFlow(join(dir, "nope.yaml"))),
    /^Failed to read flow file .*nope\.yaml: /,
  );
  assert.match(
    validationMessage(() => loadFlow(dir)),
    /^Failed to read flow file /,
  );
});

test("empty, null, list and scalar documents are validation errors", () => {
  for (const text of ["", "null\n", "- a\n- b\n", "42\n", "just text\n"]) {
    assert.match(
      validationMessage(() => parseFlow(text, "f.yaml")),
      /^Invalid flow file f\.yaml:\n/,
      JSON.stringify(text),
    );
  }
});

test("lists every issue with a dotted path; root issues have no ' at'", () => {
  const m = validationMessage(() =>
    parseFlow("steps:\n  - {name: a}\n  - {prompt: p}\n", "f.yaml"),
  );
  assert.match(m, /at steps\.0\.prompt/);
  assert.match(m, /at steps\.1\.name/);
  assert.doesNotMatch(
    validationMessage(() => parseFlow("[]", "f.yaml")),
    / at /,
  );
});
