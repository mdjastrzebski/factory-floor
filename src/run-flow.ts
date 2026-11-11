import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { Harness, HarnessResult, ToolCall } from "./harness.ts";
import { loadFlow } from "./flow-schema.ts";

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

/**
 * Loads and validates the flow at `options.flowPath`, then runs its steps
 * strictly sequentially against `options.harness`, stopping immediately on
 * the first failing step. Always writes each attempted step's full raw
 * stdout+stderr to a log file under the returned `runDir`, regardless of
 * `verbose`.
 */
export async function runFlow(options: RunFlowOptions): Promise<RunFlowResult> {
  const {
    flowPath,
    verbose,
    harness,
    onFlowStart,
    onStepStart,
    onStepComplete,
    onOutputChunk,
    onToolCall,
    onWarning,
    signal,
  } = options;

  const flow = loadFlow(flowPath);

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
  mkdirSync(runDir, { recursive: true });

  const total = flow.steps.length;
  onFlowStart?.({ id: flow.id, name: flow.name, total });

  for (let i = 0; i < total; i++) {
    const step = flow.steps[i];
    const index = i + 1;
    const logPath = join(runDir, `${step.id}.log`);

    onStepStart?.({ index, total, id: step.id, name: step.name });
    const startedAt = Date.now();

    let result: HarnessResult;
    try {
      result = await harness.run({
        cwd,
        prompt: step.prompt,
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
    const logContents = `=== stdout ===\n${result.stdout}\n=== stderr ===\n${result.stderr}\n`;
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
