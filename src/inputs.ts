import type { Flow, Step } from "./flow-schema.ts";
import { FlowRunError } from "./flow-run-error.ts";
import { buildVariables, renderTemplate, type VariableContext } from "./template.ts";

/** An input the caller did not supply with `--input`, handed to `RunFlowOptions.promptInput`. */
export interface InputPrompt {
  id: string;
  description?: string;
  /** Whether the input has no default and is not `required: false`. */
  required: boolean;
  /** The rendered default (built-ins such as `git.branch` substituted); `""` when there is none. */
  default: string;
}

/**
 * Parses raw `key=value` strings (the value is everything after the first
 * `=`, so it may contain `=` and newlines) into supplied values keyed by
 * input id. Throws {@link FlowRunError} for a malformed or duplicate
 * `--input`, or an input the flow does not declare.
 */
function parseInputArgs(flow: Flow, raw: string[]): Map<string, string> {
  const declared = new Set(flow.inputs.map((input) => input.id));
  const supplied = new Map<string, string>();
  for (const entry of raw) {
    const eq = entry.indexOf("=");
    if (eq <= 0) {
      throw new FlowRunError(`invalid --input ${JSON.stringify(entry)}: expected key=value`);
    }
    const key = entry.slice(0, eq);
    if (!declared.has(key)) {
      const known =
        flow.inputs.length > 0
          ? `flow declares: ${[...declared].join(", ")}`
          : "flow declares no inputs";
      throw new FlowRunError(`unknown input "${key}" (${known})`);
    }
    if (supplied.has(key)) {
      throw new FlowRunError(`duplicate --input "${key}"`);
    }
    supplied.set(key, entry.slice(eq + 1));
  }
  return supplied;
}

/**
 * Resolves each declared input, in declaration order: supplied value, else
 * its default from `defaults`, else `""` for an optional input. Throws
 * {@link FlowRunError} listing every required input that was not supplied.
 */
function finalizeInputs(
  flow: Flow,
  supplied: ReadonlyMap<string, string>,
  defaults: Readonly<Record<string, string>>,
): Record<string, string> {
  const missing = flow.inputs.filter((input) => input.required && !supplied.has(input.id));
  if (missing.length > 0) {
    throw new FlowRunError(
      missing.map((input) => `missing required input "${input.id}"`).join("; "),
    );
  }

  const resolved: Record<string, string> = {};
  for (const input of flow.inputs) {
    resolved[input.id] = supplied.get(input.id) ?? defaults[input.id] ?? "";
  }
  return resolved;
}

/**
 * Resolves the flow's declared inputs from raw `--input` strings (see
 * {@link parseInputArgs}). Each declared `default` is passed through
 * `renderDefault` (e.g. to substitute built-ins such as `git.branch`). When
 * `promptInput` is given, it is asked for each unsupplied input in declaration
 * order and its answer counts as supplied, even when empty. The result is then
 * finalized (see {@link finalizeInputs}).
 */
export async function resolveInputs(
  flow: Flow,
  raw: string[],
  renderDefault: (template: string) => string,
  promptInput?: (input: InputPrompt) => Promise<string>,
): Promise<Record<string, string>> {
  const supplied = parseInputArgs(flow, raw);
  const defaults: Record<string, string> = {};
  for (const input of flow.inputs) {
    if (input.default !== undefined) {
      defaults[input.id] = renderDefault(input.default);
    }
  }
  if (promptInput) {
    for (const input of flow.inputs) {
      if (supplied.has(input.id)) continue;
      supplied.set(
        input.id,
        await promptInput({
          id: input.id,
          ...(input.description !== undefined && { description: input.description }),
          required: input.required,
          default: defaults[input.id] ?? "",
        }),
      );
    }
  }
  return finalizeInputs(flow, supplied, defaults);
}

/**
 * The values a step's prompt sees as `inputs.<id>`: every flow input when the
 * step declares no `inputs`, otherwise only its declared inputs, each from its
 * load-time-resolved source. Bindings render in flow scope (`flowCtx.inputs`
 * are the flow's inputs).
 */
export function resolveStepInputs(step: Step, flowCtx: VariableContext): Record<string, string> {
  if (step.inputs === undefined) return { ...flowCtx.inputs };
  const values: Record<string, string> = {};
  for (const input of step.inputs) {
    const { source } = input;
    values[input.id] =
      source.kind === "binding"
        ? renderTemplate(source.template, buildVariables(flowCtx))
        : source.kind === "flowInput"
          ? flowCtx.inputs[source.id]
          : source.value;
  }
  return values;
}
