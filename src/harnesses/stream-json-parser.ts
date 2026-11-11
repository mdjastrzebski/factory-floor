/**
 * Pure parsing of `claude --output-format stream-json` NDJSON lines, split
 * out of `ClaudeCliHarness` so the event shapes can be unit-tested without
 * spawning a real `claude` binary.
 */

import type { ToolCall } from "../harness.ts";

export interface ParsedStreamJsonLine {
  /** Chunks of human-readable text to surface via `onOutputChunk`, in order. */
  displayChunks: string[];
  /** Structured summaries of any tool calls started on this line, in order. */
  toolCalls: ToolCall[];
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
    return { displayChunks: [`${line}\n`], toolCalls: [], denials: [] };
  }

  if (typeof event !== "object" || event === null) return undefined;
  const e = event as Record<string, unknown>;

  const displayChunks: string[] = [];
  const toolCalls: ToolCall[] = [];
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
        const detail = toolCallDetail(b.input);
        displayChunks.push(`\n→ ${b.name}${detail ? ` ${detail.split("\n")[0].trim()}` : ""}\n`);
        const activity = TOOL_ACTIVITY[b.name];
        toolCalls.push({ name: b.name, ...(detail !== undefined && { detail }), ...(activity && { activity }) });
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

  return { displayChunks, toolCalls, denials };
}

/**
 * Generic, human-readable description of what each of Claude Code's own
 * tools does, for display where exact arguments (an arbitrary file path or
 * shell command) would be noise. Specific to Claude Code's tool vocabulary -
 * another harness would define its own.
 */
const TOOL_ACTIVITY: Record<string, string> = {
  Bash: "Running command",
  Read: "Reading file",
  Write: "Writing file",
  Edit: "Editing file",
  MultiEdit: "Editing file",
  Grep: "Searching",
  Glob: "Finding files",
  WebFetch: "Fetching URL",
  WebSearch: "Searching the web",
  Task: "Running subtask",
  TodoWrite: "Updating todos",
};

/** Input fields checked, in order, for a tool call's primary argument. */
const DETAIL_FIELDS = ["file_path", "notebook_path", "command", "pattern", "path", "url"] as const;

/** Picks the primary argument (file path, command, ...) out of a `tool_use` block's `input`, if any. */
function toolCallDetail(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const fields = input as Record<string, unknown>;
  for (const field of DETAIL_FIELDS) {
    const value = fields[field];
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
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
