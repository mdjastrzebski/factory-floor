import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { Readable } from "node:stream";
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
  async run(options: HarnessRunOptions): Promise<HarnessResult> {
    const { cwd, prompt, onOutputChunk, onToolCall, signal } = options;

    // `signal` is passed through to `child_process.spawn`, which sends the
    // child SIGTERM (its default `killSignal`) when the signal aborts.
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
      { cwd, signal, stdio: ["ignore", "pipe", "pipe"] },
    );

    let stdout = "";
    let stderr = "";
    const permissionDenials: string[] = [];

    // A throwing callback kills the child and is rethrown once it has exited;
    // later lines are dropped so the callbacks aren't called again.
    let callbackError: { error: unknown } | undefined;
    const guarded = (handler: (line: string) => void) => (line: string) => {
      if (callbackError) return;
      try {
        handler(line);
      } catch (error) {
        callbackError = { error };
        child.kill();
      }
    };

    onLines(
      child.stdout,
      guarded((line) => {
        stdout += `${line}\n`;
        const parsed = parseStreamJsonLine(line);
        if (!parsed) return;
        for (const chunk of parsed.displayChunks) {
          onOutputChunk?.(chunk, "stdout");
        }
        for (const call of parsed.toolCalls) {
          onToolCall?.(call);
        }
        permissionDenials.push(...parsed.denials);
      }),
    );
    onLines(
      child.stderr,
      guarded((line) => {
        stderr += `${line}\n`;
        onOutputChunk?.(`${line}\n`, "stderr");
      }),
    );

    // 'close' fires after the process has exited and both pipes have ended,
    // so every line has been handled by then.
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.on("error", (error) => {
        // An abort is reported as an AbortError; the run still settles on 'close'.
        if (error.name !== "AbortError") reject(error);
      });
      // `code` is null when the process was killed by a signal (e.g. on abort).
      child.on("close", (code) => resolve(code));
    });

    if (callbackError) throw callbackError.error;

    return {
      success: exitCode === 0,
      exitCode,
      stdout,
      stderr,
      permissionDenials: permissionDenials.length > 0 ? permissionDenials : undefined,
    };
  }
}

/**
 * Calls `onLine` for each newline-terminated line of `stream` (without the
 * "\n"), decoding UTF-8 across chunk boundaries, plus a final unterminated
 * line if the stream ends without a trailing newline.
 */
function onLines(stream: Readable, onLine: (line: string) => void): void {
  const decoder = new StringDecoder("utf8");
  let buffered = "";
  const emit = (text: string) => {
    buffered += text;
    let newline: number;
    while ((newline = buffered.indexOf("\n")) !== -1) {
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      onLine(line);
    }
  };
  stream.on("data", (chunk: Buffer) => emit(decoder.write(chunk)));
  stream.on("end", () => {
    emit(decoder.end());
    if (buffered) onLine(buffered);
    buffered = "";
  });
}
