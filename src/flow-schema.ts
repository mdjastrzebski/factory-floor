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
 * A step as written in YAML. Like a GitHub Actions step, it has an optional
 * machine `id` and an optional human-readable `name`; at least one is
 * required. A step's identity is its `id`, or its `name` when it has none.
 */
export const StepSchema = z
  .object({
    id: idSchema("step").optional(),
    name: z.string().min(1, "step name must be a non-empty string").optional(),
    prompt: z.string().min(1, "step prompt must be a non-empty string"),
  })
  .refine((step) => step.id !== undefined || step.name !== undefined, {
    message: "step must have an id or a name",
    path: ["name"],
  });

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

    flow.steps.forEach((step, index) => {
      for (const message of checkReferences(step.prompt, inputIds)) {
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

/** A validated step with its `id` and display `name` resolved. */
export interface Step {
  /** Slug identifier: the explicit `id`, or a unique slug of `name`. Names the step's log file. */
  id: string;
  /** Human-readable label for progress output: the explicit `name`, or `id`. */
  name: string;
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

/**
 * Fills in defaults: steps without an `id` get a slug of their `name`, made
 * unique against every other step's id (explicit ids are reserved first, so
 * they never get a suffix); a missing `name` falls back to the `id`.
 */
function resolveFlow(raw: RawFlow, flowPath: string): Flow {
  const id = raw.id ?? slugify(basename(flowPath, extname(flowPath)), "flow");
  const used = new Set(raw.steps.flatMap((step) => (step.id ? [step.id] : [])));
  const steps = raw.steps.map((step): Step => {
    const stepId = step.id ?? uniqueSlug(step.name!, used);
    return { id: stepId, name: step.name ?? stepId, prompt: step.prompt };
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
