import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { requireTenantId } from "./auth.ts";
import {
  applyCheckoutOutcome,
  applyDecision,
  applyTenantReauth,
  createPendingSpendRequest,
  defaultTenantConnection,
  diffLockedCart,
  editSpendCap,
  findLockedCartMismatch,
  isRetryOfDenied,
  maybeExpire,
  merchantDomainFromUrl,
  prepareHandoff,
  refreshTenantConnection,
  resumeAfterReauth,
  SpendError,
  supersedeLockedRequest,
  toRequestSpendResult,
} from "./logic.ts";
import { AGENT_MCP_TOOLS, REVOLUT_RECONSENT_MS } from "./types.ts";
import { redactPaymentSecrets } from "./sanitize.ts";
import type { SpendRequest } from "./types.ts";

const input = {
  merchantName: "Example Shop",
  merchantUrl: "https://shop.example.co.uk",
  amount: 12.5,
  currency: "GBP" as const,
  checkoutUrl: "https://shop.example.co.uk/checkout",
  shipping: { country: "GB", postalCode: "SW1A 1AA" },
};

const oob = { assertionVerified: true as const };

function pending(overrides: Partial<SpendRequest> = {}): SpendRequest {
  return {
    ...createPendingSpendRequest(input, "user-1"),
    ...overrides,
  };
}

describe("agent MCP surface", () => {
  it("lists only the three production tools", () => {
    assert.deepEqual([...AGENT_MCP_TOOLS], [
      "request_spend",
      "get_spend_status",
      "prepare_checkout_handoff",
    ]);
    assert.equal(AGENT_MCP_TOOLS.includes("report_checkout_outcome" as never), false);
    assert.equal(AGENT_MCP_TOOLS.includes("edit_spend_cap" as never), false);
    assert.equal(AGENT_MCP_TOOLS.includes("dev_set_spend_decision" as never), false);
  });
});

describe("tenant auth fail-closed", () => {
  it("rejects missing, blank, and anonymous userId", () => {
    assert.throws(
      () => requireTenantId(undefined),
      (error: unknown) =>
        error instanceof SpendError && /Unauthenticated/.test(error.message),
    );
    assert.throws(() => requireTenantId(""));
    assert.throws(() => requireTenantId("anonymous"));
    assert.equal(requireTenantId("user-99"), "user-99");
  });
});

describe("request_spend result", () => {
  it("returns PENDING with a locked-cart snapshot and no credentials", () => {
    const created = createPendingSpendRequest(input, "user-1");
    const result = toRequestSpendResult(created);
    assert.equal(result.status, "PENDING");
    assert.equal(result.merchantName, "Example Shop");
    assert.equal(result.amount, 12.5);
    assert.equal(result.currency, "GBP");
    assert.equal(result.lockedCart.merchantDomain, "shop.example.co.uk");
    assert.equal(
      result.lockedCart.checkoutUrl,
      "https://shop.example.co.uk/checkout",
    );
    assert.equal(result.lockedCart.shipping?.postalCode, "SW1A 1AA");
    assert.ok(result.spendRequestId.startsWith("sr_"));
    assert.equal("checkoutUrl" in result, false);
  });

  it("rejects non-UK/EU merchant domains", () => {
    assert.throws(
      () =>
        createPendingSpendRequest(
          {
            ...input,
            merchantUrl: "https://shop.example.com",
            checkoutUrl: "https://shop.example.com/checkout",
          },
          "user-1",
        ),
      (error: unknown) =>
        error instanceof SpendError && /UK\/EU/.test(error.message),
    );
  });

  it("rejects spendCap below amount", () => {
    assert.throws(
      () => createPendingSpendRequest({ ...input, spendCap: 10 }, "user-1"),
      (error: unknown) =>
        error instanceof SpendError && /spendCap/.test(error.message),
    );
  });
});

describe("deny is final", () => {
  it("rejects a second decision on a DENIED request", () => {
    const denied = applyDecision(pending(), "denied", oob);
    assert.equal(denied.status, "DENIED");
    assert.throws(
      () => applyDecision(denied, "approved", oob),
      (error: unknown) =>
        error instanceof SpendError && /Deny is final/.test(error.message),
    );
  });

  it("blocks retry spam including a penny change on the same domain", () => {
    const denied = applyDecision(pending(), "denied", oob);
    const exact = isRetryOfDenied([denied], {
      merchantDomain: "shop.example.co.uk",
      amount: 12.5,
      currency: "GBP",
      lockedCart: denied.lockedCart,
    });
    assert.equal(exact?.spendRequestId, denied.spendRequestId);
    const penny = isRetryOfDenied([denied], {
      merchantDomain: "shop.example.co.uk",
      amount: 12.51,
      currency: "GBP",
    });
    assert.equal(penny?.spendRequestId, denied.spendRequestId);
  });

  it("includes EXPIRED in the cooldown and normalizes www", () => {
    const expired = maybeExpire(
      pending({
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      }),
    );
    assert.equal(expired.status, "EXPIRED");
    const blocked = isRetryOfDenied([expired], {
      merchantDomain: "www.shop.example.co.uk",
      amount: 12.5,
      currency: "GBP",
    });
    assert.equal(blocked?.spendRequestId, expired.spendRequestId);
  });
});

describe("cart lock at approval", () => {
  it("normalizes merchant domain", () => {
    assert.equal(
      merchantDomainFromUrl("https://www.Shop.Example.co.uk/cart"),
      "shop.example.co.uk",
    );
  });

  it("treats amount / shipping mismatch as a new PENDING and cancels the old lock", () => {
    const approved = applyDecision(pending(), "approved", oob);
    const nextCart = {
      amount: 18,
      currency: "GBP" as const,
      merchantName: "Example Shop",
      merchantDomain: "shop.example.co.uk",
      checkoutUrl: "https://shop.example.co.uk/checkout",
      shipping: { country: "GB", postalCode: "EC1A 1BB" },
    };
    const mismatch = findLockedCartMismatch([approved], nextCart);
    assert.ok(mismatch);
    const replacement = createPendingSpendRequest(
      {
        ...input,
        amount: 18,
        shipping: nextCart.shipping,
        checkoutUrl: "https://shop.example.co.uk/checkout",
      },
      "user-1",
      {
        supersededSpendRequestId: approved.spendRequestId,
        cartDiff: mismatch.diff,
        lineageSpendRequestIds: [approved.spendRequestId],
      },
    );
    const cancelled = supersedeLockedRequest(
      approved,
      replacement.spendRequestId,
    );
    assert.equal(replacement.status, "PENDING");
    assert.equal(cancelled.status, "FAILED");
    assert.equal(cancelled.supersededBySpendRequestId, replacement.spendRequestId);
  });

  it("does not treat an identical locked cart as a mismatch", () => {
    const approved = applyDecision(pending(), "approved", oob);
    assert.equal(
      findLockedCartMismatch([approved], approved.lockedCart),
      undefined,
    );
    assert.equal(
      diffLockedCart(approved.lockedCart, approved.lockedCart),
      undefined,
    );
  });

  it("re-snapshots checkoutUrl onto the locked cart at Approve", () => {
    const approved = applyDecision(pending(), "approved", oob);
    assert.equal(approved.status, "APPROVED");
    assert.equal(
      approved.lockedCart.checkoutUrl,
      "https://shop.example.co.uk/checkout",
    );
    assert.equal(approved.decidedBy, "oob-assertion");
  });
});

describe("edit spend cap", () => {
  it("updates cap on PENDING and never auto-approves", () => {
    const next = editSpendCap(pending(), 20);
    assert.equal(next.status, "PENDING");
    assert.equal(next.spendCap, 20);
  });

  it("rejects a cap below the requested amount", () => {
    assert.throws(
      () => editSpendCap(pending(), 5),
      (error: unknown) =>
        error instanceof SpendError && /spendCap/.test(error.message),
    );
  });
});

describe("prepare_checkout_handoff", () => {
  it("requires APPROVED or WAITING_FOR_YOU", () => {
    assert.throws(
      () => prepareHandoff(pending()),
      (error: unknown) =>
        error instanceof SpendError &&
        /APPROVED or WAITING_FOR_YOU/.test(error.message),
    );
  });

  it("requires https checkoutUrl on the locked merchant domain", () => {
    const approved = applyDecision(pending(), "approved", oob);
    const { result } = prepareHandoff(approved);
    assert.equal(result.status, "WAITING_FOR_YOU");
    assert.equal(result.checkoutUrl, "https://shop.example.co.uk/checkout");
    assert.equal(result.moneyPath, true);
    assert.equal(result.merchantDomain, "shop.example.co.uk");
    assert.equal("pan" in result, false);
  });

  it("refuses a checkoutUrl swapped after the cart lock", () => {
    const approved = applyDecision(pending(), "approved", oob);
    assert.throws(
      () =>
        prepareHandoff({
          ...approved,
          checkoutUrl: "https://evil.example.co.uk/pay",
        }),
      (error: unknown) =>
        error instanceof SpendError && /swapped after the cart lock/.test(error.message),
    );
    assert.throws(
      () =>
        prepareHandoff({
          ...approved,
          checkoutUrl: "https://evil.example.co.uk/pay",
          lockedCart: {
            ...approved.lockedCart,
            checkoutUrl: "https://evil.example.co.uk/pay",
          },
        }),
      (error: unknown) =>
        error instanceof SpendError &&
        /must match locked merchantDomain/.test(error.message),
    );
  });

  it("does not fall back to merchantUrl when checkoutUrl is missing", () => {
    const approved = applyDecision(pending(), "approved", oob);
    assert.throws(
      () =>
        prepareHandoff({
          ...approved,
          checkoutUrl: undefined,
          lockedCart: { ...approved.lockedCart, checkoutUrl: "" },
        }),
      (error: unknown) =>
        error instanceof SpendError &&
        /missing checkoutUrl|checkoutUrl is required/.test(error.message),
    );
  });
});

describe("host-only completion paths", () => {
  it("WAITING_FOR_YOU → CHALLENGE → PAID is host logic, not an agent tool", () => {
    const approved = applyDecision(pending(), "approved", oob);
    const waiting = prepareHandoff(approved).request;
    const challenge = applyCheckoutOutcome(waiting, "CHALLENGE", {
      challengeKind: "revolut_3ds",
    });
    assert.equal(challenge.status, "CHALLENGE");
    const paid = applyCheckoutOutcome(challenge, "PAID", { orderId: "ord_1" });
    assert.equal(paid.status, "PAID");
  });
});

describe("expiry", () => {
  it("marks PENDING requests EXPIRED after expiresAt", () => {
    const request = pending({
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    assert.equal(maybeExpire(request).status, "EXPIRED");
  });
});

describe("out-of-band approve", () => {
  it("rejects decidedBy=agent", () => {
    assert.throws(
      () => applyDecision(pending(), "approved", { decidedBy: "agent" }),
      (error: unknown) =>
        error instanceof SpendError && /cannot Approve/.test(error.message),
    );
  });

  it("rejects raw decidedBy without a verified OOB assertion", () => {
    assert.throws(
      () => applyDecision(pending(), "approved", { decidedBy: "human" }),
      (error: unknown) =>
        error instanceof SpendError && /signed OOB assertion/.test(error.message),
    );
    assert.throws(
      () => applyDecision(pending(), "approved"),
      (error: unknown) =>
        error instanceof SpendError && /signed OOB assertion/.test(error.message),
    );
  });
});

describe("REAUTH_REQUIRED", () => {
  it("defaults v0 tenants to NOT_CONNECTED (Revolut optional)", () => {
    const tenant = defaultTenantConnection("user-1");
    assert.equal(tenant.status, "NOT_CONNECTED");
    assert.equal(pending().requiresTenantConnection, false);
  });

  it("marks CONNECTED tenants REAUTH_REQUIRED after 90 days", () => {
    const connected = refreshTenantConnection({
      tenantId: "user-1",
      status: "CONNECTED",
      revolutConnected: true,
      connectedAt: new Date(Date.now() - REVOLUT_RECONSENT_MS - 1000).toISOString(),
      consentExpiresAt: new Date(Date.now() - 1000).toISOString(),
      updatedAt: new Date().toISOString(),
    });
    assert.equal(connected.status, "REAUTH_REQUIRED");
  });

  it("pauses only v1-bound spends when the tenant needs re-consent", () => {
    const tenant = {
      ...defaultTenantConnection("user-1"),
      status: "REAUTH_REQUIRED" as const,
      revolutConnected: true,
      consentExpiresAt: new Date(Date.now() - 1000).toISOString(),
    };
    const v0 = applyTenantReauth(pending(), tenant);
    assert.equal(v0.status, "PENDING");
    const v1 = applyTenantReauth(
      { ...pending(), requiresTenantConnection: true },
      tenant,
    );
    assert.equal(v1.status, "REAUTH_REQUIRED");
    assert.throws(
      () => resumeAfterReauth(v1, tenant),
      (error: unknown) =>
        error instanceof SpendError && /wizard/.test(error.message),
    );
  });
});

describe("sanitizer", () => {
  it("strips Luhn-valid PAN fields but keeps order ids", () => {
    const redacted = redactPaymentSecrets({
      status: "WAITING_FOR_YOU",
      pan: "4111111111111111",
      cvc: "123",
      orderId: "123456789012345",
      note: "card 4111111111111111 leaked",
    });
    assert.equal("pan" in redacted, false);
    assert.equal("cvc" in redacted, false);
    assert.equal(redacted.orderId, "123456789012345");
    assert.match(redacted.note, /REDACTED/);
  });
});
