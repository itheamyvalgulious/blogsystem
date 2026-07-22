/**
 * Business error with an explicit HTTP status. The error middleware returns
 * `status` and exposes `message` to the client, so only throw this for
 * messages that are safe to show (no absolute server paths or internals).
 */
export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

/**
 * Config schema/validation failure (ajv messages and the like). These
 * responses historically used 500 with the validation detail visible to the
 * admin UI, so that shape is preserved for API compatibility.
 */
export class ConfigValidationError extends ApiError {
  constructor(message: string) {
    super(500, message);
    this.name = "ConfigValidationError";
  }
}
