/**
 * Abstraction over an AI coding-agent CLI/SDK invoked headlessly for a single
 * step. `ClaudeCliHarness` (src/harnesses/claude-cli-harness.ts) is the only
 * implementation today, but the shape here is meant to stay easy to satisfy
 * for future harnesses (Claude Agent SDK, Codex SDK, ACP, ...) without
 * changing callers.
 */

export interface HarnessResult {
  /** true iff the underlying process exited with code 0. */
  success: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /**
   * Human-readable descriptions of any tool/permission requests the harness
   * denied during the run (e.g. a Bash command that fell outside the
   * permission mode's allowlist). Empty/undefined when nothing was denied.
   */
  permissionDenials?: string[];
}

/** A tool call the agent started, as a short structured summary (not the full tool input). */
export interface ToolCall {
  /** Tool name as reported by the agent, e.g. `Edit` or `Bash`. */
  name: string;
  /** The tool's primary argument when trivially available (e.g. a file path or command). */
  detail?: string;
}

export interface HarnessRunOptions {
  /** Working directory the harness process should run in. */
  cwd: string;
  /** The prompt text to pass to the harness for this step. */
  prompt: string;
  /**
   * Optional callback invoked with each raw chunk of output as it is
   * produced, for live streaming (e.g. under `--verbose`). Called in
   * addition to - not instead of - the buffered result returned by `run`.
   */
  onOutputChunk?: (chunk: string, stream: "stdout" | "stderr") => void;
  /**
   * Optional callback invoked each time the agent starts a tool call, for
   * live activity display (e.g. a spinner). Independent of `onOutputChunk`.
   */
  onToolCall?: (call: ToolCall) => void;
  /**
   * Optional AbortSignal; when aborted, the harness should terminate its
   * in-flight process (e.g. on SIGINT) rather than leave it running.
   */
  signal?: AbortSignal;
}

export interface Harness {
  run(options: HarnessRunOptions): Promise<HarnessResult>;
}
