# factory-floor

A small CLI that runs a "factory floor": a linear sequence of steps defined
in a YAML file, where each step hands a prompt to an AI coding agent
(currently the `claude` CLI, run headlessly) and lets it work, one step after
another, in a shared working directory.

Steps run strictly sequentially, each as an independent, fresh agent
invocation. There is no automatic context passing between steps — no
session resume, no piping one step's output into the next prompt. Steps
coordinate only through side effects on disk (files in the shared `cwd`)
that the prompts themselves describe, e.g. "read `TEST_PLAN.md` and
implement tests for it."

## Flow file format

A flow is a YAML file with this shape:

```yaml
# optional slug identifier; defaults to a slug of this file's name
id: my-flow
# optional human-readable title; defaults to `id`
name: My flow

# optional; defaults to the directory containing this flow file
cwd: ./somewhere

# optional; values supplied on the command line with --input key=value
inputs:
  idea:
    description: The rough idea to implement # optional
  branch:
    default: main # a default makes the input optional

steps:
  - id: step-one # optional slug identifier, unique within the flow
    name: Do the first thing # optional human-readable label
    prompt: | # required; multi-line via YAML block scalar
      Do the first thing. Be specific about what "done" looks like.

  - name: Step two # id defaults to a slug of the name: "step-two"
    prompt: |
      Do the second thing, coordinating with step one only via files
      already on disk in this directory. The idea is: ${{ inputs.idea }}
```

Naming follows GitHub Actions: `id` is the stable, machine-facing
identifier and `name` is what people read.

- `id` (top-level, optional) — the flow's slug identifier. Lowercase
  letters, digits, `-` and `_`, starting with a letter or digit. Defaults to
  a slug of the flow file's base name (`Add Tests.yaml` → `add-tests`), much
  like a GitHub workflow is identified by its file name.
- `name` (top-level, optional) — the flow's human-readable title, shown when
  the run starts. Defaults to `id`.
- `cwd` (optional) — the working directory every step runs in, resolved
  relative to the flow file's own directory if not absolute. Defaults to
  the directory containing the flow file. Shared across all steps.
- `inputs` (optional) — values the caller supplies per run; see
  [Inputs and template variables](#inputs-and-template-variables).
- `steps` (required, non-empty array) — run strictly in order. Each step
  needs an `id`, a `name`, or both:
  - `id` (optional, same format as the flow `id`, unique within the flow) —
    names the step's log file and prefixes its `--verbose` output and
    warnings. Defaults to a slug of `name`; if two steps' names slugify to
    the same id (or to another step's explicit id), later ones get `-2`,
    `-3`, etc.
  - `name` (optional, non-empty) — the label shown in progress output.
    Defaults to `id`. Steps without an `id` must have unique names.
  - `prompt` (required, non-empty string) — handed to the harness after
    `${{ … }}` references are substituted (see below). Text without `${{`
    is passed through unchanged.

The flow file is parsed with the `yaml` package and validated with `zod`
before anything runs. An invalid flow (missing `steps`, a step missing
both `id` and `name`, a step missing `prompt`, a malformed or duplicate step
`id`, a non-existent `cwd`, a bad `inputs:` definition, a prompt that
references an undeclared input, etc.) is
rejected with a clear error and a non-zero exit code, and no agent process
is spawned.

Each step is run as its own `claude -p "<prompt>" --permission-mode auto
--permission-prompts none` child process. `auto` mode uses a classifier to
approve ordinary file edits and declared-dependency commands (e.g.
`pnpm test`, `pnpm run lint`) unattended, while still blocking clearly risky
actions (force-push, `curl | bash`, deploys) - unlike `acceptEdits`, which
never approves arbitrary Bash, so a step whose prompt needs to run a
command would otherwise silently fail to do so. If the harness denies any
tool/permission request during a step, a `warning: [<step>] permission
denied: ...` line is printed to stderr regardless of `--verbose`, so a step
that didn't get to run its intended command doesn't look identical to one
that did.

v1 only supports this one harness; the `Harness` interface
(`src/harness.ts`) is written so other harnesses (the Claude Agent SDK,
Codex, ACP, ...) could be added later without changing how flows are
defined or run.

## Usage

```sh
factory-floor run <flow.yaml>
factory-floor run <flow.yaml> --verbose
factory-floor run <flow.yaml> --input key=value --input other=value
```

Default output is one terse line per step:

```
[1/3] identify-test-scenarios... done (4.2s)
[2/3] implement-and-run-tests... done (38.1s)
[3/3] review-and-refine-tests... failed (see log)
  log: examples/hello-flow/.factory-floor/runs/2026-01-01T12-00-00-000Z/review-and-refine-tests.log
Flow failed at step "review-and-refine-tests". Logs: examples/hello-flow/.factory-floor/runs/2026-01-01T12-00-00-000Z
```

The harness's own stdout/stderr is **not** printed by default. Pass
`--verbose` to additionally stream each step's raw output live to the
terminal as it's produced, prefixed with the step id and stream.

If any step exits non-zero, the flow stops immediately — later steps never
run — and `factory-floor` exits non-zero. If every step succeeds, it exits 0. Pressing Ctrl-C (SIGINT) while a step is running kills that step's
`claude` child process rather than leaving it running in the background.

### Inputs and template variables

A flow can declare `inputs:` so one flow file serves many tasks. The caller
supplies values with a repeatable `--input key=value` flag, and step
prompts reference them (and some built-in run variables) with `${{ … }}`.

```yaml
inputs:
  idea:
    description: The rough idea to implement # optional
    required: true # optional, default true
  branch:
    default: main # a default makes it optional
  note:
    required: false # optional, no default -> ""

steps:
  - id: spec
    prompt: |
      Write a spec for: ${{ inputs.idea }}
      Save it to ${{ run.dir }}/spec.md. Base branch: ${{ inputs.branch }}.
```

```sh
factory-floor run flow.yaml --input idea="add a --dry-run flag" --input branch=dev
```

Input definitions:

- `inputs` is a map from input id to a definition, and is optional. Ids use
  the same format as flow and step ids (lowercase letters, digits, `-`, `_`).
- A definition accepts only `description` (string), `required` (boolean)
  and `default` (string); unknown keys are an error. All inputs are
  strings: a non-string `default` such as `5` or `true` is rejected, so
  quote it (`default: "5"`). An empty definition (`idea:` with nothing after
  it) means required, no description.
- An input is required unless it has a `default` or says `required: false`.
  `default` together with `required: true` is an error. An optional input
  with no default is the empty string when not supplied.

Step inputs: a step can declare its own `inputs`, so its prompt depends
only on its own interface (see
[ADR 01](docs/decisions/adr-01-flow-and-step-inputs-outputs.md)). A step
without an `inputs` key sees every flow input; once it declares `inputs`,
its prompt sees only those.

```yaml
inputs:
  area: { default: src/ }

steps:
  - id: identify
    inputs: [area] # list form: each bound by name to the flow input
    prompt: Find untested behaviors in ${{ inputs.area }}.

  - id: review
    inputs:
      area: # by name -> flow input `area`
      where: ${{ inputs.area }}/lib # binding, evaluated in flow scope
      depth: thorough # literal
      tone: { default: dry } # definition: no flow input `tone`, so the default
    prompt: Review ${{ inputs.where }} (${{ inputs.depth }}, ${{ inputs.tone }}).
```

- In the map form, a string value is a binding: a literal, or a template
  where `inputs.<id>` is a flow input (built-ins work too). `null` or an
  object is a definition (`description`, `required`, `default`, as for flow
  inputs).
- A step input resolves to its binding; else the flow input with the same
  name; else its `default` (`""` with `required: false`). Otherwise the flow
  fails to load, naming the step and input.
- `${{ steps.<id>.outputs.<name> }}` in a binding is reserved for step
  outputs, which are not implemented yet, so any such reference is a load
  error (unknown step, forward reference, or undeclared output).

`--input` rules:

- The value is everything after the first `=`, so it can contain `=` and
  newlines (`--input q=a=b` gives `a=b`). `--input idea=` supplies an empty
  string, which counts as supplied and satisfies `required`.
- Passing the same key twice, a key the flow does not declare (including any
  `--input` for a flow with no `inputs:`), or a value with no `=` (or an
  empty key) is an error. Every missing required input is reported at once.

Template syntax: a reference is `${{ name }}`, where `name` is a dotted
path of letters, digits, `_` and `-`. Spaces and tabs inside the braces are
optional. Rendering is a single left-to-right pass: substituted values are
inserted verbatim and never scanned again, so an input whose value contains
`${{ inputs.other }}` stays literal. A lone `$`, `{{` without a `$`, or `${`
are plain text. Any other `${{` starts a reference; write `$${{` for a literal
`${{` (so `$${{ secrets.TOKEN }}` renders as `${{ secrets.TOKEN }}`). There
are no defaults, filters or expressions. Templates apply to step
`prompt` only (not `cwd`).

| Variable               | Value                                                                          |
| ---------------------- | ------------------------------------------------------------------------------ |
| `inputs.<id>`          | the supplied value, else the default, else `""` (optional with no default)     |
| `flow.id`, `flow.name` | the flow's resolved id and name                                                |
| `flow.cwd`             | the absolute working directory                                                 |
| `run.id`               | this run's timestamp id (the `<ISO-timestamp>` directory name)                 |
| `run.dir`              | absolute `<cwd>/.factory-floor/runs/<run.id>`, where logs and `inputs.json` go |
| `step.id`              | the current step's id                                                          |

Validation happens before any agent process starts. At flow load time (an
`Invalid flow file` error listing every problem with its location, such as
`at steps.0.prompt`): a reference to an undeclared input
(`inputs.foo`), an unknown variable (`run.foo`, `env.HOME`, bare `inputs`),
malformed syntax (unterminated `${{`, empty `${{ }}`, a body that is not a
plain dotted name such as `${{ inputs.x | upper }}`), and bad input
definitions. At run start: missing required inputs and bad `--input`
values, as described above.

### Logs

Regardless of `--verbose`, the rendered prompt and the full raw
stdout+stderr of every attempted step are always written to disk, so nothing
is ever lost even in default (terse) mode:

```
<cwd>/.factory-floor/runs/<ISO-timestamp>/<step-id>.log
<cwd>/.factory-floor/runs/<ISO-timestamp>/inputs.json
```

- `<cwd>` is the flow's working directory (see above).
- `<ISO-timestamp>` identifies one run of the flow (one directory per
  `factory-floor run` invocation).
- `<step-id>` is the step's `id` (explicit, or derived from its `name` as
  described above).
- Each log has three sections, in order: `=== prompt ===` (the prompt
  exactly as sent to the harness, after `${{ … }}` substitution),
  `=== stdout ===` and `=== stderr ===`.
- `inputs.json` is written once per run, before the first step: the
  resolved input values (supplied, default or `""`) as a JSON object in
  declaration order, or `{}` when the flow declares no inputs.

`.factory-floor/` is gitignored by this project's own `.gitignore`, and
you'll likely want the same in any repo you point a flow at.

## Trying the bundled example

`examples/hello-flow/` ships a working example flow, `flow.yaml`, with id
`add-missing-tests`. It's a generic, three-step template — identify gaps,
implement and verify tests, then review and refine them — that reads
sensibly against _any_ codebase dropped into its directory, not just the
one included here. The prompts never hardcode a filename.

The example directory also ships a small pre-existing demo payload for the
flow to analyze: `examples/hello-flow/src/parseCsvLine.js`, a single-line
CSV field parser with a few non-obvious edge cases (quoted fields, commas
inside quotes, escaped `""` quotes, empty fields) for step 1 to find.

To try it:

```sh
pnpm install
pnpm run build
node dist/cli.js run examples/hello-flow/flow.yaml --verbose
```

(or, after `pnpm link --global`/a global install, `factory-floor run
examples/hello-flow/flow.yaml --verbose`.)

**Note:** running this invokes the real `claude` CLI three times, once per
step, as real agentic calls — it needs `claude` installed and
authenticated, is not free, and will take a few minutes (step 2 in
particular may loop internally while it gets tests green). This is a
manual "try the CLI" walkthrough; the automated test suite does not run
this flow and never shells out to a real `claude` process (see below).

On success you should find a `TEST_PLAN.md` and a new test file (e.g.
`test/parseCsvLine.test.js`) written into `examples/hello-flow/`, plus logs
under `examples/hello-flow/.factory-floor/runs/<timestamp>/`.

## Development

```sh
pnpm install
pnpm run dev -- run examples/hello-flow/flow.yaml   # run from source via tsx
pnpm run build                                       # compile to dist/
pnpm test                                            # node:test, no real `claude` calls
pnpm run lint                                         # oxlint
pnpm run format                                       # oxfmt --check
pnpm run format:write                                 # oxfmt (writes fixes)
```

Tests use a fake in-memory `Harness` (see `test/run-flow.test.ts`) to
exercise sequential execution, stop-on-failure behavior, and log-path
construction without ever invoking the real `claude` CLI.
