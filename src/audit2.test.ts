import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { requireTenantId } from "./auth.ts";
import { TestAuthConfigError } from "./errors.ts";
import {
  applyDecision,
  createPendingSpendRequest,
  findLockedCartMismatch,
  isRetryOfDenied,
  maybeExpire,
  planSpendCreate,
  prepareHandoff,
  SpendError,
  supersedeLockedRequest,
} from "./logic.ts";
import { tenantDurableObjectName } from "./auth.ts";
import { authorizeMcpSession } from "./mcp-auth.ts";
import {
  assertTestAuthAllowedForEnv,
  isTestAuthEnabled,
  resolveTestUserId,
} from "./test-auth.ts";
import type { LockedCart, SpendRequest } from "./types.ts";

const shopA = {
  merchantName: "Shop A",
  merchantUrl: "https://shop-a.example.co.uk",
  amount: 10,
  currency: "GBP" as const,
  checkoutUrl: "https://shop-a.example.co.uk/checkout",
  shipping: { country: "GB", postalCode: "SW1A 1AA" },
};

const shopB = {
  merchantName: "Shop B",
  merchantUrl: "https://shop-b.example.co.uk",
  amount: 99,
  currency: "EUR" as const,
  checkoutUrl: "https://shop-b.example.co.uk/checkout",
  shipping: { country: "DE", postalCode: "10115" },
};

const oob = { assertionVerified: true as const };

function approvedA(): SpendRequest {
  return applyDecision(createPendingSpendRequest(shopA, "user-1"), "approved", oob);
}

function cartB(): LockedCart {
  return createPendingSpendRequest(shopB, "user-1").lockedCart;
}

describe("N-2 supersede scope (same merchantDomain only)", () => {
  it("same-domain cart change cancels the prior APPROVED lock", () => {
    const approved = approvedA();
    const next = {
      ...shopA,
      amount: 18,
      shipping: { country: "GB", postalCode: "EC1A 1BB" },
    };
    const plan = planSpendCreate([approved], next);
    assert.equal(plan.cancel?.spendRequestId, approved.spendRequestId);
    assert.ok(plan.extras.cartDiff);
    const replacement = createPendingSpendRequest(next, "user-1", plan.extras);
    const cancelled = supersedeLockedRequest(
      plan.cancel!,
      replacement.spendRequestId,
    );
    assert.equal(cancelled.status, "FAILED");
    assert.equal(cancelled.supersededBySpendRequestId, replacement.spendRequestId);
    assert.equal(replacement.supersededSpendRequestId, approved.spendRequestId);
  });

  it("different-domain request does not cancel another shop's APPROVED lock", () => {
    const approved = approvedA();
    const waiting = prepareHandoff(approved).request;
    assert.equal(
      findLockedCartMismatch([waiting], cartB()),
      undefined,
    );
    const plan = planSpendCreate([waiting], shopB);
    assert.equal(plan.cancel, undefined);
    assert.equal(plan.extras.supersededSpendRequestId, undefined);
    const created = createPendingSpendRequest(shopB, "user-1", plan.extras);
    assert.equal(created.status, "PENDING");
    assert.equal(waiting.status, "WAITING_FOR_YOU");
  });

  it("explicit supersedes can cancel a named lock at another merchant", () => {
    const approved = approvedA();
    const plan = planSpendCreate(
      [approved],
      { ...shopB, supersedes: approved.spendRequestId },
    );
    assert.equal(plan.cancel?.spendRequestId, approved.spendRequestId);
    assert.ok(plan.extras.cartDiff?.fields.includes("merchantDomain"));
  });

  it("rejects an explicit supersedes that is not a locked spend", () => {
    const pending = createPendingSpendRequest(shopA, "user-1");
    assert.throws(
      () =>
        planSpendCreate(
          [pending],
          { ...shopB, supersedes: pending.spendRequestId },
        ),
      (error: unknown) =>
        error instanceof SpendError && /not a locked spend/.test(error.message),
    );
  });
});

describe("N-3 ALLOW_TEST_AUTH production lockout", () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

  it("production wrangler.toml must not enable ALLOW_TEST_AUTH", () => {
    const toml = readFileSync(join(repoRoot, "wrangler.toml"), "utf8");
    assert.doesNotMatch(toml, /ALLOW_TEST_AUTH\s*=/);
    assert.match(toml, /ENVIRONMENT\s*=\s*"production"/);
  });

  it("ALLOW_TEST_AUTH=true is rejected when ENVIRONMENT is production (or unset)", () => {
    assert.throws(
      () => assertTestAuthAllowedForEnv({ ALLOW_TEST_AUTH: "true" }),
      (error: unknown) => error instanceof TestAuthConfigError,
    );
    assert.throws(
      () =>
        assertTestAuthAllowedForEnv({
          ALLOW_TEST_AUTH: "true",
          ENVIRONMENT: "production",
        }),
      (error: unknown) => error instanceof TestAuthConfigError,
    );
    const request = new Request("http://localhost/mcp", {
      headers: { Authorization: "Bearer test:attacker" },
    });
    assert.equal(
      resolveTestUserId(request, {
        ALLOW_TEST_AUTH: "true",
        ENVIRONMENT: "production",
      }),
      undefined,
    );
    assert.equal(
      isTestAuthEnabled({ ALLOW_TEST_AUTH: "true", ENVIRONMENT: "production" }),
      false,
    );
  });

  it("ALLOW_TEST_AUTH is inert on a non-loopback host even in development", () => {
    const request = new Request("https://money-bot.example.workers.dev/mcp", {
      headers: { Authorization: "Bearer test:attacker" },
    });
    assert.equal(
      resolveTestUserId(request, {
        ALLOW_TEST_AUTH: "true",
        ENVIRONMENT: "development",
        PUBLIC_BASE_URL: "https://money-bot.example.workers.dev",
      }),
      undefined,
    );
  });

  it("honors test auth only on loopback + ENVIRONMENT=development", () => {
    const request = new Request("http://127.0.0.1:8787/mcp", {
      headers: { Authorization: "Bearer test:local-user" },
    });
    assert.equal(
      resolveTestUserId(request, {
        ALLOW_TEST_AUTH: "true",
        ENVIRONMENT: "development",
        PUBLIC_BASE_URL: "http://localhost:8787",
      }),
      "local-user",
    );
  });
});

describe("N-4 (P2) unauthenticated MCP does not allocate tenant DOs", () => {
  it("initialize / tools/list without auth is 401 and does not touch tenant storage", () => {
    let allocated = false;
    const env = {
      ENVIRONMENT: "production",
      SPEND_STORE: {
        idFromName() {
          allocated = true;
          throw new Error("tenant DO must not be allocated");
        },
      },
    };
    for (const body of [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    ]) {
      const result = authorizeMcpSession(
        new Request("https://money-bot.example/mcp", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
        env,
      );
      assert.equal(result.ok, false);
      if (result.ok) {
        throw new Error("expected deny");
      }
      assert.equal(result.status, 401);
      assert.equal(result.allocatesTenantStore, false);
      assert.equal(result.allocatesMcpSession, false);
    }
    assert.equal(allocated, false);
    assert.throws(
      () => requireTenantId(undefined),
      (error: unknown) =>
        error instanceof SpendError && /Unauthenticated/.test(error.message),
    );
    assert.throws(
      () => tenantDurableObjectName(""),
      (error: unknown) =>
        error instanceof SpendError && /Unauthenticated/.test(error.message),
    );
    assert.throws(
      () => tenantDurableObjectName("anonymous"),
      (error: unknown) =>
        error instanceof SpendError && /Unauthenticated/.test(error.message),
    );
  });

  it("production ALLOW_TEST_AUTH misconfig is 500 and still does not allocate", () => {
    const result = authorizeMcpSession(
      new Request("https://money-bot.example/mcp", {
        headers: { Authorization: "Bearer test:anyone" },
      }),
      { ALLOW_TEST_AUTH: "true", ENVIRONMENT: "production" },
    );
    assert.equal(result.ok, false);
    if (result.ok) {
      throw new Error("expected deny");
    }
    assert.equal(result.status, 500);
    assert.equal(result.error, "allow_test_auth_forbidden_in_production");
    assert.equal(result.allocatesTenantStore, false);
  });
});

describe("N-5 EXPIRED does not apply human-deny cooldown", () => {
  it("a timed-out PENDING does not block a new same-cart request", () => {
    const expired = maybeExpire({
      ...createPendingSpendRequest(shopA, "user-1"),
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    assert.equal(expired.status, "EXPIRED");
    assert.equal(
      isRetryOfDenied([expired], {
        merchantDomain: expired.merchantDomain,
        amount: expired.amount,
        currency: expired.currency,
        lockedCart: expired.lockedCart,
      }),
      undefined,
    );
    const plan = planSpendCreate([expired], shopA);
    assert.equal(plan.cancel, undefined);
    const again = createPendingSpendRequest(shopA, "user-1", plan.extras);
    assert.equal(again.status, "PENDING");
  });

  it("a human DENIED still blocks the same domain / nearby amount", () => {
    const denied = applyDecision(
      createPendingSpendRequest(shopA, "user-1"),
      "denied",
      oob,
    );
    assert.throws(
      () => planSpendCreate([denied], shopA),
      (error: unknown) =>
        error instanceof SpendError && /Deny is final/.test(error.message),
    );
  });
});
