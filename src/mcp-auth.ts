import { requireTenantId } from "./auth.ts";
import {
  applyMcpProps,
  assertTestAuthAllowedForEnv,
  resolveTestUserId,
  type TestAuthEnv,
} from "./test-auth.ts";

export type McpAuthOk = { ok: true; userId: string; allocatesTenantStore: false };
export type McpAuthDenied = {
  ok: false;
  status: number;
  error: string;
  message: string;
  allocatesTenantStore: false;
  allocatesMcpSession: false;
};

export type McpAuthResult = McpAuthOk | McpAuthDenied;

function jsonAuthError(status: number, error: string, message: string): Response {
  return new Response(JSON.stringify({ error, message }, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/**
 * N-3 / N-4: resolve identity before McpAgent.serve.
 * Unauthenticated initialize / tools/list / tools/call must not allocate
 * MoneyBotMCP session DOs or tenant SpendStore DOs.
 */
export function authorizeMcpSession(
  request: Request,
  env: TestAuthEnv,
): McpAuthResult {
  try {
    assertTestAuthAllowedForEnv(env);
  } catch (error) {
    return {
      ok: false,
      status: 500,
      error: "allow_test_auth_forbidden_in_production",
      message:
        error instanceof Error
          ? error.message
          : "ALLOW_TEST_AUTH is forbidden on the production deploy path.",
      allocatesTenantStore: false,
      allocatesMcpSession: false,
    };
  }

  const userId = resolveTestUserId(request, env);
  if (!userId) {
    return {
      ok: false,
      status: 401,
      error: "unauthenticated",
      message:
        "MCP requires an authenticated tenant userId. " +
        "initialize, tools/list, and tools/call do not allocate tenant Durable Objects without identity.",
      allocatesTenantStore: false,
      allocatesMcpSession: false,
    };
  }

  return { ok: true, userId: requireTenantId(userId), allocatesTenantStore: false };
}

export function mcpAuthResponse(result: McpAuthDenied): Response {
  return jsonAuthError(result.status, result.error, result.message);
}

/** Attach props and report whether the caller may route to McpAgent.serve. */
export function gateMcpFetch(
  request: Request,
  env: TestAuthEnv,
  ctx: ExecutionContext,
): { ok: true; userId: string } | { ok: false; response: Response } {
  const result = authorizeMcpSession(request, env);
  if (!result.ok) {
    return { ok: false, response: mcpAuthResponse(result) };
  }
  applyMcpProps(ctx, { userId: result.userId });
  return { ok: true, userId: result.userId };
}
