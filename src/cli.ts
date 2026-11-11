import { readFileSync } from "node:fs";
import { isAbsolute, relative } from "node:path";
import { Command } from "commander";
import { intro, log, outro } from "@clack/prompts";
import pc from "picocolors";
import { FlowValidationError } from "./flow-schema.ts";
import type { ToolCall } from "./harness.ts";
import { runFlow, FlowRunError } from "./run-flow.ts";
import { ClaudeCliHarness } from "./harnesses/claude-cli-harness.ts";
import { createSpinner, type Spinner } from "./terminal/spinner.ts";

// Resolves to the package root from both `src/cli.ts` and `dist/cli.js`.
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
  description: string;
};

interface ActiveStep {
  name: string;
  /** `[i/total] <step name>`, the spinner's base text. */
  label: string;
  spinner: Spinner;
}

function formatDuration(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Renders an absolute path relative to the CLI's cwd, for display only. */
function displayPath(path: string): string {
  const rel = relative(process.cwd(), path);
  return rel.startsWith("..") ? path : rel;
}

/** Like {@link displayPath}, but leaves non-path strings (commands, URLs, patterns) untouched. */
function displayPathIfAbsolute(text: string): string {
  return isAbsolute(text) ? displayPath(text) : text;
}

/**
 * `[i/total] <step name> → <tool> <detail>`. The spinner truncates it to the
 * terminal width; control characters (tabs, escapes) are blanked so they
 * can't throw off its width math.
 */
function toolCallMessage(label: string, call: ToolCall): string {
  const rawDetail = call.detail?.split("\n")[0].trim();
  const detail = rawDetail && displayPathIfAbsolute(rawDetail);
  const activity = (detail ? `${call.name} ${detail}` : call.name).replace(
    new RegExp(String.raw`[\x00-\x1f\x7f-\x9f]`, "g"),
    " ",
  );
  return `${label} ${pc.dim(`→ ${activity}`)}`;
}

async function runCommand(flowPath: string, { verbose }: { verbose: boolean }): Promise<void> {
  intro(`${pc.bold(pc.cyan("factory-floor"))} ${pc.dim(flowPath)}`);

  const harness = new ClaudeCliHarness();
  const controller = new AbortController();
  const startedAt = Date.now();
  let active: ActiveStep | undefined;
  let cancelled = false;
  let failedLogPath: string | undefined;
  let stepCount = 0;

  const onSigint = () => {
    cancelled = true;
    if (active) {
      active.spinner.cancel(pc.yellow(`${active.name} cancelled`));
      active = undefined;
    } else {
      log.warn(pc.yellow("Received SIGINT, stopping the current step..."));
    }
    controller.abort();
  };
  process.once("SIGINT", onSigint);

  try {
    const result = await runFlow({
      flowPath,
      verbose,
      harness,
      signal: controller.signal,
      onStepStart: ({ index, total, name }) => {
        stepCount = total;
        const label = `[${index}/${total}] ${name}`;
        if (verbose) {
          console.log(`${label}...`);
          return;
        }
        const s = createSpinner();
        s.start(label);
        active = { name, label, spinner: s };
      },
      onToolCall: verbose
        ? undefined
        : (stepName, call) => {
            if (active?.name === stepName) {
              active.spinner.message(toolCallMessage(active.label, call));
            }
          },
      onWarning: (stepName, message) => {
        if (verbose) {
          console.error(`warning: [${stepName}] ${message}`);
          return;
        }
        active?.spinner.erase();
        log.warn(pc.yellow(`[${stepName}] ${message}`));
      },
      onStepComplete: ({ index, total, name, success, durationMs, logPath }) => {
        if (!success) failedLogPath = logPath;
        const duration = pc.dim(`(${formatDuration(durationMs)})`);
        if (verbose) {
          if (success) {
            console.log(`[${index}/${total}] ${name} ${pc.green("done")} ${duration}`);
          } else {
            console.error(`[${index}/${total}] ${name} ${pc.red("failed")} ${duration}`);
            console.error(`  log: ${displayPath(logPath)}`);
          }
          return;
        }
        // Already stopped with a "cancelled" message by the SIGINT handler.
        if (!active) return;
        if (success) {
          active.spinner.stop(`${pc.green(`✓ ${name}`)} ${duration}`);
        } else {
          active.spinner.error(`${pc.red(`✗ ${name}`)} ${duration}`);
        }
        active = undefined;
      },
      onOutputChunk: (stepName, chunk, stream) => {
        const prefix = `[${stepName}:${stream}] `;
        const text = chunk
          .split("\n")
          .map((line, i, arr) => (i === arr.length - 1 && line === "" ? line : prefix + line))
          .join("\n");
        if (stream === "stdout") {
          process.stdout.write(text);
        } else {
          process.stderr.write(text);
        }
      },
    });

    const elapsed = formatDuration(Date.now() - startedAt);
    if (result.success) {
      const steps = `${stepCount} step${stepCount === 1 ? "" : "s"}`;
      outro(
        `${pc.green(`✓ Flow succeeded: ${steps} in ${elapsed}`)} ${pc.dim(`logs: ${displayPath(result.runDir)}`)}`,
      );
      process.exitCode = 0;
    } else {
      const summary = cancelled
        ? pc.yellow(`Flow cancelled during step "${result.failedStepName}" after ${elapsed}`)
        : pc.red(`✗ Flow failed at step "${result.failedStepName}" after ${elapsed}`);
      outro(`${summary} ${pc.dim(`log: ${displayPath(failedLogPath ?? result.runDir)}`)}`);
      process.exitCode = 1;
    }
  } catch (error) {
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
    process.exitCode = 1;
  } finally {
    process.off("SIGINT", onSigint);
  }
}

const program = new Command()
  .name("factory-floor")
  .description(pkg.description)
  .version(pkg.version)
  .showHelpAfterError();

program
  .command("run")
  .description("Run a flow's steps in order against its working directory")
  .argument("<flow.yaml>", "path to the flow YAML file")
  .option("--verbose", "stream the agent's full raw output instead of showing spinners", false)
  .action(async (flowPath: string, options: { verbose: boolean }) => {
    await runCommand(flowPath, options);
  });

await program.parseAsync(process.argv);
