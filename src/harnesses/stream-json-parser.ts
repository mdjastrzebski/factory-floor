/**
 * Pure parsing of `claude --output-format stream-json` NDJSON lines, split
 * out of `ClaudeCliHarness` so the event shapes can be unit-tested without
 * spawning a real `claude` binary.
 */

export interface ParsedStreamJsonLine {
  /** Chunks of human-readable text to surface via `onOutputChunk`, in order. */
  displayChunks: string[];
  /** Human-readable descriptions of any permission denials found on this line. */
  denials: string[];
}

/**
 * Parses a single line of `stream-json` output into display text and
 * permission denials. Returns `undefined` for a blank line (nothing to do).
 *
 * A line that isn't valid JSON (shouldn't normally happen with stream-json)
 * is treated as plain text and surfaced verbatim so nothing is silently
 * lost.
 */
export function parseStreamJsonLine(line: string): ParsedStreamJsonLine | undefined {
  if (!line.trim()) return undefined;

  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    return { displayChunks: [`${line}\n`], denials: [] };
  }

  if (typeof event !== "object" || event === null) return undefined;
  const e = event as Record<string, unknown>;

  const displayChunks: string[] = [];
  const denials: string[] = [];

  if (e.type === "assistant") {
    const message = e.message as { content?: unknown } | undefined;
    const content = Array.isArray(message?.content) ? message.content : [];
    for (const block of content) {
      if (typeof block !== "object" || block === null) continue;
      const b = block as Record<string, unknown>;
      if (b.type === "text" && typeof b.text === "string") {
        displayChunks.push(b.text);
      } else if (b.type === "tool_use" && typeof b.name === "string") {
        displayChunks.push(`\n→ ${b.name}\n`);
      }
    }
  } else if (e.type === "result") {
    const resultDenials = e.permission_denials;
    if (Array.isArray(resultDenials)) {
      for (const denial of resultDenials) {
        denials.push(describeDenial(denial));
      }
    }
  }

  return { displayChunks, denials };
}

/** Renders a `permission_denials` entry (shape not strictly documented) as one readable line. */
export function describeDenial(denial: unknown): string {
  if (typeof denial === "string") return denial;
  if (typeof denial === "object" && denial !== null) {
    const d = denial as Record<string, unknown>;
    const tool = d.tool_name ?? d.toolName ?? d.tool;
    const reason = d.reason ?? d.message;
    if (tool || reason) {
      return [tool, reason].filter(Boolean).join(": ");
    }
  }
  return JSON.stringify(denial);
}
