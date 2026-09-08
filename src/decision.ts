import type { ApprovalClaims } from "./assertion.ts";
import { HostDecisionError } from "./errors.ts";
import { applyDecision, lockedCartFingerprint } from "./logic.ts";
import type { SpendRequest } from "./types.ts";

export function assertJtiUnused(
  existing: { usedAt: string } | undefined,
): void {
  if (existing) {
    throw new HostDecisionError(
      "Assertion jti has already been used.",
      409,
      "replayed_jti",
    );
  }
}

export function assertFingerprintMatch(
  request: SpendRequest,
  claimed: string,
): void {
  const stored =
    request.lockedCartFingerprint ??
    lockedCartFingerprint(request.lockedCart);
  const live = lockedCartFingerprint(request.lockedCart);
  if (claimed !== stored || claimed !== live) {
    throw new HostDecisionError(
      "lockedCartFingerprint does not match the stored cart lock.",
      409,
      "fingerprint_mismatch",
    );
  }
}

/**
 * Apply a *verified* assertion to an in-memory spend.
 * Tenant + decision come from claims only — never from a request body.
 */
export function decideFromVerifiedClaims(
  request: SpendRequest,
  claims: ApprovalClaims,
  at = new Date(),
): SpendRequest {
  if (
    claims.tenantId !== request.tenantId ||
    claims.spendRequestId !== request.spendRequestId
  ) {
    throw new HostDecisionError("Spend request not found.", 404, "not_found");
  }
  assertFingerprintMatch(request, claims.lockedCartFingerprint);
  return applyDecision(
    request,
    claims.decision,
    { assertionVerified: true },
    at,
  );
}
