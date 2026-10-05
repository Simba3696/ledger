// Postgres SQLSTATE codes for input the database itself refused (LLD §11).
// Store modules validate first with field-specific messages
// (store/validate.ts); this is the backstop so anything that slips past
// still reads as a client error, never a bare 500. The database's own
// message is logged by the caller, never returned — it can name tables and
// columns.
const DB_ERROR_STATUS: Record<string, { status: number; message: string }> = {
  "22021": { status: 400, message: "Input contains an invalid character" }, // character_not_in_repertoire (e.g. NUL)
  "22P05": { status: 400, message: "Input contains an invalid character" }, // untranslatable_character
  "22003": { status: 400, message: "A number is out of range" }, // numeric_value_out_of_range
  "22007": { status: 400, message: "Invalid date" }, // invalid_datetime_format
  "22008": { status: 400, message: "Invalid date" }, // datetime_field_overflow
  "22P02": { status: 400, message: "Invalid input" }, // invalid_text_representation
  "23502": { status: 400, message: "A required value is missing" }, // not_null_violation
  "23514": { status: 400, message: "Invalid value" }, // check_violation
  "23503": { status: 400, message: "Refers to something that doesn't exist" }, // foreign_key_violation
  "23505": { status: 409, message: "That already exists" }, // unique_violation
};

export function mapDatabaseError(err: unknown): { status: number; message: string } | null {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" ? (DB_ERROR_STATUS[code] ?? null) : null;
}
