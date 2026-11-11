import { readFileSync } from "node:fs";
import { Command } from "commander";
import { intro, log, outro } from "@clack/prompts";
import pc from "picocolors";
import type { Harness } from "./harness.ts";
import { runFlow } from "./run-flow.ts";
import { createFlowReporter, type FlowReporter } from "./terminal/flow-reporter.ts";
import { createSpinner } from "./terminal/spinner.ts";
import { createVerboseOutputFormatter } from "./terminal/verbose-output.ts";

// Resolves to the package root from both `src/program.ts` and `dist/program.js`.
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
  description: string;
};

/** The slice of `process` the CLI touches; `process` itself satisfies it. */
export interface CliProcess {
  once(event: "SIGINT", listener: () => void): unknown;
  off(event: "SIGINT", listener: () => void): unknown;
  stdout: { write(chunk: string): unknown };
  stderr: { write(chunk: string): unknown };
  exitCode?: number | string | null;
}

export interface CliDeps {
  createHarness(): Harness;
  proc: CliProcess;
  /** Defaults to the clack-backed `createFlowReporter`. */
  createReporter?: (verbose: boolean) => FlowReporter;
}

const defaultReporter = (verbose: boolean): FlowReporter =>
  createFlowReporter({ verbose, print: console, log, outro, createSpinner });

async function runCommand(
  deps: CliDeps,
  flowPath: string,
  { verbose, input }: { verbose: boolean; input: string[] },
): Promise<void> {
  const { proc } = deps;
  intro(`${pc.bold(pc.cyan("factory-floor"))} ${pc.dim(flowPath)}`);

  const harness = deps.createHarness();
  const controller = new AbortController();
  const startedAt = Date.now();
  const reporter = (deps.createReporter ?? defaultReporter)(verbose);
  const formatOutput = createVerboseOutputFormatter();

  const onSigint = () => {
    reporter.cancel();
    controller.abort();
  };
  proc.once("SIGINT", onSigint);

  try {
    const result = await runFlow({
      flowPath,
      verbose,
      harness,
      inputs: input,
      signal: controller.signal,
      onFlowStart: reporter.onFlowStart,
      onStepStart: reporter.onStepStart,
      onToolCall: reporter.onToolCall,
      onWarning: reporter.onWarning,
      onStepComplete: reporter.onStepComplete,
      onOutputChunk: (stepId, chunk, stream) => {
        const text = formatOutput(stepId, chunk, stream);
        if (stream === "stdout") {
          proc.stdout.write(text);
        } else {
          proc.stderr.write(text);
        }
      },
    });
    proc.exitCode = reporter.finish(result, Date.now() - startedAt);
  } catch (error) {
    proc.exitCode = reporter.fail(error);
  } finally {
    proc.off("SIGINT", onSigint);
  }
}

export function buildProgram(deps: CliDeps): Command {
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
    .option(
      "--input <key=value>",
      "flow input (repeatable)",
      (value: string, previous: string[]) => [...previous, value],
      [] as string[],
    )
    .action(async (flowPath: string, options: { verbose: boolean; input: string[] }) => {
      await runCommand(deps, flowPath, options);
    });

  return program;
}
