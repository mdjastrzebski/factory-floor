/**
 * Turns a step name into a filesystem-safe slug for its log file: lowercased,
 * with every run of non-alphanumeric characters collapsed to a single `-`
 * and leading/trailing `-` trimmed.
 */
export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "step";
}

/**
 * Produces a unique slug for `name` given the slugs already used earlier in
 * the same run, appending `-2`, `-3`, etc. on collision.
 */
export function uniqueSlug(name: string, used: Set<string>): string {
  const base = slugify(name);
  let candidate = base;
  let counter = 2;
  while (used.has(candidate)) {
    candidate = `${base}-${counter}`;
    counter += 1;
  }
  used.add(candidate);
  return candidate;
}
