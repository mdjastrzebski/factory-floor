import { spawn } from "node:child_process";
import type { Harness, HarnessResult, HarnessRunOptions } from "../harness.ts";
import { parseStreamJsonLine } from "./stream-json-parser.ts";

/**
 * Harness implementation that runs a step by spawning the `claude` CLI in
 * headless mode:
 * `claude -p "<prompt>" --permission-mode auto --permission-prompts none --output-format stream-json --verbose`.
 *
 * `auto` lets a classifier approve ordinary file edits and declared-dependency
 * commands (e.g. `npm test`) without a human present, while still blocking
 * clearly risky actions (force-push, `curl | bash`, deploys) - a middle
 * ground between `acceptEdits` (which never approves arbitrary Bash, so
 * steps that need to run tests/lint silently can't) and
 * `--dangerously-skip-permissions` (which approves everything). Output is
 * requested as stream-json so each denied tool/permission request can be
 * surfaced as a warning instead of silently degrading the step.
 */
export class ClaudeCliHarness implements Harness {
  run(options: HarnessRunOptions): Promise<HarnessResult> {
    const { cwd, prompt, onOutputChunk, signal } = options;

    return new Promise((resolve, reject) => {
      const child = spawn(
        "claude",
        [
          "-p",
          prompt,
          "--permission-mode",
          "auto",
          "--permission-prompts",
          "none",
          "--output-format",
          "stream-json",
          "--verbose",
        ],
        {
          cwd,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );

      let stdout = "";
      let stderr = "";
      let settled = false;
      let lineBuffer = "";
      const permissionDenials: string[] = [];

      const onAbort = () => {
        child.kill("SIGTERM");
      };
      if (signal) {
        if (signal.aborted) {
          onAbort();
        } else {
          signal.addEventListener("abort", onAbort, { once: true });
        }
      }

      const cleanup = () => {
        if (signal) {
          signal.removeEventListener("abort", onAbort);
        }
      };

      const handleLine = (line: string) => {
        const parsed = parseStreamJsonLine(line);
        if (!parsed) return;
        for (const chunk of parsed.displayChunks) {
          onOutputChunk?.(chunk, "stdout");
        }
        permissionDenials.push(...parsed.denials);
      };

      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");

      child.stdout?.on("data", (chunk: string) => {
        stdout += chunk;
        lineBuffer += chunk;
        const lines = lineBuffer.split("\n");
        lineBuffer = lines.pop() ?? "";
        for (const line of lines) handleLine(line);
      });

      child.stderr?.on("data", (chunk: string) => {
        stderr += chunk;
        onOutputChunk?.(chunk, "stderr");
      });

      child.on("error", (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      });

      child.on("close", (exitCode) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (lineBuffer) handleLine(lineBuffer);
        resolve({
          success: exitCode === 0,
          exitCode,
          stdout,
          stderr,
          permissionDenials: permissionDenials.length > 0 ? permissionDenials : undefined,
        });
      });
    });
  }
}
