import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildApprovalClaims,
  extractAssertionToken,
  signApprovalHmac,
  signApprovalJwt,
  verifyApprovalAssertion,
} from "./assertion.ts";
import { HostDecisionError } from "./errors.ts";
import {
  assertFingerprintMatch,
  assertJtiUnused,
  decideFromVerifiedClaims,
} from "./decision.ts";
import {
  applyDecision,
  createPendingSpendRequest,
  lockedCartFingerprint,
  SpendError,
  toRequestSpendResult,
} from "./logic.ts";
import { resolveTestUserId } from "./test-auth.ts";
import { requireTenantId } from "./auth.ts";
import { AGENT_MCP_TOOLS } from "./types.ts";

const input = {
  merchantName: "Example Shop",
  merchantUrl: "https://shop.example.co.uk",
  amount: 12.5,
  currency: "GBP" as const,
  checkoutUrl: "https://shop.example.co.uk/checkout",
  shipping: { country: "GB", postalCode: "SW1A 1AA" },
};

const SECRET = "local-dev-hmac-secret-at-least-16";

function pending() {
  return createPendingSpendRequest(input, "user-1");
}

async function signed(
  request = pending(),
  overrides: Partial<Parameters<typeof buildApprovalClaims>[0]> = {},
  format: "jwt" | "hmac" = "jwt",
) {
  const claims = buildApprovalClaims({
    spendRequestId: request.spendRequestId,
    tenantId: request.tenantId,
    decision: "approved",
    lockedCartFingerprint:
      request.lockedCartFingerprint ?? lockedCartFingerprint(request.lockedCart),
    ...overrides,
  });
  const token =
    format === "jwt"
      ? await signApprovalJwt(SECRET, claims)
      : await signApprovalHmac(SECRET, claims);
  return { request, claims, token };
}

describe("agent MCP surface", () => {
  it("still has no decide / outcome / cap tools", () => {
    assert.deepEqual([...AGENT_MCP_TOOLS], [
      "request_spend",
      "get_spend_status",
      "prepare_checkout_handoff",
    ]);
    assert.equal(
      AGENT_MCP_TOOLS.includes("dev_set_spend_decision" as never),
      false,
    );
    assert.equal(
      AGENT_MCP_TOOLS.includes("report_checkout_outcome" as never),
      false,
    );
  });
});

describe("approveUrl on PENDING", () => {
  it("is included on request_spend results", () => {
    const created = pending();
    const result = toRequestSpendResult(created, {
      approveUrl:
        "http://localhost:8787/approve?spendRequestId=sr_1&tenantId=user-1",
    });
    assert.equal(result.status, "PENDING");
    assert.match(result.approveUrl, /\/approve\?/);
    assert.match(result.approveUrl, /spendRequestId=/);
  });
});

describe("verified assertion → APPROVED / DENIED", () => {
  it("approves from a verified JWT and re-snapshots the locked cart", async () => {
    const { request, claims } = await signed();
    const verified = await verifyApprovalAssertion(
      SECRET,
      await signApprovalJwt(SECRET, claims),
    );
    const approved = decideFromVerifiedClaims(request, verified);
    assert.equal(approved.status, "APPROVED");
    assert.equal(approved.decidedBy, "oob-assertion");
    assert.equal(
      approved.lockedCart.checkoutUrl,
      "https://shop.example.co.uk/checkout",
    );
    assert.equal(
      approved.lockedCartFingerprint,
      lockedCartFingerprint(approved.lockedCart),
    );
  });

  it("denies from a verified compact HMAC", async () => {
    const request = pending();
    const { claims, token } = await signed(
      request,
      { decision: "denied" },
      "hmac",
    );
    const verified = await verifyApprovalAssertion(SECRET, token);
    assert.equal(verified.decision, "denied");
    const denied = decideFromVerifiedClaims(request, claims);
    assert.equal(denied.status, "DENIED");
    assert.equal(denied.decidedBy, "oob-assertion");
  });
});

describe("assertion verification rejects bad tokens", () => {
  it("rejects a missing signature / empty token", async () => {
    await assert.rejects(
      () => verifyApprovalAssertion(SECRET, undefined),
      (error: unknown) =>
        error instanceof HostDecisionError && error.code === "missing_assertion",
    );
    await assert.rejects(
      () => verifyApprovalAssertion(SECRET, "   "),
      (error: unknown) =>
        error instanceof HostDecisionError && error.code === "missing_assertion",
    );
  });

  it("rejects a missing or short HMAC secret", async () => {
    const { token } = await signed();
    await assert.rejects(
      () => verifyApprovalAssertion(undefined, token),
      (error: unknown) =>
        error instanceof HostDecisionError &&
        error.code === "missing_approval_secret",
    );
    await assert.rejects(
      () => verifyApprovalAssertion("short", token),
      (error: unknown) =>
        error instanceof HostDecisionError &&
        error.code === "missing_approval_secret",
    );
  });

  it("rejects a tampered JWT signature", async () => {
    const { token } = await signed();
    const bad = `${token.slice(0, -4)}aaaa`;
    await assert.rejects(
      () => verifyApprovalAssertion(SECRET, bad),
      (error: unknown) =>
        error instanceof HostDecisionError && error.code === "bad_signature",
    );
  });

  it("rejects an expired assertion", async () => {
    const request = pending();
    const claims = buildApprovalClaims(
      {
        spendRequestId: request.spendRequestId,
        tenantId: request.tenantId,
        decision: "approved",
        lockedCartFingerprint: request.lockedCartFingerprint ?? "",
        ttlSeconds: 60,
      },
      new Date(Date.now() - 5 * 60 * 1000),
    );
    const token = await signApprovalJwt(SECRET, claims);
    await assert.rejects(
      () => verifyApprovalAssertion(SECRET, token),
      (error: unknown) =>
        error instanceof HostDecisionError && error.code === "expired_assertion",
    );
  });

  it("never treats unsigned JSON body fields as a decision", async () => {
    const request = new Request("http://localhost/host/spend-decision", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        tenantId: "attacker",
        decidedBy: "human",
        decision: "approved",
        spendRequestId: "sr_x",
      }),
    });
    const token = await extractAssertionToken(request);
    assert.equal(token, undefined);
    await assert.rejects(
      () => verifyApprovalAssertion(SECRET, token),
      (error: unknown) =>
        error instanceof HostDecisionError && error.code === "missing_assertion",
    );
  });
});

describe("fingerprint and replay", () => {
  it("rejects a fingerprint mismatch", async () => {
    const request = pending();
    const { claims } = await signed(request, {
      lockedCartFingerprint: "tampered|GBP|1|",
    });
    assert.throws(
      () => decideFromVerifiedClaims(request, claims),
      (error: unknown) =>
        error instanceof HostDecisionError &&
        error.code === "fingerprint_mismatch",
    );
    assert.throws(
      () => assertFingerprintMatch(request, "other-fingerprint"),
      (error: unknown) =>
        error instanceof HostDecisionError &&
        error.code === "fingerprint_mismatch",
    );
  });

  it("rejects a replayed jti", () => {
    assert.throws(
      () => assertJtiUnused({ usedAt: new Date().toISOString() }),
      (error: unknown) =>
        error instanceof HostDecisionError && error.code === "replayed_jti",
    );
    assert.doesNotThrow(() => assertJtiUnused(undefined));
  });

  it("still refuses applyDecision without assertionVerified", () => {
    assert.throws(
      () => applyDecision(pending(), "approved", { decidedBy: "human" }),
      (error: unknown) =>
        error instanceof SpendError && /signed OOB assertion/.test(error.message),
    );
  });
});

describe("production path fails closed without userId", () => {
  it("does not honor test: bearer tokens when ALLOW_TEST_AUTH is unset", () => {
    const request = new Request("http://localhost/mcp", {
      headers: { Authorization: "Bearer test:user-99" },
    });
    assert.equal(resolveTestUserId(request, {}), undefined);
    assert.equal(resolveTestUserId(request, { ALLOW_TEST_AUTH: "false" }), undefined);
    assert.throws(
      () => requireTenantId(resolveTestUserId(request, {})),
      (error: unknown) =>
        error instanceof SpendError && /Unauthenticated/.test(error.message),
    );
  });

  it("populates userId only when ALLOW_TEST_AUTH=true on local development", () => {
    const request = new Request("http://localhost/mcp", {
      headers: { Authorization: "Bearer test:local-user" },
    });
    const local = { ALLOW_TEST_AUTH: "true", ENVIRONMENT: "development" };
    assert.equal(resolveTestUserId(request, local), "local-user");
    assert.equal(
      resolveTestUserId(
        new Request("http://localhost/mcp", {
          headers: { Authorization: "Bearer test:anonymous" },
        }),
        local,
      ),
      undefined,
    );
  });
});
