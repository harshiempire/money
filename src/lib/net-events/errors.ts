export class NetEventValidationError extends Error {
  readonly code:
    | "INVARIANT_MISMATCH"
    | "OVER_ALLOCATION"
    | "INVALID_LEG"
    | "MISSING_BANK_TXN";

  constructor(
    code: NetEventValidationError["code"],
    message: string,
  ) {
    super(message);
    this.name = "NetEventValidationError";
    this.code = code;
  }
}
