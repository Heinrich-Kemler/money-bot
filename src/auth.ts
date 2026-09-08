import { SpendError } from "./errors.ts";

export function requireTenantId(userId: string | undefined | null): string {
  const trimmed = userId?.trim() ?? "";
  if (!trimmed || trimmed === "anonymous") {
    throw new SpendError(
      "Unauthenticated: tenant userId is required. Refusing a shared anonymous ledger.",
    );
  }
  return trimmed;
}

/** Canonical SpendStore id. Throws before idFromName when tenantId is missing. */
export function tenantDurableObjectName(tenantId: string): string {
  return `tenant:${requireTenantId(tenantId)}`;
}
