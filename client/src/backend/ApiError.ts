/** A non-2xx API response. `status` lets a caller tell, say, the 403 for a
 * signed-in account that isn't the owner (only ever seen on the first
 * request, GET /api/config, since every route answers it the same way)
 * apart from a validation error. */
export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}
