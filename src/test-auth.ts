const TEST_USER_ID = /^[A-Za-z0-9_.:@-]{1,128}$/;

export type TestAuthProps = { userId?: string };

export function isTestAuthEnabled(env: {
  ALLOW_TEST_AUTH?: string;
}): boolean {
  return env.ALLOW_TEST_AUTH === "true";
}

/**
 * Local-only identity. Production must leave ALLOW_TEST_AUTH unset/false
 * so this always returns undefined (MCP then fails closed without userId).
 */
export function resolveTestUserId(
  request: Request,
  env: { ALLOW_TEST_AUTH?: string },
): string | undefined {
  if (!isTestAuthEnabled(env)) {
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
  env: { ALLOW_TEST_AUTH?: string },
  ctx: ExecutionContext,
): void {
  const userId = resolveTestUserId(request, env);
  if (userId) {
    applyMcpProps(ctx, { userId });
  }
}
