import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { slugify, uniqueSlug } from "./slug.ts";
import { checkReferences } from "./template.ts";

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
 * the file name, which is also the default here).
 */
export const FlowSchema = z
  .object({
    id: idSchema("flow").optional(),
    name: z.string().min(1, "flow name must be a non-empty string").optional(),
    cwd: z.string().optional(),
    inputs: z.record(z.string(), InputSchema).optional(),
    steps: z.array(StepSchema).min(1, "flow must have at least one step"),
  })
  .superRefine((flow, ctx) => {
    const inputIds = Object.keys(flow.inputs ?? {});
    for (const [id, input] of Object.entries(flow.inputs ?? {})) {
      const idResult = idSchema("input").safeParse(id);
      if (!idResult.success) {
        ctx.addIssue({
          code: "custom",
          message: `${idResult.error.issues[0].message} (got "${id}")`,
          path: ["inputs", id],
        });
      } else if (input.default !== undefined && input.required === true) {
        ctx.addIssue({
          code: "custom",
          message: `input "${id}" has a default, so it cannot be required: true`,
          path: ["inputs", id, "required"],
        });
      }
    }

    const stepIds = resolveStepIds(flow.steps);
    flow.steps.forEach((step, index) => {
      const scope = { preceding: stepIds.slice(0, index), all: stepIds };
      const stepInputs = step.inputs === undefined ? undefined : Object.entries(step.inputs);
      for (const [id, value] of stepInputs ?? []) {
        const path = ["steps", index, "inputs", id];
        const label = `step "${stepIds[index]}" input "${id}"`;
        const idResult = idSchema("input").safeParse(id);
        if (!idResult.success) {
          ctx.addIssue({
            code: "custom",
            message: `${idResult.error.issues[0].message} (got "${id}")`,
            path,
          });
        } else if (typeof value === "string") {
          for (const message of checkReferences(value, inputIds, scope)) {
            ctx.addIssue({ code: "custom", message: `${label}: ${message}`, path });
          }
        } else if (value.default !== undefined && value.required === true) {
          ctx.addIssue({
            code: "custom",
            message: `${label} has a default, so it cannot be required: true`,
            path: [...path, "required"],
          });
        } else if (
          !inputIds.includes(id) &&
          value.default === undefined &&
          value.required !== false
        ) {
          ctx.addIssue({
            code: "custom",
            message: `${label} has no source: no flow input or earlier step output is named "${id}", and it has no default`,
            path,
          });
        }
      }
      const visible = stepInputs ? stepInputs.map(([id]) => id) : inputIds;
      for (const message of checkReferences(step.prompt, visible)) {
        ctx.addIssue({ code: "custom", message, path: ["steps", index, "prompt"] });
      }
    });

    const seen = new Map<string, number>();
    flow.steps.forEach((step, index) => {
      const key = step.id ?? step.name;
      if (key === undefined) return;
      const field = step.id !== undefined ? "id" : "name";
      const firstIndex = seen.get(`${field}:${key}`);
      if (firstIndex !== undefined) {
        ctx.addIssue({
          code: "custom",
          message: `duplicate step ${field} "${key}" (first used at steps[${firstIndex}], again at steps[${index}])`,
          path: ["steps", index, field],
        });
      } else {
        seen.set(`${field}:${key}`, index);
      }
    });
  });

export type RawStep = z.infer<typeof StepSchema>;
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

/** Resolves one validated step input to its source; see {@link StepInputSource}. */
function resolveStepInput(id: string, value: RawStepInput, flowInputIds: string[]): StepInput {
  if (typeof value === "string") return { id, source: { kind: "binding", template: value } };
  const source: StepInputSource = flowInputIds.includes(id)
    ? { kind: "flowInput", id }
    : { kind: "value", value: value.default ?? "" };
  return { id, ...(value.description !== undefined && { description: value.description }), source };
}

/**
 * Fills in defaults: step ids (see {@link resolveStepIds}); a missing `name`
 * falls back to the `id`; step inputs are resolved to their sources.
 */
function resolveFlow(raw: RawFlow, flowPath: string): Flow {
  const id = raw.id ?? slugify(basename(flowPath, extname(flowPath)), "flow");
  const stepIds = resolveStepIds(raw.steps);
  const flowInputIds = Object.keys(raw.inputs ?? {});
  const steps = raw.steps.map((step, index): Step => {
    const stepId = stepIds[index];
    return {
      id: stepId,
      name: step.name ?? stepId,
      ...(step.inputs !== undefined && {
        inputs: Object.entries(step.inputs).map(([inputId, value]) =>
          resolveStepInput(inputId, value, flowInputIds),
        ),
      }),
      prompt: step.prompt,
    };
  });
  const inputs = Object.entries(raw.inputs ?? {}).map(([inputId, input]): FlowInput => ({
    id: inputId,
    ...(input.description !== undefined && { description: input.description }),
    required: input.default !== undefined ? false : (input.required ?? true),
    ...(input.default !== undefined && { default: input.default }),
  }));
  return {
    id,
    name: raw.name ?? id,
    ...(raw.cwd !== undefined && { cwd: raw.cwd }),
    inputs,
    steps,
  };
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
    const issues = result.error.issues
      .map((issue) => {
        const where = issue.path.length > 0 ? ` at ${issue.path.join(".")}` : "";
        return `  - ${issue.message}${where}`;
      })
      .join("\n");
    throw new FlowValidationError(`Invalid flow file ${flowPath}:\n${issues}`);
  }

  return resolveFlow(result.data, flowPath);
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
