import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyDecision,
  createPendingSpendRequest,
  isRetryOfDenied,
  maybeExpire,
  prepareHandoff,
  SpendError,
  toRequestSpendResult,
} from "./logic.ts";
import { redactPaymentSecrets } from "./sanitize.ts";
import type { SpendRequest } from "./types.ts";

const input = {
  merchantName: "Example Shop",
  merchantUrl: "https://shop.example",
  amount: 12.5,
  currency: "GBP" as const,
  checkoutUrl: "https://shop.example/checkout",
};

function pending(overrides: Partial<SpendRequest> = {}): SpendRequest {
  return {
    ...createPendingSpendRequest(input, "user-1"),
    ...overrides,
  };
}

describe("request_spend result", () => {
  it("returns pending_approval without credentials", () => {
    const created = createPendingSpendRequest(input, "user-1");
    const result = toRequestSpendResult(created);
    assert.equal(result.status, "pending_approval");
    assert.equal(result.merchantName, "Example Shop");
    assert.equal(result.amount, 12.5);
    assert.equal(result.currency, "GBP");
    assert.ok(result.spendRequestId.startsWith("sr_"));
    assert.equal("checkoutUrl" in result, false);
  });
});

describe("deny is final", () => {
  it("rejects a second decision on a denied request", () => {
    const denied = applyDecision(pending(), "denied", {
      decidedBy: "human",
      denyReason: "too expensive",
    });
    assert.equal(denied.status, "denied");
    assert.throws(
      () => applyDecision(denied, "approved"),
      (error: unknown) =>
        error instanceof SpendError && /Deny is final/.test(error.message),
    );
  });

  it("blocks retry spam for the same merchant, amount, and currency", () => {
    const denied = applyDecision(pending(), "denied", { decidedBy: "human" });
    const retry = isRetryOfDenied([denied], {
      merchantUrl: input.merchantUrl,
      amount: input.amount,
      currency: input.currency,
    });
    assert.equal(retry?.spendRequestId, denied.spendRequestId);
  });
});

describe("prepare_checkout_handoff", () => {
  it("requires approved or checkout_ready", () => {
    assert.throws(
      () => prepareHandoff(pending()),
      (error: unknown) =>
        error instanceof SpendError && /approved or checkout_ready/.test(error.message),
    );
  });

  it("returns checkout URL and human handoff instructions only", () => {
    const approved = applyDecision(pending(), "approved", { decidedBy: "human" });
    const { result } = prepareHandoff(approved);
    assert.equal(result.status, "checkout_ready");
    assert.equal(result.checkoutUrl, "https://shop.example/checkout");
    assert.match(result.handoffInstructions, /Apple Pay/);
    assert.equal("pan" in result, false);
    assert.equal("cvc" in result, false);
  });
});

describe("expiry", () => {
  it("marks pending requests expired after expiresAt", () => {
    const request = pending({
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    assert.equal(maybeExpire(request).status, "expired");
  });
});

describe("sanitizer", () => {
  it("strips PAN-like fields from tool payloads", () => {
    const redacted = redactPaymentSecrets({
      status: "checkout_ready",
      pan: "4111111111111111",
      cvc: "123",
      note: "card 4111111111111111 leaked",
    });
    assert.equal("pan" in redacted, false);
    assert.equal("cvc" in redacted, false);
    assert.match(redacted.note, /REDACTED/);
  });
});
