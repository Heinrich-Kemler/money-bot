export class SpendError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpendError";
  }
}

/** Typed failure for the host Approve/Deny path (HTTP status + machine code). */
export class HostDecisionError extends SpendError {
  status: number;
  code: string;

  constructor(message: string, status: number, code: string) {
    super(message);
    this.name = "HostDecisionError";
    this.status = status;
    this.code = code;
  }
}
