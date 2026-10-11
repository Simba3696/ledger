// Canonical JSON: object keys sorted, so equal values always give equal text.
// Sync compares register values with it (a fork's equal-tag tie-break,
// ADR-0008), and an op's hash is taken over it (design section 3.1).

/** JSON text of a plain JSON value with every object's keys in code-unit
 * order. Undefined object members are left out and -0 is 0, as
 * JSON.stringify does. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((item) => (item === undefined ? "null" : canonicalJson(item))).join(",")}]`;
  const record = value as Record<string, unknown>;
  const members = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
  return `{${members.join(",")}}`;
}

/** Whether two JSON values are equal: the same canonical text. */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  return canonicalJson(a) === canonicalJson(b);
}
