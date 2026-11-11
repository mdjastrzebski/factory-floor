/** A piece of a parsed template: literal text, or a `${{ name }}` reference. */
export type TemplateSegment =
  | { kind: "text"; text: string }
  | { kind: "ref"; name: string; raw: string };

/** Thrown by {@link parseTemplate} for malformed `${{ … }}` syntax. */
export class TemplateSyntaxError extends Error {}

/** Everything the built-in variables and `inputs.<id>` are computed from. */
export interface VariableContext {
  flow: { id: string; name: string };
  /** Resolved working directory of the flow. */
  cwd: string;
  runId: string;
  runDir: string;
  stepId: string;
  /** Resolved input values keyed by input id. */
  inputs: Readonly<Record<string, string>>;
}

/**
 * The single registry of built-in variables. Validation ({@link checkReferences})
 * and rendering ({@link buildVariables}) both derive from it, so they cannot drift.
 */
const BUILTINS = {
  "flow.id": (ctx) => ctx.flow.id,
  "flow.name": (ctx) => ctx.flow.name,
  "flow.cwd": (ctx) => ctx.cwd,
  "run.id": (ctx) => ctx.runId,
  "run.dir": (ctx) => ctx.runDir,
  "step.id": (ctx) => ctx.stepId,
} satisfies Record<string, (ctx: VariableContext) => string>;

/** Built-in variables available in every step prompt, in addition to `inputs.<id>`. */
export const BUILTIN_VARIABLES = Object.keys(BUILTINS) as readonly (keyof typeof BUILTINS)[];

/** Builds the flat name-to-value map for {@link renderTemplate}: every built-in plus `inputs.<id>`. */
export function buildVariables(ctx: VariableContext): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const [name, get] of Object.entries(BUILTINS)) vars[name] = get(ctx);
  for (const [id, value] of Object.entries(ctx.inputs)) vars[`inputs.${id}`] = value;
  return vars;
}

const OPEN = "${{";
const CLOSE = "}}";
/** A dotted path: one or more `[A-Za-z0-9_-]+` segments joined by `.`. */
const NAME_PATTERN = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/;

/**
 * Splits a template into literal text and `${{ name }}` references. Any
 * `${{` starts a reference (there is no escaping). Throws
 * {@link TemplateSyntaxError} on an unterminated reference, an empty body, or
 * a body that is not a plain dotted path.
 */
export function parseTemplate(template: string): TemplateSegment[] {
  const segments: TemplateSegment[] = [];
  let pos = 0;
  while (pos < template.length) {
    const start = template.indexOf(OPEN, pos);
    if (start === -1) break;
    const end = template.indexOf(CLOSE, start + OPEN.length);
    if (end === -1) {
      throw new TemplateSyntaxError(
        `unterminated "${OPEN}" (missing "${CLOSE}") in ${JSON.stringify(excerpt(template, start))}`,
      );
    }
    const raw = template.slice(start, end + CLOSE.length);
    const name = template.slice(start + OPEN.length, end).replace(/^[ \t]+|[ \t]+$/g, "");
    if (name === "") {
      throw new TemplateSyntaxError(`empty reference ${raw}`);
    }
    if (!NAME_PATTERN.test(name)) {
      throw new TemplateSyntaxError(
        `invalid reference ${raw}: expected a dotted name such as inputs.idea`,
      );
    }
    if (start > pos) segments.push({ kind: "text", text: template.slice(pos, start) });
    segments.push({ kind: "ref", name, raw });
    pos = end + CLOSE.length;
  }
  if (pos < template.length) segments.push({ kind: "text", text: template.slice(pos) });
  return segments;
}

function excerpt(template: string, start: number): string {
  const text = template.slice(start, start + 30);
  return text.length < template.length - start ? `${text}…` : text;
}

/**
 * Renders a template with a flat name-to-value map. Single pass, left to
 * right: substituted values are inserted verbatim and never scanned again.
 * Throws if a referenced name is missing from `vars`.
 */
export function renderTemplate(template: string, vars: Record<string, string>): string {
  return parseTemplate(template)
    .map((segment) => {
      if (segment.kind === "text") return segment.text;
      if (!Object.hasOwn(vars, segment.name)) {
        throw new Error(`no value for variable "${segment.name}" in ${segment.raw}`);
      }
      return vars[segment.name];
    })
    .join("");
}

/**
 * Step ids visible to a binding (a step input's value), for checking
 * `steps.<id>.outputs.<name>` references. `preceding` are the steps that run
 * before the binding's step; `all` is every step in the flow.
 */
export interface StepScope {
  preceding: readonly string[];
  all: readonly string[];
}

const STEP_OUTPUT_PATTERN = /^steps\.([^.]+)\.outputs\.([^.]+)$/;

/**
 * Checks a template's syntax and references against the built-in variables
 * and the declared input ids. With `steps`, the template is a binding
 * evaluated in flow scope, so `steps.<id>.outputs.<name>` is also checked:
 * unknown steps, forward references and undeclared outputs are errors (no
 * step declares outputs yet, so every such reference is). Returns one
 * human-readable message per problem (empty when the template is valid).
 */
export function checkReferences(
  template: string,
  declaredInputIds: readonly string[],
  steps?: StepScope,
): string[] {
  let segments: TemplateSegment[];
  try {
    segments = parseTemplate(template);
  } catch (error) {
    if (error instanceof TemplateSyntaxError) return [error.message];
    throw error;
  }
  const builtins: readonly string[] = BUILTIN_VARIABLES;
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const segment of segments) {
    if (segment.kind !== "ref" || seen.has(segment.name)) continue;
    seen.add(segment.name);
    const stepOutput = steps ? STEP_OUTPUT_PATTERN.exec(segment.name) : null;
    if (segment.name.startsWith("inputs.")) {
      const id = segment.name.slice("inputs.".length);
      if (!declaredInputIds.includes(id)) {
        problems.push(`unknown input "${id}" in ${segment.raw}`);
      }
    } else if (stepOutput && steps) {
      const [, stepId, output] = stepOutput;
      if (!steps.all.includes(stepId)) {
        problems.push(`unknown step "${stepId}" in ${segment.raw}`);
      } else if (!steps.preceding.includes(stepId)) {
        problems.push(
          `step "${stepId}" does not run before this step, so ${segment.raw} is a forward reference`,
        );
      } else {
        problems.push(`step "${stepId}" declares no output "${output}" in ${segment.raw}`);
      }
    } else if (!builtins.includes(segment.name)) {
      const available = steps
        ? `inputs.<id>, steps.<id>.outputs.<name>, ${BUILTIN_VARIABLES.join(", ")}`
        : `inputs.<id>, ${BUILTIN_VARIABLES.join(", ")}`;
      problems.push(
        `unknown variable "${segment.name}" in ${segment.raw} (available: ${available})`,
      );
    }
  }
  return problems;
}
