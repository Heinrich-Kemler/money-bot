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
import {
  mintAndVerifyWidgetClaims,
  parseWidgetDecisionBody,
} from "./widget-decision-core.ts";

export {
  mintAndVerifyWidgetClaims,
  parseWidgetDecisionBody,
  type WidgetDecisionBody,
} from "./widget-decision-core.ts";

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
