// What a call's arguments look like by the time the SQL store sees them: the
// trip over the wire (HttpBackend's JSON.stringify and the URL path, then
// express.json() and Express's string path parameters), then the coercions
// server/src/routes.ts applies before calling the store. DocumentBackend runs
// every argument through here first, so the same input reaches the same
// validation with the same values (NaN becomes null in a body and then 0
// through Number(null), "abc" becomes NaN, and so on).

/** A JSON request body as express.json() parses it: what JSON.stringify
 * makes of the value, read back. `undefined` (no body at all) stays
 * undefined, and the routes then read `req.body ?? {}`. */
export function wireBody(value: unknown): Record<string, unknown> {
  const text = JSON.stringify(value);
  if (text === undefined) return {};
  const parsed: unknown = JSON.parse(text);
  return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
}

/** A number sent as a URL path segment and read back with Number(). */
export function pathNumber(value: number): number {
  return Number(String(value));
}

/** One field of a parsed body, as optional chaining on a non-object yields. */
function field(value: unknown, key: string): unknown {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
}

// routes.ts:96-104 (POST /entries) and :113-121 (PUT /entries/...).
export function entryFields(body: Record<string, unknown>) {
  return {
    amount: Number(body.amount),
    remarks: String(body.remarks ?? ""),
    category: body.category,
    isCard: Boolean(body.isCard),
  };
}

// routes.ts:144-149 (PATCH .../move).
export function moveTarget(body: Record<string, unknown>): number {
  return Number(body.toRow);
}

// routes.ts:76 (PUT .../lock).
export function lockFlag(body: Record<string, unknown>): boolean {
  return Boolean(body.locked);
}

// routes.ts:168-175 and :177-186 (PUT /finance/...).
function amountField(value: unknown): number | null {
  return value === null || value === undefined || value === "" ? null : Number(value);
}

export function incomeFields(body: Record<string, unknown>) {
  const savings = Array.isArray(body.savings)
    ? body.savings.map((e: unknown) => ({ name: String(field(e, "name") ?? ""), amount: Number(field(e, "amount")) }))
    : [];
  return { salary: amountField(body.salary), otherIncome: amountField(body.otherIncome), savings };
}

// routes.ts:214 and :224 (debts).
export function debtFields(body: Record<string, unknown>) {
  return { name: String(body.name ?? ""), amount: Number(body.amount) };
}

// routes.ts:241-250 (PUT /credit-card-bills/...).
export function cardFields(body: Record<string, unknown>) {
  if (!Array.isArray(body.cards)) return [];
  return body.cards.map((c: unknown) => {
    const dueDate = field(c, "dueDate");
    return {
      name: String(field(c, "name") ?? ""),
      due: Number(field(c, "due")),
      paid: Number(field(c, "paid")),
      dueDate: dueDate === null || dueDate === undefined || dueDate === "" ? null : String(dueDate),
      settled: field(c, "settled") === true,
    };
  });
}

// routes.ts:287-303 (POST /emi, PUT /emi/:row).
export function emiFields(body: Record<string, unknown>) {
  const optional = (value: unknown) => (value === null || value === undefined || value === "" ? null : Number(value));
  return {
    cardOrBank: String(body.cardOrBank ?? ""),
    emiAmount: Number(body.emiAmount),
    dueDay: Number(body.dueDay),
    totalAmount: Number(body.totalAmount),
    remarks: String(body.remarks ?? ""),
    remainingAsOf: Number(body.remainingAsOf),
    durationMonths: body.durationMonths === null || body.durationMonths === undefined ? null : Number(body.durationMonths),
    interestRate: optional(body.interestRate),
    foreclosureCharge: optional(body.foreclosureCharge),
  };
}

// routes.ts:342-343 (PATCH /emi/:row/pay).
export function paymentAmount(body: Record<string, unknown>): number {
  return Number(body.amount);
}

// routes.ts:352-358: the `months` query string, "auto" or a count clamped to
// 1-600 the way a stored Duration is. HttpBackend sends `?months=${months}`
// unencoded and Express's query parser decodes "+" as a space, so an
// exponent form such as "1e+21" reaches the route as "1e 21" (NaN, so 1).
export function projectionMonths(months: unknown): number | "auto" {
  const raw = String(months).replace(/\+/g, " ");
  return raw === "auto" ? "auto" : Math.min(600, Math.max(1, Number(raw) || 1));
}

// routes.ts:365-374 (POST /subscriptions, PUT /subscriptions/:row).
export function subscriptionFields(body: Record<string, unknown>) {
  return {
    service: String(body.service ?? ""),
    amount: Number(body.amount),
    duration: body.duration,
    expiryAnchor: String(body.expiryAnchor ?? ""),
    cardOrBank: String(body.cardOrBank ?? ""),
  };
}
