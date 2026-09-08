import type { ApprovalClaims } from "./assertion.ts";
import { WIDGET_ISS } from "./assertion.ts";
import { HostDecisionError } from "./errors.ts";
import {
  applyDecision,
  applyKeepLooking,
  lockedCartFingerprint,
} from "./logic.ts";
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
  if (claims.decision !== "approved" && claims.decision !== "denied") {
    throw new HostDecisionError(
      "OOB decide only accepts approved or denied.",
      400,
      "bad_decision",
    );
  }
  assertFingerprintMatch(request, claims.lockedCartFingerprint);
  return applyDecision(
    request,
    claims.decision,
    { assertionVerified: true },
    at,
  );
}

/**
 * Apply a verified grokbot-widget assertion.
 * approved/denied → applyDecision(assertionVerified).
 * keep_looking → CANCELLED (no human-deny cooldown).
 */
export function decideFromVerifiedWidgetClaims(
  request: SpendRequest,
  claims: ApprovalClaims,
  at = new Date(),
): SpendRequest {
  if (claims.iss !== WIDGET_ISS) {
    throw new HostDecisionError(
      `Widget decide requires iss="${WIDGET_ISS}".`,
      401,
      "bad_assertion",
    );
  }
  if (
    claims.tenantId !== request.tenantId ||
    claims.spendRequestId !== request.spendRequestId
  ) {
    throw new HostDecisionError("Spend request not found.", 404, "not_found");
  }
  assertFingerprintMatch(request, claims.lockedCartFingerprint);
  if (claims.decision === "keep_looking") {
    return applyKeepLooking(request, at);
  }
  if (claims.decision !== "approved" && claims.decision !== "denied") {
    throw new HostDecisionError(
      "Widget decision must be approved, denied, or keep_looking.",
      400,
      "bad_decision",
    );
  }
  return applyDecision(
    request,
    claims.decision,
    { assertionVerified: true },
    at,
  );
}
