export class SpendError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpendError";
  }
}

/** ALLOW_TEST_AUTH set on the production wrangler.toml deploy path. */
export class TestAuthConfigError extends SpendError {
  constructor(
    message = "ALLOW_TEST_AUTH is forbidden on the production wrangler.toml deploy path. Set ENVIRONMENT=development only in local .dev.vars.",
  ) {
    super(message);
    this.name = "TestAuthConfigError";
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
