/**
 * Errors raised by the engine. Codes and messages follow the real APIs
 * (EC2's DependencyViolation, InvalidVpcID.NotFound, S3's NoSuchBucket...)
 * so learners see exactly what they would meet at work.
 *
 * Like EC2, client errors use HTTP 400 unless a service uses something else
 * (S3 returns 404 for NoSuchBucket and 409 for bucket name conflicts).
 */
export class EngineError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number = 400,
    /** Field-level problems for the console form: [{ field, message }]. */
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "EngineError";
  }
}

export const errors = {
  /** `MissingParameter: The request must contain the parameter cidrBlock` */
  missingParameter: (param: string, details?: unknown) =>
    new EngineError("MissingParameter", `The request must contain the parameter ${param}`, 400, details),
  /** `InvalidParameterValue: Value (x) for parameter y is invalid. <reason>` */
  invalidValue: (param: string, value: unknown, reason?: string, details?: unknown) =>
    new EngineError(
      "InvalidParameterValue",
      `Value (${typeof value === "string" ? value : JSON.stringify(value)}) for parameter ${param} is invalid.${reason ? ` ${reason}` : ""}`,
      400,
      details,
    ),
  invalidParameter: (message: string, details?: unknown) => new EngineError("InvalidParameterValue", message, 400, details),
  /** e.g. `InvalidVpcID.NotFound: The vpc ID 'vpc-123' does not exist` */
  notFound: (code: string, message: string) => new EngineError(code, message, code === "NoSuchBucket" ? 404 : 400),
  /** e.g. `InvalidVpcID.Malformed: Invalid id: "abc" (expecting "vpc-...")` */
  malformed: (code: string, id: string, prefix: string) =>
    new EngineError(code, `Invalid id: "${id}" (expecting "${prefix}-...")`),
  unknownType: (service: string, type: string) =>
    new EngineError("InvalidAction", `Unknown resource type '${service}/${type}'.`, 400),
  dependency: (message: string, dependents: string[]) =>
    new EngineError("DependencyViolation", message, 400, { dependents }),
  unsupportedAction: (action: string) =>
    new EngineError("InvalidAction", `The action '${action}' is not valid for this resource.`, 400),
};
