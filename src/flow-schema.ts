import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

export const StepSchema = z.object({
  name: z.string().min(1, "step name must be a non-empty string"),
  prompt: z.string().min(1, "step prompt must be a non-empty string"),
});

export const FlowSchema = z
  .object({
    name: z.string().optional(),
    cwd: z.string().optional(),
    steps: z.array(StepSchema).min(1, "flow must have at least one step"),
  })
  .superRefine((flow, ctx) => {
    const seen = new Map<string, number>();
    flow.steps.forEach((step, index) => {
      const firstIndex = seen.get(step.name);
      if (firstIndex !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate step name "${step.name}" (first used at steps[${firstIndex}], again at steps[${index}])`,
          path: ["steps", index, "name"],
        });
      } else {
        seen.set(step.name, index);
      }
    });
  });

export type Step = z.infer<typeof StepSchema>;
export type Flow = z.infer<typeof FlowSchema>;

export class FlowValidationError extends Error {}

/**
 * Parses a flow's raw YAML text and validates it against {@link FlowSchema}.
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

  return result.data;
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
