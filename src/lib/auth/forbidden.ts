export class ForbiddenError extends Error {
  readonly code = "FORBIDDEN" as const;
  constructor(message = "Forbidden") {
    super(message);
    this.name = "ForbiddenError";
  }
}

export function throwForbidden(message?: string): never {
  throw new ForbiddenError(message);
}
