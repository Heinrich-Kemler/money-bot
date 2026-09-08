import { timingSafeEqualString } from "./assertion.ts";
import { HostDecisionError } from "./errors.ts";
import { isLocalDevEnvironment } from "./test-auth.ts";

export const MIN_HOST_API_TOKEN_LENGTH = 16;
export const HOST_TENANT_HEADER = "X-Money-Bot-Tenant";

const HOST_BEARER = /^Bearer\s+host:(.+)$/i;

export type HostAuthEnv = {
  HOST_API_TOKEN?: string;
  ENVIRONMENT?: string;
};

/**
 * Dedicated host secret for POST /host/widget-decision.
 * Fail closed when unset (production must configure HOST_API_TOKEN).
 */
export function requireHostApiToken(env: HostAuthEnv): string {
  const token = env.HOST_API_TOKEN?.trim() ?? "";
  if (token.length < MIN_HOST_API_TOKEN_LENGTH) {
    const where = isLocalDevEnvironment(env) ? "local" : "production";
    throw new HostDecisionError(
      `HOST_API_TOKEN is not configured (${where} widget decide fails closed).`,
      401,
      "missing_host_api_token",
    );
  }
  return token;
}

/**
 * Authorization: Bearer host:<HOST_API_TOKEN>
 * Missing or invalid token → 401. Never honor a body field as the host secret.
 */
export function verifyHostApiBearer(
  request: Request,
  env: HostAuthEnv,
): void {
  const expected = requireHostApiToken(env);
  const header = request.headers.get("Authorization") ?? "";
  const provided = HOST_BEARER.exec(header)?.[1] ?? "";
  if (!provided || !timingSafeEqualString(expected, provided)) {
    throw new HostDecisionError(
      "Invalid or missing host API token. Use Authorization: Bearer host:<HOST_API_TOKEN>.",
      401,
      "bad_host_token",
    );
  }
}

/**
 * Tenant lookup key from authenticated host context.
 * Body tenantId is a routing hint only — never applyDecision authority.
 */
export function resolveWidgetTenantLookup(
  request: Request,
  bodyTenantId: string | undefined,
): string {
  const headerTenant = request.headers.get(HOST_TENANT_HEADER)?.trim() ?? "";
  const bodyTenant = bodyTenantId?.trim() ?? "";
  if (headerTenant && bodyTenant && headerTenant !== bodyTenant) {
    throw new HostDecisionError(
      `${HOST_TENANT_HEADER} and body tenantId do not match.`,
      400,
      "tenant_lookup_mismatch",
    );
  }
  const tenantId = headerTenant || bodyTenant;
  if (!tenantId || tenantId === "anonymous") {
    throw new HostDecisionError(
      `Widget decide needs a tenant lookup (${HOST_TENANT_HEADER} or body tenantId as a routing key). ` +
        "tenantId is not authority for applyDecision.",
      400,
      "missing_tenant_lookup",
    );
  }
  return tenantId;
}
