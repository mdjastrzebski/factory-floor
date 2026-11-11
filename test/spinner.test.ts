import { S_STEP_CANCEL, S_STEP_ERROR } from "@clack/prompts";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import visibleWidth from "fast-string-width";
import { createSpinner, truncateAnsi } from "../src/terminal/spinner.ts";

class FakeTerminal extends EventEmitter {
  out = "";
  columns: number;
  isTTY: boolean;
  constructor(columns: number, isTTY = true) {
    super();
    this.columns = columns;
    this.isTTY = isTTY;
  }
  write(chunk: string): boolean {
    this.out += chunk;
    return true;
  }
  /** Returns and clears everything written since the last call. */
  take(): string {
    const out = this.out;
    this.out = "";
    return out;
  }
  resize(columns: number): void {
    this.columns = columns;
    this.emit("resize");
  }
}

/** Visible text of the last frame in a chunk of output (after its last erase, newline, or cursor-hide). */
function lastFrame(out: string): string {
  return stripVTControlCharacters(
    out.split(new RegExp(String.raw`\x1b\[0J|\n|\x1b\[\?25l`)).at(-1)!,
  );
}

test("truncateAnsi cuts to the visible width, keeps escapes, and resets styling", () => {
  assert.equal(truncateAnsi("short", 10), "short");
  const cut = truncateAnsi("\x1b[2mabcdefghij\x1b[22m", 5);
  assert.equal(stripVTControlCharacters(cut), "abcd…");
  assert.ok(cut.endsWith("\x1b[0m"));
  assert.equal(truncateAnsi("日本語", 4), "日…");
  assert.equal(truncateAnsi("abc", 0), "");
});

test("frames are truncated to fit within the current terminal width", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const term = new FakeTerminal(40);
  const s = createSpinner(term);
  s.start("x".repeat(100));
  assert.ok(visibleWidth(lastFrame(term.take())) <= 39);
  s.stop("done");
});

test("after the terminal narrows, the reflowed frame is erased across all of its rows", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const term = new FakeTerminal(100);
  const s = createSpinner(term);
  s.start("x".repeat(200));
  const drawn = visibleWidth(lastFrame(term.take()));
  assert.ok(drawn > 90 && drawn <= 99, String(drawn));

  // A ~96-column frame reflows onto 4 rows at width 30: move up 3, then erase down.
  term.resize(30);
  const out = term.take();
  assert.ok(out.startsWith(`\x1b[${Math.ceil(drawn / 30) - 1}A\r\x1b[0J`), JSON.stringify(out));
  assert.ok(visibleWidth(lastFrame(out)) <= 29);

  // The next tick's frame fits on one row again, so only that row is erased.
  t.mock.timers.tick(80);
  assert.ok(term.take().startsWith("\r\x1b[0J"));
  s.stop("done");
});

test("message updates show up on the next tick at the current width", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const term = new FakeTerminal(80);
  const s = createSpinner(term);
  s.start("first");
  s.message("second");
  t.mock.timers.tick(200);
  assert.match(lastFrame(term.take()), /second/);
  s.stop("done");
});

test("erase() removes the frame so other output isn't erased by the next tick", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const term = new FakeTerminal(80);
  const s = createSpinner(term);
  s.start("working");
  term.take();
  s.erase();
  assert.equal(term.take(), "\r\x1b[0J");
  term.write("log line\n");
  term.take();
  t.mock.timers.tick(80);
  // Nothing on screen to erase, so the frame is drawn straight below the log line.
  assert.ok(!term.take().includes("\x1b[0J"));
  s.stop("done");
});

test("stop erases the frame, prints the final line, restores the cursor, and detaches", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const term = new FakeTerminal(80);
  const exitListeners = process.listenerCount("exit");
  const s = createSpinner(term);
  s.start("working");
  assert.equal(term.listenerCount("resize"), 1);
  term.take();

  s.stop("finished");
  const out = term.take();
  assert.ok(out.startsWith("\r\x1b[0J"));
  assert.match(stripVTControlCharacters(out), /finished\n$/);
  assert.ok(out.includes("\x1b[?25h"));
  assert.equal(term.listenerCount("resize"), 0);
  assert.equal(process.listenerCount("exit"), exitListeners);

  // Finishing twice or ticking afterwards writes nothing.
  s.cancel("again");
  t.mock.timers.tick(1000);
  assert.equal(term.take(), "");
});

test("without a TTY, each distinct message is printed as its own line", () => {
  const term = new FakeTerminal(80, false);
  const s = createSpinner(term);
  s.start("one");
  s.message("two");
  s.message("two");
  s.stop("done");
  const lines = stripVTControlCharacters(term.take()).trimEnd().split("\n");
  assert.equal(lines.length, 4);
  assert.match(lines[1], /one$/);
  assert.match(lines[2], /two$/);
  assert.match(lines[3], /done$/);
  assert.equal(term.listenerCount("resize"), 0);
});

test("truncateAnsi boundaries: exact fit, styled text under the limit, no reset without escapes", () => {
  assert.equal(truncateAnsi("abcde", 5), "abcde");
  assert.equal(truncateAnsi("abcdef", 5), "abcd…");
  const styled = "\x1b[2mabc\x1b[22m";
  assert.equal(truncateAnsi(styled, 10), styled);
  assert.equal(truncateAnsi("abcdef", -1), "");
  assert.ok(!truncateAnsi("abcdef", 3).includes("\x1b"));
});

test("start hides the cursor, and a second start is ignored", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const term = new FakeTerminal(80);
  const s = createSpinner(term);
  s.start("one");
  assert.ok(term.take().includes("\x1b[?25l"));
  s.start("two");
  assert.equal(term.take(), "");
  assert.equal(term.listenerCount("resize"), 1);
  s.stop("done");
  assert.equal(term.listenerCount("resize"), 0);
});

test("finishing before start, after stop, or updating after stop writes nothing", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const term = new FakeTerminal(80);
  const s = createSpinner(term);
  s.stop("x");
  s.error("x");
  s.cancel("x");
  s.erase();
  assert.equal(term.take(), "");
  s.start("a");
  s.stop("done");
  term.take();
  s.message("late");
  s.erase();
  assert.equal(term.take(), "");
});

test("error and cancel print their own symbol and message, then clean up like stop", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  for (const [finish, symbol] of [
    ["error", S_STEP_ERROR],
    ["cancel", S_STEP_CANCEL],
  ] as const) {
    const term = new FakeTerminal(80);
    const exitListeners = process.listenerCount("exit");
    const s = createSpinner(term);
    s.start("working");
    term.take();
    s[finish]("final words");
    const out = term.take();
    assert.equal(stripVTControlCharacters(out), `\r${symbol}  final words\n`);
    assert.ok(out.includes("\x1b[?25h"));
    assert.equal(term.listenerCount("resize"), 0);
    assert.equal(process.listenerCount("exit"), exitListeners);
  }
});

test("the exit handler restores the cursor while running", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const term = new FakeTerminal(80);
  const before = process.listeners("exit");
  const s = createSpinner(term);
  s.start("working");
  const added = process.listeners("exit").filter((l) => !before.includes(l));
  assert.equal(added.length, 1);
  term.take();
  (added[0] as () => void)();
  assert.equal(term.take(), "\x1b[?25h");
  s.stop("done");
});

test("non-interactive output: undefined isTTY, TERM=dumb, and non-TTY all skip escapes and timers", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const cases: [string, FakeTerminal, string | undefined][] = [
    ["isTTY false", new FakeTerminal(80, false), undefined],
    [
      "isTTY undefined",
      Object.assign(new FakeTerminal(80), { isTTY: undefined }) as never,
      undefined,
    ],
    ["TERM=dumb", new FakeTerminal(80, true), "dumb"],
  ];
  const originalTerm = process.env.TERM;
  try {
    for (const [label, term, termEnv] of cases) {
      if (termEnv) process.env.TERM = termEnv;
      else process.env.TERM = originalTerm ?? "xterm";
      const s = createSpinner(term);
      s.start("one");
      s.message("one");
      s.erase();
      t.mock.timers.tick(1000);
      s.stop("done");
      const out = term.take();
      assert.ok(!out.includes("\x1b["), `${label}: ${JSON.stringify(out)}`);
      assert.equal(term.listenerCount("resize"), 0, label);
    }
  } finally {
    if (originalTerm === undefined) delete process.env.TERM;
    else process.env.TERM = originalTerm;
  }
});

test("degenerate widths fall back to 80 columns or truncate the message away without throwing", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  for (const columns of [0, undefined]) {
    const term = new FakeTerminal(80);
    term.columns = columns as never;
    const s = createSpinner(term);
    s.start("x".repeat(200));
    const width = visibleWidth(lastFrame(term.take()));
    assert.ok(width > 70 && width <= 79, `columns=${columns}: ${width}`);
    s.stop("done");
  }
  for (const columns of [1, 4, 6]) {
    const term = new FakeTerminal(columns);
    const s = createSpinner(term);
    s.start("message");
    assert.ok(!stripVTControlCharacters(term.take()).includes("message"));
    t.mock.timers.tick(80);
    term.resize(columns);
    s.stop("done");
  }
});

test("wide characters count as two columns when fitting and when erasing after a resize", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const term = new FakeTerminal(40);
  const s = createSpinner(term);
  s.start("日".repeat(60));
  const drawn = visibleWidth(lastFrame(term.take()));
  assert.ok(drawn <= 39 && drawn > 30, String(drawn));
  term.resize(10);
  assert.ok(term.take().startsWith(`\x1b[${Math.ceil(drawn / 10) - 1}A\r\x1b[0J`));
  s.stop("done");
});

test("dots animate 0, 1, 2, 3, 3 per eight ticks, then restart", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const term = new FakeTerminal(80);
  const s = createSpinner(term);
  s.start("w");
  const dotCounts: number[] = [];
  const sample = () => dotCounts.push(lastFrame(term.take()).match(/\.*$/)![0].length);
  sample();
  for (let tick = 1; tick < 48; tick++) {
    t.mock.timers.tick(80);
    sample();
  }
  s.stop("done");
  const expected = [0, 1, 2, 3, 3, 0].flatMap((n) => Array<number>(8).fill(n));
  assert.deepEqual(dotCounts, expected);
});

test("the timer is unref'd so a forgotten spinner can't keep the process alive", (t) => {
  let unrefCalls = 0;
  t.mock.method(globalThis, "setInterval", (() => ({ unref: () => void unrefCalls++ })) as never);
  t.mock.method(globalThis, "clearInterval", (() => {}) as never);
  const s = createSpinner(new FakeTerminal(80));
  s.start("x");
  assert.equal(unrefCalls, 1);
  s.stop("done");
});
