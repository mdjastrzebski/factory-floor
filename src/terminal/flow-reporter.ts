import { relative } from "node:path";
import pc from "picocolors";
import { FlowValidationError } from "../flow-schema.ts";
import type { ToolCall } from "../harness.ts";
import {
  FlowRunError,
  type RunFlowResult,
  type StepCompleteInfo,
  type StepStartInfo,
} from "../run-flow.ts";
import type { Spinner } from "./spinner.ts";

/**
 * Turns `runFlow`'s progress callbacks into terminal output. One instance
 * per run; it owns the presentation state (the active step's spinner,
 * whether the run was cancelled, the failed step's log path, the step count)
 * so the SIGINT handler and the callbacks agree on what has been printed.
 */
export interface FlowReporter {
  onStepStart(info: StepStartInfo): void;
  /** Undefined in verbose mode, where the raw output already shows tool calls. */
  onToolCall?: (stepName: string, call: ToolCall) => void;
  onWarning(stepName: string, message: string): void;
  onStepComplete(info: StepCompleteInfo): void;
  /** Called on SIGINT, before the run is aborted. */
  cancel(): void;
  /** Prints the run summary once `runFlow` resolves. Returns the process exit code. */
  finish(result: RunFlowResult, elapsedMs: number): number;
  /** Prints an error `runFlow` threw. Returns the process exit code. */
  fail(error: unknown): number;
}

export interface FlowReporterDeps {
  verbose: boolean;
  /** Plain line output, used in verbose mode (`console` in the CLI). */
  print: { log(message: string): void; error(message: string): void };
  /** Clack-style log lines (`log` from `@clack/prompts` in the CLI). */
  log: { warn(message: string): void; error(message: string): void };
  /** Clack-style closing line (`outro` from `@clack/prompts` in the CLI). */
  outro(message: string): void;
  createSpinner(): Spinner;
  /** Base for displayed paths; defaults to `process.cwd()`. */
  cwd?: string;
}

interface ActiveStep {
  name: string;
  /** `[i/total] <step name>`, the spinner's base text. */
  label: string;
  spinner: Spinner;
  /** Tool calls seen so far this step, for the running count in the spinner. */
  toolCallCount: number;
}

export function formatDuration(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Max length of the detail excerpt shown in the spinner, in characters. */
const DETAIL_EXCERPT_LENGTH = 50;

/**
 * A short, generic excerpt of a tool call's detail, safe to show regardless
 * of what produced it (a file path, a shell command, a search pattern, ...).
 * Collapses whitespace, drops a leading shell `cd <dir>;`/`&&` prefix (rarely
 * meaningful to a reader - the step's cwd is already implied), and truncates
 * to a fixed length so one long detail can't dominate the line.
 */
function detailExcerpt(detail: string): string {
  const collapsed = detail.replace(/\s+/g, " ").trim();
  const withoutCd = collapsed.replace(/^cd\s+\S+\s*(?:;|&&)\s*/, "");
  if (withoutCd.length <= DETAIL_EXCERPT_LENGTH) return withoutCd;
  return `${withoutCd.slice(0, DETAIL_EXCERPT_LENGTH - 1)}…`;
}

/**
 * `[i/total] <step name> → <generic activity>: <short detail excerpt> (#<n>)`.
 * Leads with what kind of thing the tool is doing (the harness's own
 * `activity` label, not its exact arguments - those vary wildly in length
 * and can be noisy, e.g. a chained shell command), then a bounded excerpt of
 * the actual argument, then a running count of tool calls this step so a
 * long, repetitive step (many edits, many searches) still reads as progress.
 * Pass `--verbose` to see exact, untruncated commands/paths/patterns.
 */
function toolCallMessage(label: string, call: ToolCall, count: number): string {
  const activity = call.activity ?? call.name;
  const excerpt = call.detail && detailExcerpt(call.detail);
  const detailSuffix = excerpt ? `: ${excerpt}` : "";
  return `${label} ${pc.dim(`→ ${activity}${detailSuffix} (#${count})`)}`;
}

export function createFlowReporter(deps: FlowReporterDeps): FlowReporter {
  const { verbose, print, log, outro } = deps;
  let active: ActiveStep | undefined;
  let cancelled = false;
  let failedLogPath: string | undefined;
  let stepCount = 0;

  /** Renders an absolute path relative to `cwd`, for display only. */
  const displayPath = (path: string): string => {
    const rel = relative(deps.cwd ?? process.cwd(), path);
    return rel.startsWith("..") ? path : rel;
  };

  const shared = {
    cancel(): void {
      cancelled = true;
      if (active) {
        active.spinner.cancel(pc.yellow(`${active.name} cancelled`));
        active = undefined;
      } else {
        log.warn(pc.yellow("Received SIGINT, stopping the current step..."));
      }
    },
    finish(result: RunFlowResult, elapsedMs: number): number {
      const elapsed = formatDuration(elapsedMs);
      if (result.success) {
        const steps = `${stepCount} step${stepCount === 1 ? "" : "s"}`;
        outro(
          `${pc.green(`✓ Flow succeeded: ${steps} in ${elapsed}`)} ${pc.dim(`logs: ${displayPath(result.runDir)}`)}`,
        );
        return 0;
      }
      const summary = cancelled
        ? pc.yellow(`Flow cancelled during step "${result.failedStepName}" after ${elapsed}`)
        : pc.red(`✗ Flow failed at step "${result.failedStepName}" after ${elapsed}`);
      outro(`${summary} ${pc.dim(`log: ${displayPath(failedLogPath ?? result.runDir)}`)}`);
      return 1;
    },
    fail(error: unknown): number {
      if (active) {
        active.spinner.error(pc.red(`✗ ${active.name}`));
        active = undefined;
      }
      if (error instanceof FlowRunError || error instanceof FlowValidationError) {
        log.error(pc.red(error.message));
      } else {
        log.error(pc.red(error instanceof Error ? (error.stack ?? error.message) : String(error)));
      }
      outro(pc.red("✗ Flow failed"));
      return 1;
    },
  };

  if (verbose) {
    return {
      ...shared,
      onStepStart: ({ index, total, name }) => {
        stepCount = total;
        print.log(`[${index}/${total}] ${name}...`);
      },
      onWarning: (stepName, message) => {
        print.error(`warning: [${stepName}] ${message}`);
      },
      onStepComplete: ({ index, total, name, success, durationMs, logPath }) => {
        if (!success) failedLogPath = logPath;
        const duration = pc.dim(`(${formatDuration(durationMs)})`);
        if (success) {
          print.log(`[${index}/${total}] ${name} ${pc.green("done")} ${duration}`);
        } else {
          print.error(`[${index}/${total}] ${name} ${pc.red("failed")} ${duration}`);
          print.error(`  log: ${displayPath(logPath)}`);
        }
      },
    };
  }

  return {
    ...shared,
    onStepStart: ({ index, total, name }) => {
      stepCount = total;
      const label = `[${index}/${total}] ${name}`;
      const s = deps.createSpinner();
      s.start(label);
      active = { name, label, spinner: s, toolCallCount: 0 };
    },
    onToolCall: (stepName, call) => {
      if (active?.name === stepName) {
        active.toolCallCount++;
        active.spinner.message(toolCallMessage(active.label, call, active.toolCallCount));
      }
    },
    onWarning: (stepName, message) => {
      active?.spinner.erase();
      log.warn(pc.yellow(`[${stepName}] ${message}`));
    },
    onStepComplete: ({ name, success, durationMs, logPath }) => {
      if (!success) failedLogPath = logPath;
      const duration = pc.dim(`(${formatDuration(durationMs)})`);
      // Already stopped with a "cancelled" message by `cancel()`.
      if (!active) return;
      if (success) {
        active.spinner.stop(`${pc.green(`✓ ${name}`)} ${duration}`);
      } else {
        active.spinner.error(`${pc.red(`✗ ${name}`)} ${duration}`);
      }
      active = undefined;
    },
  };
}
