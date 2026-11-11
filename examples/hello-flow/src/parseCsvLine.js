/**
 * Parses a single line of CSV text into an array of field values.
 *
 * Supports:
 *  - Plain, unquoted fields separated by commas.
 *  - Quoted fields (`"like this"`), including fields that contain commas.
 *  - Escaped double quotes inside a quoted field, written as `""`.
 *  - Empty fields (consecutive commas, or a trailing comma).
 *
 * This is intentionally a small, single-line parser: it does not handle
 * multi-line quoted fields or alternate delimiters.
 *
 * @param {string} line
 * @returns {string[]}
 */
export function parseCsvLine(line) {
  const fields = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  while (i < line.length) {
    const char = line[i];

    if (inQuotes) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += char;
      i += 1;
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }

    if (char === ',') {
      fields.push(field);
      field = '';
      i += 1;
      continue;
    }

    field += char;
    i += 1;
  }

  fields.push(field);
  return fields;
}
