# ADR 01: Flow and step inputs and outputs

- Status: Proposed
- Date: 2026-11-11

## Context

Flows declare `inputs` that step prompts reference as `${{ inputs.<id> }}`. Steps cannot yet
produce values for later steps; today they share data through ad-hoc files (e.g. `TEST_PLAN.md`).
We need step outputs, a way to feed them into later steps, and a clear distinction between the
flow's interface and each step's interface.

## Decision

### Two scopes, same shape

|          | `inputs`                                         | `outputs`                                     |
| -------- | ------------------------------------------------ | --------------------------------------------- |
| **Flow** | Supplied by the caller (`--input area=src/`)     | Returned by the flow (`<runDir>/outputs.json`) |
| **Step** | Values the step's prompt needs                   | Values the step produces                      |

- In a **step prompt**, `${{ inputs.x }}` is that step's own input and `${{ outputs.x }}` is the
  file path where that step writes output `x`. Prompts never reference other steps or flow
  inputs directly.
- In a **binding** (the value of a step input or a flow output), expressions are evaluated in flow
  scope: `${{ inputs.x }}` is a flow input, `${{ steps.<id>.outputs.<name> }}` is a step output.

### Syntax

```yaml
inputs:
  area: { default: src/ }

outputs:
  report:                      # by name: last step that outputs `report`

steps:
  - id: identify
    inputs: [area]             # by name → flow input `area`
    outputs:
      plan: Prioritized test scenarios, markdown
    prompt: Find untested behaviors in ${{ inputs.area }}.

  - id: review
    inputs:
      plan:                    # by name → identify.plan
      notes: ${{ steps.identify.outputs.plan }}   # explicit binding
      depth: thorough          # literal
    outputs:
      report:
    prompt: Review against ${{ inputs.plan }}. Notes: ${{ inputs.notes }}
```

- `inputs: [a, b]`: list form, every input is bound by name.
- `inputs: { a: <binding or definition> }`: map form. The value is a literal, a template, or
  null/definition (`description`, `default`, `required`, as for flow inputs).
- `outputs: { name: <description> }` or `{ name: { description, required } }`. Outputs are
  required by default.
- Step without an `inputs` key: it sees all flow inputs (the current behavior). Once a step
  declares `inputs`, it sees only those.

### Resolution

A step input (or flow output) resolves to the first of these that applies:

1. Its explicit binding, if it has one.
2. By name: the nearest preceding step output with that name, then the flow input with that name.
3. The input's `default`.
4. Otherwise the flow fails to load, with an error naming the step and input.

A later step output with the same name shadows earlier outputs and flow inputs. This is deliberate,
so refinement steps can re-emit a value such as `plan`.

All references are resolved when the flow loads. Unknown steps, forward references and undeclared
outputs are errors. A dry run can print the resolved wiring (`review.plan ← identify.plan`).

### Producing outputs

- Before a step runs, the runner sets aside `<runDir>/<stepId>/outputs/<name>` for each output and
  appends an instruction to the prompt listing each output's path and description.
- After a successful run, the runner reads each file and trims the trailing newline.
- A missing required output fails the step. A missing optional output resolves to `""`.
- Output values are substituted into prompts verbatim.

## Consequences

- Linear flows stay short (`inputs: [plan]`). Explicit bindings are needed only for renames,
  literals and composed values.
- Step prompts depend only on their own declared interface, so a step can later move into its own
  file and be reused.
- Declared step inputs already give the dependency graph, so parallel/DAG execution and nested
  flows (a flow used as a step) need no new syntax.
- Name-based wiring is implicit. Load-time validation and the dry-run wiring view keep it visible.
- Deferred: `steps.<id>.result` (the agent's final message) was considered as an automatic
  output. It is deferred until there is a need for it.

## Open questions

- Should shadowing a flow input with a step output need an explicit binding instead of happening
  silently?
- Should there be a size limit, or truncation, for output values substituted into prompts?
