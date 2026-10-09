/** An expected, user-facing failure: app.ts's error handler turns it into
 * `{ error: message }` with this HTTP status (400 validation, 403 locked
 * month, 404 missing row, 409 conflict). Anything else is a 500. */
export class LedgerError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
