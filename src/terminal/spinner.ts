/**
 * A local replacement for `spinner()` from `@clack/prompts` (v1.9), whose
 * spinner:
 * - reads the terminal width once at creation, so after the terminal narrows
 *   its erase math is wrong and stale frames pile up in scrollback;
 * - puts a TTY stdin into raw mode (via `block()`) and calls `process.exit(0)`
 *   on Ctrl-C, skipping our SIGINT handler and orphaning the `claude` child;
 * - leaves its frame on the line with no way to clear it, so interleaved
 *   `log.*` output gets glued onto it (hence `erase()` here).
 * This one never touches stdin, re-measures on every frame and on resize, and
 * truncates the message to fit one line. It copies clack's look (frames,
 * timing, magenta frame, `S_BAR` / `S_STEP_*` symbols imported from clack);
 * keep those in sync if clack's visuals change.
 */
import { S_BAR, S_STEP_CANCEL, S_STEP_ERROR, S_STEP_SUBMIT, unicode } from "@clack/prompts";
import stringWidth from "fast-string-width";
import truncatedWidth from "fast-string-truncated-width";
import pc from "picocolors";

export interface SpinnerOutput {
  isTTY?: boolean;
  columns?: number;
  write(chunk: string): unknown;
  on(event: "resize", listener: () => void): unknown;
  off(event: "resize", listener: () => void): unknown;
}

export interface Spinner {
  start(message: string): void;
  message(message: string): void;
  /** Erases the current frame so other output can be written; the next tick redraws below it. */
  erase(): void;
  stop(message: string): void;
  error(message: string): void;
  cancel(message: string): void;
}

const FRAMES = unicode ? ["◒", "◐", "◓", "◑"] : ["•", "o", "O", "0"];
const DELAY_MS = unicode ? 80 : 120;
/** Frame glyph plus two spaces, before the message. */
const PREFIX_WIDTH = 3;
/** Animated "..." after the message. */
const DOTS_WIDTH = 3;

/** Cuts `text` to at most `max` terminal columns, marking the cut with `…` and resetting any styling. */
export function truncateAnsi(text: string, max: number): string {
  if (max <= 0) return "";
  const { truncated, index } = truncatedWidth(text, { limit: max, ellipsis: "…" });
  if (!truncated) return text;
  return `${text.slice(0, index)}…${text.includes("\x1b[") ? "\x1b[0m" : ""}`;
}

/**
 * Creates a clack-styled spinner. A narrowed terminal reflows the frame's
 * line, so erasing it uses the frame's exact width and the *current* column
 * count. Without a TTY it prints each distinct message as its own line instead.
 */
export function createSpinner(output: SpinnerOutput = process.stdout): Spinner {
  const interactive = output.isTTY === true && process.env.TERM !== "dumb";
  let running = false;
  let text = "";
  let tick = 0;
  let timer: NodeJS.Timeout | undefined;
  /** Visible width of the frame currently on screen, if one is. */
  let drawnWidth: number | undefined;

  const columns = () => output.columns || 80;

  const eraseFrame = () => {
    if (drawnWidth === undefined) return;
    const rows = Math.max(1, Math.ceil(drawnWidth / columns()));
    output.write(`${rows > 1 ? `\x1b[${rows - 1}A` : ""}\r\x1b[0J`);
    drawnWidth = undefined;
  };

  const render = () => {
    eraseFrame();
    const max = columns() - 1;
    const dots = ".".repeat(Math.min(DOTS_WIDTH, Math.floor(tick / 8) % 5));
    const message = truncateAnsi(text, max - PREFIX_WIDTH - DOTS_WIDTH);
    const frame = truncateAnsi(
      `${pc.magenta(FRAMES[tick % FRAMES.length])}  ${message}${dots}`,
      max,
    );
    output.write(frame);
    drawnWidth = stringWidth(frame);
  };

  const onTick = () => {
    tick++;
    render();
  };

  const showCursor = () => {
    output.write("\x1b[?25h");
  };

  const writeLine = (message: string) => {
    output.write(`${pc.magenta(FRAMES[0])}  ${message}\n`);
  };

  const finish = (symbol: string, message: string) => {
    if (!running) return;
    running = false;
    if (interactive) {
      clearInterval(timer);
      output.off("resize", render);
      process.off("exit", showCursor);
      eraseFrame();
      showCursor();
    }
    output.write(`${symbol}  ${message}\n`);
  };

  return {
    start(message) {
      if (running) return;
      running = true;
      text = message;
      tick = 0;
      output.write(`${pc.gray(S_BAR)}\n`);
      if (!interactive) {
        writeLine(text);
        return;
      }
      output.write("\x1b[?25l");
      process.once("exit", showCursor);
      output.on("resize", render);
      render();
      timer = setInterval(onTick, DELAY_MS);
      timer.unref?.();
    },
    message(message) {
      if (!running || message === text) return;
      text = message;
      if (!interactive) writeLine(text);
    },
    erase() {
      if (running && interactive) eraseFrame();
    },
    stop: (message) => finish(pc.green(S_STEP_SUBMIT), message),
    error: (message) => finish(pc.red(S_STEP_ERROR), message),
    cancel: (message) => finish(pc.red(S_STEP_CANCEL), message),
  };
}
