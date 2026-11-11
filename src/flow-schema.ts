import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { slugify, uniqueSlug } from "./slug.ts";
import { checkDefaultReferences, checkReferences } from "./template.ts";

/**
 * Identifier format for flow and step `id`s, modelled on GitHub Actions step
 * ids but restricted to lowercase so ids are stable, filesystem-safe slugs
 * (they name log files).
 */
const ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;
const idSchema = (what: string) =>
  z
    .string()
    .regex(
      ID_PATTERN,
      `${what} id must start with a lowercase letter or digit and contain only lowercase letters, digits, "-" or "_"`,
    );

/**
 * An input definition as written in YAML. A `null` definition (`idea:` with
 * nothing after it) is treated as `{}`: required, no description. Inputs are
 * untyped strings, so a non-string `default` is rejected rather than coerced.
 */
export const InputSchema = z.preprocess(
  (value) => (value === null ? {} : value),
  z.strictObject({
    description: z.string().optional(),
    required: z.boolean().optional(),
    default: z.string().optional(),
  }),
);

/**
 * A step input in the map form of a step's `inputs`. A string is a binding
 * (a literal, or a template evaluated in flow scope); `null` or an object is
 * a definition like a flow input's, resolved by name.
 */
export const StepInputSchema = z.union([z.string(), InputSchema], {
  error:
    "step input must be a binding string, or a definition with description, required and default",
});

/**
 * A step's `inputs` as written in YAML: a list of ids (each bound by name),
 * or a map from id to a binding or definition. The list form is normalized to
 * the map form (`[a]` is `{a: null}`), so it parses to the map form.
 */
export const StepInputsSchema = z.preprocess(
  (value, ctx) => {
    if (!Array.isArray(value)) return value;
    const seen = new Set<unknown>();
    for (const id of value) {
      if (typeof id !== "string") {
        ctx.addIssue({ code: "custom", message: "step inputs list must contain only input ids" });
        return value;
      }
      if (seen.has(id)) ctx.addIssue({ code: "custom", message: `duplicate input "${id}"` });
      seen.add(id);
    }
    return Object.fromEntries(value.map((id) => [id, null]));
  },
  z.record(z.string(), StepInputSchema, {
    error: "step inputs must be a list of input ids or a map of input id to binding or definition",
  }),
);

/**
 * A step as written in YAML. Like a GitHub Actions step, it has an optional
 * machine `id` and an optional human-readable `name`; at least one is
 * required. A step's identity is its `id`, or its `name` when it has none.
 */
export const StepSchema = z
  .object({
    id: idSchema("step").optional(),
    name: z.string().min(1, "step name must be a non-empty string").optional(),
    inputs: StepInputsSchema.optional(),
    prompt: z.string().min(1, "step prompt must be a non-empty string"),
  })
  .refine((step) => step.id !== undefined || step.name !== undefined, {
    message: "step must have an id or a name",
    path: ["name"],
  });

/**
 * A flow as written in YAML. Like a GitHub Actions workflow, `name` is the
 * human-readable title; `id` is the slug identifier (GitHub derives it from
 * the file name, which is also the default here). This checks shape only;
 * cross-references (ids, bindings, input sources, prompt references) are
 * checked while resolving, see {@link resolveFlow}.
 */
export const FlowSchema = z.object({
  id: idSchema("flow").optional(),
  name: z.string().min(1, "flow name must be a non-empty string").optional(),
  cwd: z.string().optional(),
  inputs: z.record(z.string(), InputSchema).optional(),
  steps: z.array(StepSchema).min(1, "flow must have at least one step"),
});

export type RawFlow = z.infer<typeof FlowSchema>;

/**
 * Where a step input's value comes from, resolved at load time (ADR 01):
 * an explicit binding, else the flow input of the same name, else the
 * input's default (`""` for an optional input with none).
 */
export type StepInputSource =
  /** A template rendered in flow scope (flow inputs and built-ins); a literal has no references. */
  | { kind: "binding"; template: string }
  | { kind: "flowInput"; id: string }
  | { kind: "value"; value: string };

/** A declared step input with its source resolved. */
export interface StepInput {
  id: string;
  description?: string;
  source: StepInputSource;
}

/** A validated step with its `id` and display `name` resolved. */
export interface Step {
  /** Slug identifier: the explicit `id`, or a unique slug of `name`. Names the step's log file. */
  id: string;
  /** Human-readable label for progress output: the explicit `name`, or `id`. */
  name: string;
  /**
   * The step's declared inputs, in declaration order. `undefined` when the
   * step has no `inputs` key: its prompt then sees every flow input.
   */
  inputs?: StepInput[];
  prompt: string;
}

/** A declared flow input with its effective `required` resolved. */
export interface FlowInput {
  id: string;
  description?: string;
  /** Effective requiredness: false when a `default` exists, else `required` (default true). */
  required: boolean;
  /** May contain `${{ … }}` built-in references, rendered at run start. */
  default?: string;
}

/** A validated flow with its `id`, display `name` and step ids resolved. */
export interface Flow {
  /** Slug identifier: the explicit `id`, or a slug of the flow file's base name. */
  id: string;
  /** Human-readable title: the explicit `name`, or `id`. */
  name: string;
  cwd?: string;
  /** Declared inputs in declaration order; empty when the flow declares none. */
  inputs: FlowInput[];
  steps: Step[];
}

type RawStepInput = z.infer<typeof StepInputSchema>;

/**
 * Step ids with defaults filled in: steps without an `id` get a slug of their
 * `name`, made unique against every other step's id (explicit ids are reserved
 * first, so they never get a suffix).
 */
function resolveStepIds(steps: readonly { id?: string; name?: string }[]): string[] {
  const used = new Set(steps.flatMap((step) => (step.id ? [step.id] : [])));
  return steps.map((step) => step.id ?? uniqueSlug(step.name ?? "", used));
}

/** A load-time problem with a flow file, reported like a zod issue. */
interface FlowIssue {
  message: string;
  path: (string | number)[];
}

/**
 * The source of a step input: an explicit binding, else the flow input of the
 * same name, else its default (`""` when optional with none). `undefined`
 * means it has no source. This is the only place that rule lives.
 */
function resolveStepInputSource(
  id: string,
  value: RawStepInput,
  flowInputIds: readonly string[],
): StepInputSource | undefined {
  if (typeof value === "string") return { kind: "binding", template: value };
  if (flowInputIds.includes(id)) return { kind: "flowInput", id };
  if (value.default !== undefined) return { kind: "value", value: value.default };
  if (value.required === false) return { kind: "value", value: "" };
  return undefined;
}

/**
 * Checks cross-references and fills in defaults in one pass: step ids (see
 * {@link resolveStepIds}); a missing `name` falls back to the `id`; step
 * inputs are resolved to their sources. Returns the resolved flow, or every
 * issue found.
 */
function resolveFlow(
  raw: RawFlow,
  flowPath: string,
): { ok: true; flow: Flow } | { ok: false; issues: FlowIssue[] } {
  const issues: FlowIssue[] = [];
  const flowInputIds = Object.keys(raw.inputs ?? {});
  for (const [id, input] of Object.entries(raw.inputs ?? {})) {
    const idResult = idSchema("input").safeParse(id);
    if (!idResult.success) {
      issues.push({
        message: `${idResult.error.issues[0].message} (got "${id}")`,
        path: ["inputs", id],
      });
    } else if (input.default !== undefined && input.required === true) {
      issues.push({
        message: `input "${id}" has a default, so it cannot be required: true`,
        path: ["inputs", id, "required"],
      });
    }
    if (input.default !== undefined) {
      for (const message of checkDefaultReferences(input.default)) {
        issues.push({ message: `input "${id}": ${message}`, path: ["inputs", id, "default"] });
      }
    }
  }

  const stepIds = resolveStepIds(raw.steps);
  const steps = raw.steps.map((step, index): Step => {
    const stepId = stepIds[index];
    const scope = { preceding: stepIds.slice(0, index), all: stepIds };
    const stepInputs = step.inputs === undefined ? undefined : Object.entries(step.inputs);
    const inputs: StepInput[] = [];
    for (const [id, value] of stepInputs ?? []) {
      const path = ["steps", index, "inputs", id];
      const label = `step "${stepId}" input "${id}"`;
      const idResult = idSchema("input").safeParse(id);
      if (!idResult.success) {
        issues.push({ message: `${idResult.error.issues[0].message} (got "${id}")`, path });
        continue;
      }
      if (typeof value === "string") {
        for (const message of checkReferences(value, flowInputIds, scope)) {
          issues.push({ message: `${label}: ${message}`, path });
        }
      } else if (value.default !== undefined && value.required === true) {
        issues.push({
          message: `${label} has a default, so it cannot be required: true`,
          path: [...path, "required"],
        });
        continue;
      }
      const source = resolveStepInputSource(id, value, flowInputIds);
      if (source === undefined) {
        issues.push({
          message: `${label} has no source: no flow input or earlier step output is named "${id}", and it has no default`,
          path,
        });
        continue;
      }
      const description = typeof value === "string" ? undefined : value.description;
      inputs.push({ id, ...(description !== undefined && { description }), source });
    }
    const visible = stepInputs ? stepInputs.map(([id]) => id) : flowInputIds;
    for (const message of checkReferences(step.prompt, visible)) {
      issues.push({ message, path: ["steps", index, "prompt"] });
    }
    return {
      id: stepId,
      name: step.name ?? stepId,
      ...(stepInputs !== undefined && { inputs }),
      prompt: step.prompt,
    };
  });

  const seen = new Map<string, number>();
  raw.steps.forEach((step, index) => {
    const key = step.id ?? step.name;
    if (key === undefined) return;
    const field = step.id !== undefined ? "id" : "name";
    const firstIndex = seen.get(`${field}:${key}`);
    if (firstIndex !== undefined) {
      issues.push({
        message: `duplicate step ${field} "${key}" (first used at steps[${firstIndex}], again at steps[${index}])`,
        path: ["steps", index, field],
      });
    } else {
      seen.set(`${field}:${key}`, index);
    }
  });
  if (issues.length > 0) return { ok: false, issues };

  const id = raw.id ?? slugify(basename(flowPath, extname(flowPath)), "flow");
  const inputs = Object.entries(raw.inputs ?? {}).map(([inputId, input]): FlowInput => ({
    id: inputId,
    ...(input.description !== undefined && { description: input.description }),
    required: input.default !== undefined ? false : (input.required ?? true),
    ...(input.default !== undefined && { default: input.default }),
  }));
  return {
    ok: true,
    flow: {
      id,
      name: raw.name ?? id,
      ...(raw.cwd !== undefined && { cwd: raw.cwd }),
      inputs,
      steps,
    },
  };
}

/** Formats issues as the bulleted body of a {@link FlowValidationError}. */
function formatIssues(
  issues: readonly { message: string; path: readonly PropertyKey[] }[],
): string {
  return issues
    .map((issue) => {
      const where = issue.path.length > 0 ? ` at ${issue.path.map(String).join(".")}` : "";
      return `  - ${issue.message}${where}`;
    })
    .join("\n");
}

export class FlowValidationError extends Error {}

/**
 * Parses a flow's raw YAML text, validates it against {@link FlowSchema} and
 * resolves default ids and names.
 * Throws {@link FlowValidationError} with a human-readable message (and,
 * where available, the flow file's path) on any parse or schema failure.
 */
export function parseFlow(yamlText: string, flowPath: string): Flow {
  let raw: unknown;
  try {
    raw = parseYaml(yamlText);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new FlowValidationError(`Failed to parse YAML in ${flowPath}: ${reason}`);
  }

  const result = FlowSchema.safeParse(raw);
  if (!result.success) {
    throw new FlowValidationError(
      `Invalid flow file ${flowPath}:\n${formatIssues(result.error.issues)}`,
    );
  }

  const resolved = resolveFlow(result.data, flowPath);
  if (!resolved.ok) {
    throw new FlowValidationError(
      `Invalid flow file ${flowPath}:\n${formatIssues(resolved.issues)}`,
    );
  }
  return resolved.flow;
}

/**
 * Reads `flowPath` from disk and validates it via {@link parseFlow}.
 */
export function loadFlow(flowPath: string): Flow {
  let yamlText: string;
  try {
    yamlText = readFileSync(flowPath, "utf8");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new FlowValidationError(`Failed to read flow file ${flowPath}: ${reason}`);
  }
  return parseFlow(yamlText, flowPath);
}
