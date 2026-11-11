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
# optional, just for your own reference
name: my-flow

# optional; defaults to the directory containing this flow file
cwd: ./somewhere

steps:
  - name: step-one # required, must be unique within the flow
    prompt: | # required; multi-line via YAML block scalar
      Do the first thing. Be specific about what "done" looks like.

  - name: step-two
    prompt: |
      Do the second thing, coordinating with step one only via files
      already on disk in this directory.
```

- `name` (top-level, optional) — a label for the flow; not currently used
  for anything but documentation.
- `cwd` (optional) — the working directory every step runs in, resolved
  relative to the flow file's own directory if not absolute. Defaults to
  the directory containing the flow file. Shared across all steps.
- `steps` (required, non-empty array) — run strictly in order. Each step
  needs:
  - `name` (required, non-empty, unique within the flow) — used for
    progress output and the step's log filename.
  - `prompt` (required, non-empty string) — passed as-is to the harness.

The flow file is parsed with the `yaml` package and validated with `zod`
before anything runs. An invalid flow (missing `steps`, a step missing
`name`/`prompt`, duplicate step names, a non-existent `cwd`, etc.) is
rejected with a clear error and a non-zero exit code, and no agent process
is spawned.

Each step is run as its own `claude -p "<prompt>" --permission-mode auto
--permission-prompts none` child process. `auto` mode uses a classifier to
approve ordinary file edits and declared-dependency commands (e.g.
`npm test`, `npm run lint`) unattended, while still blocking clearly risky
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
terminal as it's produced, prefixed with the step name and stream.

If any step exits non-zero, the flow stops immediately — later steps never
run — and `factory-floor` exits non-zero. If every step succeeds, it exits 0. Pressing Ctrl-C (SIGINT) while a step is running kills that step's
`claude` child process rather than leaving it running in the background.

### Logs

Regardless of `--verbose`, the full raw stdout+stderr of every attempted
step is always written to disk, so nothing is ever lost even in default
(terse) mode:

```
<cwd>/.factory-floor/runs/<ISO-timestamp>/<step-slug>.log
```

- `<cwd>` is the flow's working directory (see above).
- `<ISO-timestamp>` identifies one run of the flow (one directory per
  `factory-floor run` invocation).
- `<step-slug>` is the step's `name`, lowercased with non-alphanumeric
  characters collapsed to `-`; if two steps slugify to the same name, later
  ones get `-2`, `-3`, etc.

`.factory-floor/` is gitignored by this project's own `.gitignore`, and
you'll likely want the same in any repo you point a flow at.

## Trying the bundled example

`examples/hello-flow/` ships a working example flow, `flow.yaml`, named
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
npm install
npm run build
node dist/cli.js run examples/hello-flow/flow.yaml --verbose
```

(or, after `npm link`/a global install, `factory-floor run
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
npm install
npm run dev -- run examples/hello-flow/flow.yaml   # run from source via tsx
npm run build                                       # compile to dist/
npm test                                            # node:test, no real `claude` calls
npm run lint                                         # oxlint
npm run format                                       # oxfmt --check
npm run format:write                                 # oxfmt (writes fixes)
```

Tests use a fake in-memory `Harness` (see `test/run-flow.test.ts`) to
exercise sequential execution, stop-on-failure behavior, and log-path
construction without ever invoking the real `claude` CLI.
