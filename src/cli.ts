import { FlowValidationError } from "./flow-schema.ts";
import { runFlow, FlowRunError } from "./run-flow.ts";
import { ClaudeCliHarness } from "./harnesses/claude-cli-harness.ts";

function printUsage(): void {
  console.error("Usage: factory-floor run <flow.yaml> [--verbose]");
}

interface ParsedArgs {
  command: string;
  flowPath?: string;
  verbose: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command, ...rest] = argv;
  let flowPath: string | undefined;
  let verbose = false;

  for (const arg of rest) {
    if (arg === "--verbose") {
      verbose = true;
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    } else if (flowPath === undefined) {
      flowPath = arg;
    } else {
      throw new Error(`Unexpected extra argument: ${arg}`);
    }
  }

  return { command, flowPath, verbose };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    printUsage();
    process.exitCode = 1;
    return;
  }

  if (parsed.command !== "run" || !parsed.flowPath) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  const { flowPath, verbose } = parsed;

  const harness = new ClaudeCliHarness();
  const controller = new AbortController();

  const onSigint = () => {
    console.error("\nReceived SIGINT, stopping the current step...");
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
        process.stdout.write(`[${index}/${total}] ${name}... `);
      },
      onStepComplete: ({ success, durationMs, logPath }) => {
        const seconds = (durationMs / 1000).toFixed(1);
        if (success) {
          console.log(`done (${seconds}s)`);
        } else {
          console.log(`failed (see log)`);
          console.error(`  log: ${logPath}`);
        }
      },
      onWarning: (stepName, message) => {
        process.stderr.write(`warning: [${stepName}] ${message}\n`);
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

    if (!result.success) {
      console.error(`Flow failed at step "${result.failedStepName}". Logs: ${result.runDir}`);
      process.exitCode = 1;
    } else {
      process.exitCode = 0;
    }
  } catch (error) {
    if (error instanceof FlowRunError || error instanceof FlowValidationError) {
      console.error(error.message);
      process.exitCode = 1;
    } else {
      console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
      process.exitCode = 1;
    }
  } finally {
    process.off("SIGINT", onSigint);
  }
}

main();
