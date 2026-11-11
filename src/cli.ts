import { readFileSync } from "node:fs";
import { Command } from "commander";
import { intro, log, outro } from "@clack/prompts";
import pc from "picocolors";
import { runFlow } from "./run-flow.ts";
import { ClaudeCliHarness } from "./harnesses/claude-cli-harness.ts";
import { createFlowReporter } from "./terminal/flow-reporter.ts";
import { createSpinner } from "./terminal/spinner.ts";

// Resolves to the package root from both `src/cli.ts` and `dist/cli.js`.
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
  description: string;
};

async function runCommand(flowPath: string, { verbose }: { verbose: boolean }): Promise<void> {
  intro(`${pc.bold(pc.cyan("factory-floor"))} ${pc.dim(flowPath)}`);

  const harness = new ClaudeCliHarness();
  const controller = new AbortController();
  const startedAt = Date.now();
  const reporter = createFlowReporter({ verbose, print: console, log, outro, createSpinner });

  const onSigint = () => {
    reporter.cancel();
    controller.abort();
  };
  process.once("SIGINT", onSigint);

  try {
    const result = await runFlow({
      flowPath,
      verbose,
      harness,
      signal: controller.signal,
      onStepStart: reporter.onStepStart,
      onToolCall: reporter.onToolCall,
      onWarning: reporter.onWarning,
      onStepComplete: reporter.onStepComplete,
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
    process.exitCode = reporter.finish(result, Date.now() - startedAt);
  } catch (error) {
    process.exitCode = reporter.fail(error);
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
