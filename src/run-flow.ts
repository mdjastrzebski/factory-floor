import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { Harness, HarnessResult } from "./harness.ts";
import { loadFlow } from "./flow-schema.ts";
import { uniqueSlug } from "./slug.ts";

export interface StepStartInfo {
  /** 1-based step index. */
  index: number;
  total: number;
  name: string;
}

export interface StepCompleteInfo {
  index: number;
  total: number;
  name: string;
  success: boolean;
  durationMs: number;
  logPath: string;
}

export type OutputChunkListener = (
  stepName: string,
  chunk: string,
  stream: "stdout" | "stderr",
) => void;

export interface RunFlowOptions {
  flowPath: string;
  verbose: boolean;
  /** Harness used to execute each step; defaults to `new ClaudeCliHarness()` in the CLI entrypoint, injected directly in tests. */
  harness: Harness;
  /** Called right before a step starts. */
  onStepStart?: (info: StepStartInfo) => void;
  /** Called right after a step finishes (success or failure). */
  onStepComplete?: (info: StepCompleteInfo) => void;
  /** Called with each raw output chunk while `verbose` is true, for live streaming to the terminal. */
  onOutputChunk?: OutputChunkListener;
  /**
   * Called once per permission/tool request the harness denied during a
   * step, regardless of `verbose` - these indicate the step may not have
   * been able to do what its prompt asked (e.g. a blocked Bash command).
   */
  onWarning?: (stepName: string, message: string) => void;
  /** Aborted on SIGINT so the in-flight harness process can be killed instead of orphaned. */
  signal?: AbortSignal;
}

export interface RunFlowResult {
  success: boolean;
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
    onStepStart,
    onStepComplete,
    onOutputChunk,
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

  const usedSlugs = new Set<string>();
  const total = flow.steps.length;

  for (let i = 0; i < total; i++) {
    const step = flow.steps[i];
    const index = i + 1;
    const slug = uniqueSlug(step.name, usedSlugs);
    const logPath = join(runDir, `${slug}.log`);

    onStepStart?.({ index, total, name: step.name });
    const startedAt = Date.now();

    let result: HarnessResult;
    try {
      result = await harness.run({
        cwd,
        prompt: step.prompt,
        signal,
        onOutputChunk: verbose
          ? (chunk, stream) => onOutputChunk?.(step.name, chunk, stream)
          : undefined,
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
      onWarning?.(step.name, `permission denied: ${denial}`);
    }

    onStepComplete?.({
      index,
      total,
      name: step.name,
      success: result.success,
      durationMs,
      logPath,
    });

    if (!result.success) {
      return { success: false, failedStepName: step.name, runDir };
    }
  }

  return { success: true, runDir };
}
