import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildApprovalClaims,
  buildWidgetApprovalClaims,
  signApprovalJwt,
  verifyApprovalAssertion,
  WIDGET_ISS,
  OOB_ISS,
} from "./assertion.ts";
import { HostDecisionError } from "./errors.ts";
import {
  decideFromVerifiedClaims,
  decideFromVerifiedWidgetClaims,
} from "./decision.ts";
import {
  applyDecision,
  applyKeepLooking,
  createPendingSpendRequest,
  isRetryOfDenied,
  lockedCartFingerprint,
  planSpendCreate,
  prepareHandoff,
  SpendError,
  toRequestSpendResult,
} from "./logic.ts";
import {
  HOST_TENANT_HEADER,
  requireHostApiToken,
  resolveWidgetTenantLookup,
  verifyHostApiBearer,
} from "./host-auth.ts";
import {
  mintAndVerifyWidgetClaims,
  parseWidgetDecisionBody,
} from "./widget-decision-core.ts";
import { grokbotWidgetForPending } from "./widget.ts";
import { AGENT_MCP_TOOLS, WIDGET_OPTIONS } from "./types.ts";

const input = {
  merchantName: "Example Shop",
  merchantUrl: "https://shop.example.co.uk",
  amount: 12.5,
  currency: "GBP" as const,
  checkoutUrl: "https://shop.example.co.uk/checkout",
  shipping: { country: "GB", postalCode: "SW1A 1AA" },
};

const SECRET = "local-dev-hmac-secret-at-least-16";
const HOST_TOKEN = "dev-only-host-api-token-change-me";

function pending() {
  return createPendingSpendRequest(input, "user-1");
}

describe("agent MCP surface (widget PR)", () => {
  it("still has exactly three tools and no decide tool", () => {
    assert.deepEqual([...AGENT_MCP_TOOLS], [
      "request_spend",
      "get_spend_status",
      "prepare_checkout_handoff",
    ]);
    assert.equal(AGENT_MCP_TOOLS.length, 3);
    assert.equal(
      AGENT_MCP_TOOLS.includes("dev_set_spend_decision" as never),
      false,
    );
    assert.equal(
      AGENT_MCP_TOOLS.includes("widget_decide" as never),
      false,
    );
    assert.equal(
      AGENT_MCP_TOOLS.includes("host_widget_decision" as never),
      false,
    );
  });
});

describe("widget payload on PENDING", () => {
  it("request_spend result includes widget + local-only approveUrl flag", () => {
    const created = pending();
    const result = toRequestSpendResult(created, {
      approveUrl:
        "http://localhost:8787/approve?spendRequestId=sr_1&tenantId=user-1",
    });
    assert.equal(result.status, "PENDING");
    assert.equal(result.approveUrlLocalSmokeOnly, true);
    assert.match(result.approveUrl, /\/approve\?/);
    assert.deepEqual(result.widget.options, [...WIDGET_OPTIONS]);
    assert.equal(result.widget.spendRequestId, created.spendRequestId);
    assert.equal(result.widget.merchantName, "Example Shop");
    assert.equal(result.widget.amount, 12.5);
    assert.equal(result.widget.currency, "GBP");
    assert.equal(result.widget.merchantDomain, "shop.example.co.uk");
    assert.equal(
      result.widget.checkoutUrl,
      "https://shop.example.co.uk/checkout",
    );
    assert.equal(
      result.widget.lockedCartFingerprint,
      lockedCartFingerprint(created.lockedCart),
    );
  });

  it("Allegro PLN request_spend surfaces PLN on the Grokbot widget", () => {
    const created = createPendingSpendRequest(
      {
        merchantName: "Allegro",
        merchantUrl: "https://allegro.pl",
        amount: 49.99,
        currency: "PLN",
        checkoutUrl: "https://allegro.pl/checkout",
      },
      "user-1",
    );
    const result = toRequestSpendResult(created, {
      approveUrl:
        "http://localhost:8787/approve?spendRequestId=sr_pln&tenantId=user-1",
    });
    assert.equal(result.widget.currency, "PLN");
    assert.equal(result.widget.merchantDomain, "allegro.pl");
    assert.equal(result.widget.checkoutUrl, "https://allegro.pl/checkout");
    const approved = applyDecision(created, "approved", {
      assertionVerified: true,
    });
    assert.equal(approved.status, "APPROVED");
    assert.equal(approved.currency, "PLN");
  });

  it("get_spend_status helper omits widget once not PENDING", () => {
    const approved = applyDecision(pending(), "approved", {
      assertionVerified: true,
    });
    assert.equal(grokbotWidgetForPending(approved), undefined);
    assert.ok(grokbotWidgetForPending(pending()));
  });
});

describe("widget-decision approved → APPROVED (assertionVerified)", () => {
  it("mints iss=grokbot-widget claims and applyDecision requires verified assertion", async () => {
    const request = pending();
    const verified = await mintAndVerifyWidgetClaims(SECRET, {
      spendRequestId: request.spendRequestId,
      tenantId: request.tenantId,
      decision: "approved",
      lockedCartFingerprint:
        request.lockedCartFingerprint ??
        lockedCartFingerprint(request.lockedCart),
    });
    assert.equal(verified.iss, WIDGET_ISS);
    assert.equal(verified.aud, "money-bot");
    assert.ok(verified.jti);
    assert.equal(verified.tenantId, "user-1");
    const approved = decideFromVerifiedWidgetClaims(request, verified);
    assert.equal(approved.status, "APPROVED");
    assert.equal(approved.decidedBy, "oob-assertion");
    const { result } = prepareHandoff(approved);
    assert.equal(result.status, "WAITING_FOR_YOU");
    assert.equal(result.checkoutUrl, "https://shop.example.co.uk/checkout");
  });
});

describe("widget-decision rejected → DENIED + cooldown", () => {
  it("denies from a verified widget assertion and starts human-deny cooldown", async () => {
    const request = pending();
    const verified = await mintAndVerifyWidgetClaims(SECRET, {
      spendRequestId: request.spendRequestId,
      tenantId: request.tenantId,
      decision: "denied",
      lockedCartFingerprint: request.lockedCartFingerprint ?? "",
    });
    const denied = decideFromVerifiedWidgetClaims(request, verified);
    assert.equal(denied.status, "DENIED");
    assert.throws(
      () => planSpendCreate([denied], input),
      (error: unknown) =>
        error instanceof SpendError && /Deny is final/.test(error.message),
    );
    assert.equal(
      isRetryOfDenied([denied], {
        merchantDomain: denied.merchantDomain,
        amount: denied.amount,
        currency: denied.currency,
        lockedCart: denied.lockedCart,
      })?.spendRequestId,
      denied.spendRequestId,
    );
  });
});

describe("widget-decision keep_looking → no deny cooldown", () => {
  it("cancels PENDING without APPROVED and without human-deny cooldown", async () => {
    const request = pending();
    const verified = await mintAndVerifyWidgetClaims(SECRET, {
      spendRequestId: request.spendRequestId,
      tenantId: request.tenantId,
      decision: "keep_looking",
      lockedCartFingerprint: request.lockedCartFingerprint ?? "",
    });
    const cancelled = decideFromVerifiedWidgetClaims(request, verified);
    assert.equal(cancelled.status, "CANCELLED");
    assert.notEqual(cancelled.status, "APPROVED");
    assert.notEqual(cancelled.status, "DENIED");
    assert.equal(cancelled.decidedBy, "grokbot-widget");
    assert.equal(
      isRetryOfDenied([cancelled], {
        merchantDomain: cancelled.merchantDomain,
        amount: cancelled.amount,
        currency: cancelled.currency,
        lockedCart: cancelled.lockedCart,
      }),
      undefined,
    );
    const plan = planSpendCreate([cancelled], input);
    assert.equal(plan.cancel, undefined);
    const again = createPendingSpendRequest(input, "user-1", plan.extras);
    assert.equal(again.status, "PENDING");
  });

  it("applyKeepLooking is the documented default (cancel without cooldown)", () => {
    const cancelled = applyKeepLooking(pending());
    assert.equal(cancelled.status, "CANCELLED");
    const plan = planSpendCreate([cancelled], input);
    assert.equal(plan.cancel, undefined);
  });
});

describe("HOST_API_TOKEN fail closed", () => {
  it("missing or invalid HOST_API_TOKEN → 401", () => {
    assert.throws(
      () => requireHostApiToken({ ENVIRONMENT: "production" }),
      (error: unknown) =>
        error instanceof HostDecisionError &&
        error.status === 401 &&
        error.code === "missing_host_api_token",
    );
    assert.throws(
      () => requireHostApiToken({ ENVIRONMENT: "development" }),
      (error: unknown) =>
        error instanceof HostDecisionError && error.status === 401,
    );
    assert.throws(
      () =>
        verifyHostApiBearer(
          new Request("http://localhost/host/widget-decision"),
          { HOST_API_TOKEN: HOST_TOKEN, ENVIRONMENT: "development" },
        ),
      (error: unknown) =>
        error instanceof HostDecisionError &&
        error.status === 401 &&
        error.code === "bad_host_token",
    );
    assert.throws(
      () =>
        verifyHostApiBearer(
          new Request("http://localhost/host/widget-decision", {
            headers: { Authorization: `Bearer ${HOST_TOKEN}` },
          }),
          { HOST_API_TOKEN: HOST_TOKEN, ENVIRONMENT: "development" },
        ),
      (error: unknown) =>
        error instanceof HostDecisionError && error.status === 401,
    );
    assert.throws(
      () =>
        verifyHostApiBearer(
          new Request("http://localhost/host/widget-decision", {
            headers: { Authorization: "Bearer host:nope-token-16chars" },
          }),
          { HOST_API_TOKEN: HOST_TOKEN, ENVIRONMENT: "development" },
        ),
      (error: unknown) =>
        error instanceof HostDecisionError &&
        error.status === 401 &&
        error.code === "bad_host_token",
    );
    assert.doesNotThrow(() =>
      verifyHostApiBearer(
        new Request("http://localhost/host/widget-decision", {
          headers: { Authorization: `Bearer host:${HOST_TOKEN}` },
        }),
        { HOST_API_TOKEN: HOST_TOKEN, ENVIRONMENT: "development" },
      ),
    );
  });
});

describe("widget fingerprint mismatch", () => {
  it("rejects a body fingerprint that does not match the locked cart", async () => {
    const request = pending();
    const verified = await mintAndVerifyWidgetClaims(SECRET, {
      spendRequestId: request.spendRequestId,
      tenantId: request.tenantId,
      decision: "approved",
      lockedCartFingerprint: "tampered|GBP|1|",
    });
    assert.throws(
      () => decideFromVerifiedWidgetClaims(request, verified),
      (error: unknown) =>
        error instanceof HostDecisionError &&
        error.code === "fingerprint_mismatch",
    );
  });
});

describe("widget claims integrity", () => {
  it("does not skip claim verification just because a host token exists", async () => {
    const request = pending();
    const claims = buildWidgetApprovalClaims({
      spendRequestId: request.spendRequestId,
      tenantId: request.tenantId,
      decision: "approved",
      lockedCartFingerprint: request.lockedCartFingerprint ?? "",
    });
    assert.equal(claims.iss, WIDGET_ISS);
    const token = await signApprovalJwt(SECRET, claims);
    const verified = await verifyApprovalAssertion(SECRET, token);
    assert.equal(verified.iss, WIDGET_ISS);
    assert.equal(verified.jti, claims.jti);
  });

  it("OOB iss still rejects keep_looking (local smoke regression)", () => {
    assert.throws(
      () =>
        buildApprovalClaims({
          spendRequestId: "sr_1",
          tenantId: "user-1",
          decision: "keep_looking",
          lockedCartFingerprint: "fp",
          iss: OOB_ISS,
        }),
      (error: unknown) =>
        error instanceof HostDecisionError && error.code === "bad_assertion",
    );
  });

  it("body tenantId / decidedBy are not authority", () => {
    const parsed = parseWidgetDecisionBody({
      spendRequestId: "sr_1",
      decision: "approved",
      lockedCartFingerprint: "fp",
      tenantId: "attacker",
      decidedBy: "human",
    });
    assert.equal(parsed.tenantId, "attacker");
    assert.equal("decidedBy" in parsed, false);

    const headerOnly = new Request("http://localhost/host/widget-decision", {
      headers: { [HOST_TENANT_HEADER]: "user-1" },
    });
    assert.equal(resolveWidgetTenantLookup(headerOnly, "user-1"), "user-1");
    assert.throws(
      () => resolveWidgetTenantLookup(headerOnly, "attacker"),
      (error: unknown) =>
        error instanceof HostDecisionError &&
        error.code === "tenant_lookup_mismatch",
    );
  });

  it("OOB decideFromVerifiedClaims still approves (approveUrl smoke regression)", async () => {
    const request = pending();
    const claims = buildApprovalClaims({
      spendRequestId: request.spendRequestId,
      tenantId: request.tenantId,
      decision: "approved",
      lockedCartFingerprint: request.lockedCartFingerprint ?? "",
    });
    assert.equal(claims.iss, OOB_ISS);
    const approved = decideFromVerifiedClaims(request, claims);
    assert.equal(approved.status, "APPROVED");
    assert.equal(approved.decidedBy, "oob-assertion");
  });
});

describe("cross-domain supersedes rejected", () => {
  it("agent supersedes of another merchantDomain is rejected", () => {
    const shopA = applyDecision(pending(), "approved", {
      assertionVerified: true,
    });
    assert.throws(
      () =>
        planSpendCreate(
          [shopA],
          {
            merchantName: "Shop B",
            merchantUrl: "https://shop-b.example.co.uk",
            amount: 99,
            currency: "EUR",
            checkoutUrl: "https://shop-b.example.co.uk/checkout",
            supersedes: shopA.spendRequestId,
          },
        ),
      (error: unknown) =>
        error instanceof SpendError &&
        /different merchantDomain/.test(error.message),
    );
  });
});
