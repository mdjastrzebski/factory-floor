import { once } from "node:events";
import spawn, { SubprocessError } from "nano-spawn";
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

    // The spawn signal is passed through to `child_process.spawn`, which sends
    // the child SIGTERM (its default `killSignal`) when the signal aborts. It
    // also aborts on `internalController`, used to kill the child when a
    // callback throws: nano-spawn's iterators await the subprocess when the
    // loop exits early, so without a kill `run` would wait for the child to
    // exit on its own (or hang if it blocks on an undrained pipe).
    const internalController = new AbortController();
    const spawnSignal = signal
      ? AbortSignal.any([signal, internalController.signal])
      : internalController.signal;
    const callback = <A extends unknown[]>(fn: ((...args: A) => void) | undefined, ...args: A) => {
      try {
        fn?.(...args);
      } catch (error) {
        internalController.abort();
        throw error;
      }
    };
    const subprocess = spawn(
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
      { cwd, signal: spawnSignal, stdin: "ignore" },
    );

    let started = false;
    subprocess.nodeChildProcess.then(
      () => {
        started = true;
      },
      () => {},
    );

    // nano-spawn leaves `result.stdout`/`result.stderr` empty once the line
    // iterators are consumed, so the full text is accumulated here instead.
    // nano-spawn's iterators split on newlines (decoding UTF-8 across chunk
    // boundaries), so each line is re-joined with "\n".
    let stdout = "";
    let stderr = "";
    const permissionDenials: string[] = [];

    const readStdout = async () => {
      for await (const line of subprocess.stdout) {
        stdout += `${line}\n`;
        const parsed = parseStreamJsonLine(line);
        if (!parsed) continue;
        for (const chunk of parsed.displayChunks) {
          callback(onOutputChunk, chunk, "stdout");
        }
        for (const call of parsed.toolCalls) {
          callback(onToolCall, call);
        }
        permissionDenials.push(...parsed.denials);
      }
    };

    const readStderr = async () => {
      for await (const line of subprocess.stderr) {
        stderr += `${line}\n`;
        callback(onOutputChunk, `${line}\n`, "stderr");
      }
    };

    // Both iterators must start right away (same tick as `spawn`), or
    // nano-spawn starts buffering that stream itself and refuses to iterate it.
    const reading = Promise.allSettled([readStdout(), readStderr()]);

    let exitCode: number | null = 0;
    try {
      await subprocess;
    } catch (error) {
      await reading;
      // The process never started (e.g. `claude` not on PATH): surface the
      // underlying spawn error, as `child_process`'s "error" event did.
      if (!started) {
        throw error instanceof SubprocessError && error.cause instanceof Error
          ? error.cause
          : error;
      }
      if (!(error instanceof SubprocessError)) throw error;
      // On abort, nano-spawn rejects as soon as Node reports the `AbortError`,
      // before the SIGTERM'd child has actually exited. Wait for it, so `run`
      // only settles once the process is gone.
      const child = await subprocess.nodeChildProcess;
      if (child.exitCode === null && child.signalCode === null) {
        await once(child, "exit");
      }
      // `exitCode` is undefined when the process was killed by a signal (e.g. on abort).
      exitCode = error.exitCode ?? null;
    }

    // The iterators rethrow the subprocess's own failure (handled above);
    // anything else (e.g. a throwing callback) is a real error.
    for (const outcome of await reading) {
      if (outcome.status === "rejected" && !(outcome.reason instanceof SubprocessError)) {
        throw outcome.reason;
      }
    }

    return {
      success: exitCode === 0,
      exitCode,
      stdout,
      stderr,
      permissionDenials: permissionDenials.length > 0 ? permissionDenials : undefined,
    };
  }
}
