import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BUILTIN_VARIABLES,
  TemplateSyntaxError,
  buildVariables,
  checkReferences,
  parseTemplate,
  renderTemplate,
} from "../src/template.ts";

test("parseTemplate splits text and references, keeping the raw source", () => {
  assert.deepEqual(parseTemplate("a ${{ inputs.x }} b"), [
    { kind: "text", text: "a " },
    { kind: "ref", name: "inputs.x", raw: "${{ inputs.x }}" },
    { kind: "text", text: " b" },
  ]);
  assert.deepEqual(parseTemplate(""), []);
  assert.deepEqual(parseTemplate("plain"), [{ kind: "text", text: "plain" }]);
});

test("whitespace around the name is optional; spaces and tabs are allowed", () => {
  for (const source of [
    "${{inputs.x}}",
    "${{ inputs.x }}",
    "${{   inputs.x   }}",
    "${{\tinputs.x\t}}",
  ]) {
    const segments = parseTemplate(source);
    assert.equal(segments.length, 1);
    assert.deepEqual(segments[0], { kind: "ref", name: "inputs.x", raw: source });
  }
});

test("adjacent and repeated references", () => {
  assert.deepEqual(
    parseTemplate("${{a}}${{ b }}${{a}}").map((s) => (s.kind === "ref" ? s.name : s.text)),
    ["a", "b", "a"],
  );
});

test("unterminated, empty and invalid references throw TemplateSyntaxError", () => {
  for (const bad of [
    "oops ${{ inputs.x",
    "${{",
    "${{ }}",
    "${{}}",
    "${{ inputs.idea | upper }}",
    "${{ inputs['x'] }}",
    "${{ a b }}",
    "${{ .x }}",
    "${{ x. }}",
    "${{ a..b }}",
    "${{ a\nb }}",
  ]) {
    assert.throws(() => parseTemplate(bad), TemplateSyntaxError, bad);
  }
  assert.throws(() => parseTemplate("${{ }}"), /empty reference/);
  assert.throws(() => parseTemplate("x ${{ a"), /unterminated/);
  assert.throws(() => parseTemplate("${{ a b }}"), /invalid reference \$\{\{ a b \}\}/);
});

test("a lone $, {{ without $, and ${ without a second { are literal text", () => {
  for (const literal of ["cost: $5", "{{ x }}", "${ x }", "$ {{ x }}", "a } b }} c", "$$"]) {
    assert.deepEqual(parseTemplate(literal), [{ kind: "text", text: literal }]);
    assert.equal(renderTemplate(literal, {}), literal);
  }
});

test("$${{ escapes a literal ${{ and is not a reference", () => {
  assert.deepEqual(parseTemplate("a $${{ b"), [{ kind: "text", text: "a ${{ b" }]);
  assert.equal(renderTemplate("$${{ secrets.TOKEN }}", {}), "${{ secrets.TOKEN }}");
  assert.equal(renderTemplate("$${{", {}), "${{");
  assert.equal(renderTemplate("$$${{ x }}", {}), "$${{ x }}");
  assert.deepEqual(checkReferences("token: $${{ secrets.TOKEN }}", []), []);
  assert.deepEqual(checkReferences("unterminated $${{ ok", []), []);
});

test("escaped and real references mix", () => {
  const template = "${{ inputs.a }} uses $${{ secrets.TOKEN }} and $${{${{ inputs.a }}}}";
  assert.deepEqual(checkReferences(template, ["a"]), []);
  assert.deepEqual(checkReferences(template, []), ['unknown input "a" in ${{ inputs.a }}']);
  assert.equal(
    renderTemplate(template, { "inputs.a": "X" }),
    "X uses ${{ secrets.TOKEN }} and ${{X}}",
  );
});

test("renderTemplate substitutes every occurrence", () => {
  assert.equal(renderTemplate("${{ a }}-${{b}}-${{ a }}", { a: "1", b: "2" }), "1-2-1");
});

test("renderTemplate inserts values verbatim and never re-scans them", () => {
  assert.equal(renderTemplate("x ${{ a }} y", { a: "${{ b }}", b: "NO" }), "x ${{ b }} y");
  assert.equal(renderTemplate("${{ a }}", { a: "${{ unterminated" }), "${{ unterminated");
  assert.equal(renderTemplate("${{ a }}", { a: "line1\nline2 a=b $&" }), "line1\nline2 a=b $&");
});

test("renderTemplate throws for a name missing from vars", () => {
  assert.throws(() => renderTemplate("${{ nope }}", {}), /nope/);
  assert.throws(() => renderTemplate("${{ toString }}", {}), /toString/);
});

test("checkReferences accepts built-ins and declared inputs", () => {
  const text = BUILTIN_VARIABLES.map((name) => `\${{ ${name} }}`).join(" ") + " ${{ inputs.a }}";
  assert.deepEqual(checkReferences(text, ["a"]), []);
  assert.deepEqual(checkReferences("no refs", []), []);
});

test("checkReferences reports undeclared inputs, unknown variables and syntax errors", () => {
  assert.deepEqual(checkReferences("${{ inputs.foo }}", ["a"]), [
    'unknown input "foo" in ${{ inputs.foo }}',
  ]);
  for (const name of ["run.foo", "flow", "inputs", "step.name", "env.HOME"]) {
    const [message, ...rest] = checkReferences(`\${{ ${name} }}`, []);
    assert.equal(rest.length, 0);
    assert.match(message, new RegExp(`unknown variable "${name}"`));
  }
  assert.equal(checkReferences("${{ inputs.a | x }}", ["a"]).length, 1);
  assert.equal(checkReferences("${{ inputs.a", ["a"]).length, 1);
});

test("buildVariables supplies every built-in and input that checkReferences accepts", () => {
  const text = BUILTIN_VARIABLES.map((name) => `\${{ ${name} }}`).join(" ") + " ${{ inputs.a }}";
  assert.deepEqual(checkReferences(text, ["a"]), []);
  const vars = buildVariables({
    flow: { id: "f", name: "F" },
    cwd: "/cwd",
    runId: "r1",
    runDir: "/cwd/runs/r1",
    stepId: "s1",
    inputs: { a: "A" },
  });
  assert.deepEqual(Object.keys(vars).sort(), [...BUILTIN_VARIABLES, "inputs.a"].sort());
  assert.equal(renderTemplate(text, vars), "f F /cwd r1 /cwd/runs/r1 s1 A");
});
