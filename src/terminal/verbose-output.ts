/**
 * Formats raw agent output chunks for `--verbose`, prefixing every line with
 * `[stepId:stream] `. Chunks don't align with lines (assistant text carries no
 * trailing newline), so it tracks per stream whether output is mid-line: only
 * real line starts get a prefix, and a tool-call line (`→ ...`) arriving
 * mid-line is moved onto its own line.
 */
export function createVerboseOutputFormatter(): (
  stepId: string,
  chunk: string,
  stream: "stdout" | "stderr",
) => string {
  const atLineStart = { stdout: true, stderr: true };
  return (stepId, chunk, stream) => {
    if (!chunk) return "";
    let lead = "";
    if (!atLineStart[stream] && chunk.startsWith("→ ")) {
      lead = "\n";
      atLineStart[stream] = true;
    }
    const prefix = `[${stepId}:${stream}] `;
    const text = chunk
      .split("\n")
      .map((line, i, arr) => {
        if (line === "" && i === arr.length - 1) return line;
        return i === 0 && !atLineStart[stream] ? line : prefix + line;
      })
      .join("\n");
    atLineStart[stream] = chunk.endsWith("\n");
    return lead + text;
  };
}
