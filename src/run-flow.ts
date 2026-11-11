import { execFileSync } from "node:child_process";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { Harness, HarnessResult, ToolCall } from "./harness.ts";
import { loadFlow, type Flow, type Step } from "./flow-schema.ts";
import { buildVariables, renderTemplate, type VariableContext } from "./template.ts";

export interface FlowStartInfo {
  id: string;
  /** Human-readable flow name (defaults to `id`). */
  name: string;
  /** Number of steps. */
  total: number;
}

export interface StepStartInfo {
  /** 1-based step index. */
  index: number;
  total: number;
  /** Step slug identifier; the `stepId` passed to the per-step callbacks. */
  id: string;
  /** Human-readable step name (defaults to `id`). */
  name: string;
}

export interface StepCompleteInfo {
  index: number;
  total: number;
  id: string;
  name: string;
  success: boolean;
  durationMs: number;
  logPath: string;
}

export type OutputChunkListener = (
  stepId: string,
  chunk: string,
  stream: "stdout" | "stderr",
) => void;

export interface RunFlowOptions {
  flowPath: string;
  verbose: boolean;
  /** Harness used to execute each step; defaults to `new ClaudeCliHarness()` in the CLI entrypoint, injected directly in tests. */
  harness: Harness;
  /** Raw `key=value` flow inputs from the CLI (`--input`), in order; parsed and validated by {@link resolveInputs}. */
  inputs?: string[];
  /**
   * Asks for the value of each declared input not supplied in `inputs`, in
   * declaration order, before any step runs; the answer counts as supplied.
   * Without it, unsupplied inputs take their default (the CLI omits it when
   * stdin is not a TTY, or with `--yes`).
   */
  promptInput?: (input: InputPrompt) => Promise<string>;
  /** Called once the flow file is loaded and validated, before any step runs. */
  onFlowStart?: (info: FlowStartInfo) => void;
  /** Called right before a step starts. */
  onStepStart?: (info: StepStartInfo) => void;
  /** Called right after a step finishes (success or failure). */
  onStepComplete?: (info: StepCompleteInfo) => void;
  /** Called with each raw output chunk while `verbose` is true, for live streaming to the terminal. */
  onOutputChunk?: OutputChunkListener;
  /**
   * Called each time the agent starts a tool call during a step, regardless
   * of `verbose`, for live activity display (e.g. updating a spinner).
   */
  onToolCall?: (stepId: string, call: ToolCall) => void;
  /**
   * Called once per permission/tool request the harness denied during a
   * step, regardless of `verbose` - these indicate the step may not have
   * been able to do what its prompt asked (e.g. a blocked Bash command).
   */
  onWarning?: (stepId: string, message: string) => void;
  /** Aborted on SIGINT so the in-flight harness process can be killed instead of orphaned. */
  signal?: AbortSignal;
}

export interface RunFlowResult {
  success: boolean;
  failedStepId?: string;
  failedStepName?: string;
  /** The `.factory-floor/runs/<timestamp>/` directory used for this run. */
  runDir: string;
}

/** Thrown for run-time problems that aren't flow-schema validation errors (e.g. a missing `cwd`). */
export class FlowRunError extends Error {}

/** An input the caller did not supply with `--input`, handed to {@link RunFlowOptions.promptInput}. */
export interface InputPrompt {
  id: string;
  description?: string;
  /** Whether the input has no default and is not `required: false`. */
  required: boolean;
  /** The rendered default (built-ins such as `git.branch` substituted); `""` when there is none. */
  default: string;
}

/**
 * Parses raw `key=value` strings (the value is everything after the first
 * `=`, so it may contain `=` and newlines) into supplied values keyed by
 * input id. Throws {@link FlowRunError} for a malformed or duplicate
 * `--input`, or an input the flow does not declare.
 */
function parseInputArgs(flow: Flow, raw: string[]): Map<string, string> {
  const declared = new Set(flow.inputs.map((input) => input.id));
  const supplied = new Map<string, string>();
  for (const entry of raw) {
    const eq = entry.indexOf("=");
    if (eq <= 0) {
      throw new FlowRunError(`invalid --input ${JSON.stringify(entry)}: expected key=value`);
    }
    const key = entry.slice(0, eq);
    if (!declared.has(key)) {
      const known =
        flow.inputs.length > 0
          ? `flow declares: ${[...declared].join(", ")}`
          : "flow declares no inputs";
      throw new FlowRunError(`unknown input "${key}" (${known})`);
    }
    if (supplied.has(key)) {
      throw new FlowRunError(`duplicate --input "${key}"`);
    }
    supplied.set(key, entry.slice(eq + 1));
  }
  return supplied;
}

/**
 * Resolves each declared input, in declaration order: supplied value, else
 * its default from `defaults`, else `""` for an optional input. Throws
 * {@link FlowRunError} listing every required input that was not supplied.
 */
function finalizeInputs(
  flow: Flow,
  supplied: ReadonlyMap<string, string>,
  defaults: Readonly<Record<string, string>>,
): Record<string, string> {
  const missing = flow.inputs.filter((input) => input.required && !supplied.has(input.id));
  if (missing.length > 0) {
    throw new FlowRunError(
      missing.map((input) => `missing required input "${input.id}"`).join("; "),
    );
  }

  const resolved: Record<string, string> = {};
  for (const input of flow.inputs) {
    resolved[input.id] = supplied.get(input.id) ?? defaults[input.id] ?? "";
  }
  return resolved;
}

/**
 * Parses raw `--input` strings and resolves them against the flow's declared
 * inputs (see {@link parseInputArgs} and {@link finalizeInputs}). `defaults`
 * are the rendered defaults keyed by input id; they default to the flow's
 * `default` strings as written.
 */
export function resolveInputs(
  flow: Flow,
  raw: string[],
  defaults: Readonly<Record<string, string>> = rawDefaults(flow),
): Record<string, string> {
  return finalizeInputs(flow, parseInputArgs(flow, raw), defaults);
}

function rawDefaults(flow: Flow): Record<string, string> {
  return Object.fromEntries(
    flow.inputs.flatMap((input) =>
      input.default !== undefined ? [[input.id, input.default]] : [],
    ),
  );
}

/** The branch checked out in `cwd`, or `""` when detached, not a git repo, or git is missing. */
function currentGitBranch(cwd: string): string {
  try {
    return execFileSync("git", ["branch", "--show-current"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

/**
 * The values a step's prompt sees as `inputs.<id>`: every flow input when the
 * step declares no `inputs`, otherwise only its declared inputs, each from its
 * load-time-resolved source. Bindings render in flow scope (`flowCtx.inputs`
 * are the flow's inputs).
 */
export function resolveStepInputs(step: Step, flowCtx: VariableContext): Record<string, string> {
  if (step.inputs === undefined) return { ...flowCtx.inputs };
  const values: Record<string, string> = {};
  for (const input of step.inputs) {
    const { source } = input;
    values[input.id] =
      source.kind === "binding"
        ? renderTemplate(source.template, buildVariables(flowCtx))
        : source.kind === "flowInput"
          ? flowCtx.inputs[source.id]
          : source.value;
  }
  return values;
}

/**
 * Loads and validates the flow at `options.flowPath`, then runs its steps
 * strictly sequentially against `options.harness`, stopping immediately on
 * the first failing step. Step prompts are rendered (`${{ … }}` references)
 * before being handed to the harness. Always writes each attempted step's
 * rendered prompt and full raw stdout+stderr to a log file under the returned `runDir`, regardless of
 * `verbose`.
 */
export async function runFlow(options: RunFlowOptions): Promise<RunFlowResult> {
  const {
    flowPath,
    verbose,
    harness,
    inputs: rawInputs = [],
    promptInput,
    onFlowStart,
    onStepStart,
    onStepComplete,
    onOutputChunk,
    onToolCall,
    onWarning,
    signal,
  } = options;

  const flow = loadFlow(flowPath);
  const supplied = parseInputArgs(flow, rawInputs);

  const flowDir = dirname(resolve(flowPath));
  const cwd = flow.cwd ? (isAbsolute(flow.cwd) ? flow.cwd : resolve(flowDir, flow.cwd)) : flowDir;

  let cwdStat;
  try {
    cwdStat = statSync(cwd);
  } catch {
    throw new FlowRunError(`Flow's cwd does not exist: ${cwd}`);
  }
  if (!cwdStat.isDirectory()) {
    throw new FlowRunError(`Flow's cwd is not a directory: ${cwd}`);
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = join(cwd, ".factory-floor", "runs", timestamp);
  const runCtx = { flow, cwd, runId: timestamp, runDir, gitBranch: currentGitBranch(cwd) };

  const defaultVars = buildVariables({ ...runCtx, stepId: "", inputs: {} });
  const defaults: Record<string, string> = {};
  for (const input of flow.inputs) {
    if (input.default !== undefined) {
      defaults[input.id] = renderTemplate(input.default, defaultVars);
    }
  }
  if (promptInput) {
    for (const input of flow.inputs) {
      if (supplied.has(input.id)) continue;
      supplied.set(
        input.id,
        await promptInput({
          id: input.id,
          ...(input.description !== undefined && { description: input.description }),
          required: input.required,
          default: defaults[input.id] ?? "",
        }),
      );
    }
  }
  const inputs = finalizeInputs(flow, supplied, defaults);

  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "inputs.json"), `${JSON.stringify(inputs, null, 2)}\n`, "utf8");

  const total = flow.steps.length;
  onFlowStart?.({ id: flow.id, name: flow.name, total });

  for (let i = 0; i < total; i++) {
    const step = flow.steps[i];
    const index = i + 1;
    const logPath = join(runDir, `${step.id}.log`);

    const flowCtx = { ...runCtx, stepId: step.id, inputs };
    const prompt = renderTemplate(
      step.prompt,
      buildVariables({ ...flowCtx, inputs: resolveStepInputs(step, flowCtx) }),
    );

    onStepStart?.({ index, total, id: step.id, name: step.name });
    const startedAt = Date.now();

    let result: HarnessResult;
    try {
      result = await harness.run({
        cwd,
        prompt,
        signal,
        onOutputChunk: verbose
          ? (chunk, stream) => onOutputChunk?.(step.id, chunk, stream)
          : undefined,
        onToolCall: onToolCall ? (call) => onToolCall(step.id, call) : undefined,
      });
    } catch (error) {
      const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
      result = {
        success: false,
        exitCode: null,
        stdout: "",
        stderr: `Failed to run step: ${message}`,
      };
    }

    const durationMs = Date.now() - startedAt;
    const logContents = `=== prompt ===\n${prompt}\n=== stdout ===\n${result.stdout}\n=== stderr ===\n${result.stderr}\n`;
    writeFileSync(logPath, logContents, "utf8");

    for (const denial of result.permissionDenials ?? []) {
      onWarning?.(step.id, `permission denied: ${denial}`);
    }

    onStepComplete?.({
      index,
      total,
      id: step.id,
      name: step.name,
      success: result.success,
      durationMs,
      logPath,
    });

    if (!result.success) {
      return { success: false, failedStepId: step.id, failedStepName: step.name, runDir };
    }
  }

  return { success: true, runDir };
}
