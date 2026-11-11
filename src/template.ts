/** A piece of a parsed template: literal text, or a `${{ name }}` reference. */
export type TemplateSegment =
  | { kind: "text"; text: string }
  | { kind: "ref"; name: string; raw: string };

/** Thrown by {@link parseTemplate} for malformed `${{ … }}` syntax. */
export class TemplateSyntaxError extends Error {}

/** Built-in variables available in every step prompt, in addition to `inputs.<id>`. */
export const BUILTIN_VARIABLES = [
  "flow.id",
  "flow.name",
  "flow.cwd",
  "run.id",
  "run.dir",
  "step.id",
] as const;

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

/** Unique reference names in order of first appearance. */
export function listReferences(template: string): string[] {
  const names = new Set<string>();
  for (const segment of parseTemplate(template)) {
    if (segment.kind === "ref") names.add(segment.name);
  }
  return [...names];
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
 * Checks a template's syntax and references against the built-in variables
 * and the declared input ids. Returns one human-readable message per problem
 * (empty when the template is valid).
 */
export function checkReferences(template: string, declaredInputIds: readonly string[]): string[] {
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
    if (segment.name.startsWith("inputs.")) {
      const id = segment.name.slice("inputs.".length);
      if (!declaredInputIds.includes(id)) {
        problems.push(`unknown input "${id}" in ${segment.raw}`);
      }
    } else if (!builtins.includes(segment.name)) {
      problems.push(
        `unknown variable "${segment.name}" in ${segment.raw} (available: inputs.<id>, ${BUILTIN_VARIABLES.join(", ")})`,
      );
    }
  }
  return problems;
}
