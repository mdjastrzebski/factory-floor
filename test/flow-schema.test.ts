import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFlow, FlowValidationError } from "../src/flow-schema.ts";

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
  assert.equal(flow.name, undefined);
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
