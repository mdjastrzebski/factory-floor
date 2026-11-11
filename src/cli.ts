import { ClaudeCliHarness } from "./harnesses/claude-cli-harness.ts";
import { buildProgram } from "./program.ts";

await buildProgram({ createHarness: () => new ClaudeCliHarness(), proc: process }).parseAsync(
  process.argv,
);
