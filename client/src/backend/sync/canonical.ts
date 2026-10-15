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
  return surelySame(a, b) || canonicalJson(a) === canonicalJson(b);
}

const isEnumerable = Object.prototype.propertyIsEnumerable;

/** Whether `a` and `b` certainly have the same canonical text, found by
 * walking them instead of building it, which equal values (the common case)
 * make cheap. True only when they do; false means not shown, and the texts
 * decide. It reads values as canonicalJson does: strings, booleans, numbers,
 * null and undefined as themselves (=== proves equal text), arrays item by
 * item (a hole only matches a hole), other objects by their own enumerable
 * keys with undefined members left out. Anything else is left to the text,
 * so what canonicalJson throws on still throws. */
function surelySame(a: unknown, b: unknown): boolean {
  const type = typeof a;
  if (type === "string" || type === "boolean" || type === "number" || a === null || a === undefined) return a === b;
  if (type !== "object" || typeof b !== "object" || b === null) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (i in a !== i in b || !surelySame(a[i], b[i])) return false;
    return true;
  }
  if (Array.isArray(b)) return false;
  const x = a as Record<string, unknown>;
  const y = b as Record<string, unknown>;
  let members = 0;
  for (const key of Object.keys(x)) {
    const value = x[key];
    if (value === undefined) continue;
    members++;
    if (!isEnumerable.call(y, key) || !surelySame(value, y[key])) return false;
  }
  for (const key of Object.keys(y)) if (y[key] !== undefined) members--;
  return members === 0;
}
