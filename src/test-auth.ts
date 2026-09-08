import { TestAuthConfigError } from "./errors.ts";

const TEST_USER_ID = /^[A-Za-z0-9_.:@-]{1,128}$/;
const LOCAL_DEV_ENVIRONMENTS = new Set(["development", "local", "dev"]);

export type TestAuthProps = { userId?: string };

export type TestAuthEnv = {
  ALLOW_TEST_AUTH?: string;
  ENVIRONMENT?: string;
  PUBLIC_BASE_URL?: string;
};

export function isTestAuthFlagSet(env: Pick<TestAuthEnv, "ALLOW_TEST_AUTH">): boolean {
  return env.ALLOW_TEST_AUTH === "true";
}

/** wrangler.toml deploy path is production unless .dev.vars sets development/local. */
export function isLocalDevEnvironment(
  env: Pick<TestAuthEnv, "ENVIRONMENT">,
): boolean {
  return LOCAL_DEV_ENVIRONMENTS.has((env.ENVIRONMENT ?? "").toLowerCase());
}

export function isLocalDevHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}

export function isLocalDevRequest(request: Request): boolean {
  return isLocalDevHostname(new URL(request.url).hostname);
}

export function isLocalPublicBaseUrl(
  env: Pick<TestAuthEnv, "PUBLIC_BASE_URL">,
): boolean {
  const base = env.PUBLIC_BASE_URL?.trim();
  if (!base) {
    return true;
  }
  try {
    return isLocalDevHostname(new URL(base).hostname);
  } catch {
    return false;
  }
}

/**
 * N-3: ALLOW_TEST_AUTH=true on the production wrangler.toml path is a hard
 * failure (not a silent honor). Local wrangler must set ENVIRONMENT=development
 * in .dev.vars.
 */
export function assertTestAuthAllowedForEnv(env: TestAuthEnv): void {
  if (isTestAuthFlagSet(env) && !isLocalDevEnvironment(env)) {
    throw new TestAuthConfigError();
  }
}

/**
 * Honor test bearer tokens only when the flag is on, ENVIRONMENT is local/dev,
 * the request Host is loopback, and PUBLIC_BASE_URL is unset or loopback.
 */
export function isTestAuthEnabled(
  env: TestAuthEnv,
  request?: Request,
): boolean {
  if (!isTestAuthFlagSet(env) || !isLocalDevEnvironment(env)) {
    return false;
  }
  if (request && !isLocalDevRequest(request)) {
    return false;
  }
  if (request && !isLocalPublicBaseUrl(env)) {
    return false;
  }
  return true;
}

/**
 * Local-only identity. Production must leave ALLOW_TEST_AUTH unset/false
 * so this always returns undefined (MCP then fails closed without userId).
 */
export function resolveTestUserId(
  request: Request,
  env: TestAuthEnv,
): string | undefined {
  if (!isTestAuthEnabled(env, request)) {
    return undefined;
  }
  const header = request.headers.get("Authorization") ?? "";
  const match = /^Bearer\s+test:(.+)$/i.exec(header);
  const userId = match?.[1]?.trim() ?? "";
  if (!userId || userId === "anonymous" || !TEST_USER_ID.test(userId)) {
    return undefined;
  }
  return userId;
}

export function applyMcpProps(
  ctx: ExecutionContext,
  props: TestAuthProps,
): void {
  (ctx as ExecutionContext & { props: TestAuthProps }).props = props;
}

export function attachTestAuthProps(
  request: Request,
  env: TestAuthEnv,
  ctx: ExecutionContext,
): void {
  const userId = resolveTestUserId(request, env);
  if (userId) {
    applyMcpProps(ctx, { userId });
  }
}
