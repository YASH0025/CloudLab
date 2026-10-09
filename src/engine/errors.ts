/**
 * Errors raised by the engine. Codes follow the style of real cloud APIs
 * (e.g. "DependencyViolation", "InvalidSubnet.Conflict") so learners see
 * the kind of message they would meet in practice.
 */
export class EngineError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number = 400,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "EngineError";
  }
}

export const errors = {
  validation: (message: string, details?: unknown) =>
    new EngineError("ValidationError", message, 400, details),
  invalidParameter: (message: string) =>
    new EngineError("InvalidParameterValue", message, 400),
  notFound: (code: string, id: string) =>
    new EngineError(code, `The resource '${id}' does not exist.`, 404),
  unknownType: (service: string, type: string) =>
    new EngineError("UnknownResourceType", `Unknown resource type '${service}/${type}'.`, 400),
  dependency: (id: string, dependents: string[]) =>
    new EngineError(
      "DependencyViolation",
      `The resource '${id}' has dependent objects and cannot be deleted: ${dependents.join(", ")}.`,
      409,
      { dependents },
    ),
  incorrectState: (id: string, state: string | null, wanted: string) =>
    new EngineError(
      "IncorrectState",
      `The resource '${id}' is in state '${state ?? "none"}' and cannot ${wanted}.`,
      409,
    ),
  unsupportedAction: (action: string) =>
    new EngineError("UnsupportedOperation", `The action '${action}' is not supported for this resource.`, 400),
};
