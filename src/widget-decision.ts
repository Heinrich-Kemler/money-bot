import {
  buildWidgetApprovalClaims,
  signApprovalJwt,
  verifyApprovalAssertion,
} from "./assertion.ts";
import { HostDecisionError } from "./errors.ts";
import {
  hostDecisionErrorResponse,
  decisionResponse,
} from "./host-decision.ts";
import {
  HOST_TENANT_HEADER,
  resolveWidgetTenantLookup,
  verifyHostApiBearer,
} from "./host-auth.ts";
import { spendStoreForTenant } from "./store.ts";
import { WIDGET_DECISIONS, type WidgetDecision } from "./types.ts";

export type WidgetDecisionBody = {
  spendRequestId: string;
  decision: WidgetDecision;
  lockedCartFingerprint: string;
  /** Lookup key only — rebound from the spend record into the signed claim. */
  tenantId?: string;
  /** Ignored. Never authority. */
  decidedBy?: unknown;
};

function isWidgetDecision(value: unknown): value is WidgetDecision {
  return (
    typeof value === "string" &&
    (WIDGET_DECISIONS as readonly string[]).includes(value)
  );
}

/**
 * Parse the widget body. tenantId / decidedBy are never treated as authority.
 */
export function parseWidgetDecisionBody(raw: unknown): WidgetDecisionBody {
  if (!raw || typeof raw !== "object") {
    throw new HostDecisionError(
      "Widget decision body must be a JSON object.",
      400,
      "bad_widget_body",
    );
  }
  const body = raw as Record<string, unknown>;
  const spendRequestId =
    typeof body.spendRequestId === "string" ? body.spendRequestId.trim() : "";
  const lockedCartFingerprint =
    typeof body.lockedCartFingerprint === "string"
      ? body.lockedCartFingerprint.trim()
      : "";
  if (!spendRequestId) {
    throw new HostDecisionError(
      "Widget decision requires spendRequestId.",
      400,
      "bad_widget_body",
    );
  }
  if (!isWidgetDecision(body.decision)) {
    throw new HostDecisionError(
      'Widget decision must be "approved", "denied", or "keep_looking".',
      400,
      "bad_widget_body",
    );
  }
  if (!lockedCartFingerprint) {
    throw new HostDecisionError(
      "Widget decision requires lockedCartFingerprint.",
      400,
      "bad_widget_body",
    );
  }
  const tenantId =
    typeof body.tenantId === "string" && body.tenantId.trim()
      ? body.tenantId.trim()
      : undefined;
  return {
    spendRequestId,
    decision: body.decision,
    lockedCartFingerprint,
    tenantId,
  };
}

/**
 * Mint the same claim set as OOB (iss=grokbot-widget) and verify it.
 * HOST_API_TOKEN does not skip fingerprint / jti / claim checks.
 * tenantId is taken from the spend record, not from the client body.
 */
export async function mintAndVerifyWidgetClaims(
  secret: string | undefined,
  input: {
    spendRequestId: string;
    tenantId: string;
    decision: WidgetDecision;
    lockedCartFingerprint: string;
  },
): Promise<ReturnType<typeof buildWidgetApprovalClaims>> {
  const minted = buildWidgetApprovalClaims(input);
  const token = await signApprovalJwt(secret ?? "", minted);
  return verifyApprovalAssertion(secret, token);
}

export async function handleWidgetDecision(
  request: Request,
  env: Env,
): Promise<Response> {
  try {
    verifyHostApiBearer(request, env);

    const raw: unknown = await request.json().catch(() => undefined);
    const body = parseWidgetDecisionBody(raw);
    const tenantLookup = resolveWidgetTenantLookup(request, body.tenantId);

    const store = spendStoreForTenant(env, tenantLookup);
    const loaded = await store.getForTenant(body.spendRequestId, tenantLookup);
    if (!loaded.ok) {
      throw new HostDecisionError(loaded.error, 404, "not_found");
    }
    const spend = loaded.value;

    const verified = await mintAndVerifyWidgetClaims(env.APPROVAL_HMAC_SECRET, {
      spendRequestId: spend.spendRequestId,
      tenantId: spend.tenantId,
      decision: body.decision,
      lockedCartFingerprint: body.lockedCartFingerprint,
    });

    const result = await store.applyVerifiedWidgetDecision(
      spend.spendRequestId,
      spend.tenantId,
      verified,
    );
    if (!result.ok) {
      if (/fingerprint/i.test(result.error)) {
        throw new HostDecisionError(
          result.error,
          409,
          "fingerprint_mismatch",
        );
      }
      if (/jti has already been used/i.test(result.error)) {
        throw new HostDecisionError(result.error, 409, "replayed_jti");
      }
      throw new HostDecisionError(result.error, 409, "widget_decision_failed");
    }

    const updated = result.value;
    return decisionResponse(
      {
        spendRequestId: updated.spendRequestId,
        status: updated.status,
        decidedBy: updated.decidedBy,
        decidedAt: updated.decidedAt,
        lockedCart: updated.lockedCart,
        lockedCartFingerprint: updated.lockedCartFingerprint,
        keepLooking: body.decision === "keep_looking",
        denyCooldown: updated.status === "DENIED",
        tenantHeader: HOST_TENANT_HEADER,
      },
      200,
      false,
    );
  } catch (error) {
    return hostDecisionErrorResponse(error, false);
  }
}
