import {
  AUTO_APPROVE_MAX,
  DENY_RETRY_WINDOW_MS,
  HANDOFF_INSTRUCTIONS,
  SPEND_TTL_MS,
  type CheckoutHandoffResult,
  type RequestSpendResult,
  type SpendDecision,
  type SpendRequest,
  type SpendStatus,
} from "./types.ts";
import type { RequestSpendInput } from "./schemas.ts";

export class SpendError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpendError";
  }
}

export function newSpendRequestId(): string {
  return `sr_${crypto.randomUUID()}`;
}

export function nowIso(at = new Date()): string {
  return at.toISOString();
}

export function expiresAtFrom(created: Date, ttlMs = SPEND_TTL_MS): string {
  return new Date(created.getTime() + ttlMs).toISOString();
}

export function isExpired(request: SpendRequest, at = new Date()): boolean {
  if (request.status === "expired") {
    return true;
  }
  const terminal = new Set<SpendStatus>([
    "denied",
    "completed",
    "failed",
    "expired",
  ]);
  if (terminal.has(request.status)) {
    return false;
  }
  return at.getTime() > Date.parse(request.expiresAt);
}

export function maybeExpire(
  request: SpendRequest,
  at = new Date(),
): SpendRequest {
  if (!isExpired(request, at)) {
    return request;
  }
  if (request.status === "expired") {
    return request;
  }
  return {
    ...request,
    status: "expired",
    updatedAt: nowIso(at),
  };
}

export function createPendingSpendRequest(
  input: RequestSpendInput,
  tenantId: string,
  at = new Date(),
): SpendRequest {
  if (AUTO_APPROVE_MAX !== 0) {
    throw new SpendError("AUTO_APPROVE_MAX must remain 0");
  }
  return {
    spendRequestId: newSpendRequestId(),
    tenantId,
    status: "pending_approval",
    merchantName: input.merchantName,
    merchantUrl: input.merchantUrl,
    amount: input.amount,
    currency: input.currency,
    checkoutUrl: input.checkoutUrl,
    description: input.description,
    lineItems: input.lineItems,
    createdAt: nowIso(at),
    updatedAt: nowIso(at),
    expiresAt: expiresAtFrom(at),
  };
}

export function toRequestSpendResult(
  request: SpendRequest,
): RequestSpendResult {
  return {
    spendRequestId: request.spendRequestId,
    status: "pending_approval",
    merchantName: request.merchantName,
    amount: request.amount,
    currency: request.currency,
    createdAt: request.createdAt,
  };
}

export function isRetryOfDenied(
  existing: SpendRequest[],
  candidate: Pick<SpendRequest, "merchantUrl" | "amount" | "currency">,
  at = new Date(),
  windowMs = DENY_RETRY_WINDOW_MS,
): SpendRequest | undefined {
  return existing.find((request) => {
    if (request.status !== "denied") {
      return false;
    }
    const decided = request.decidedAt
      ? Date.parse(request.decidedAt)
      : Date.parse(request.updatedAt);
    if (at.getTime() - decided > windowMs) {
      return false;
    }
    return (
      request.merchantUrl === candidate.merchantUrl &&
      request.amount === candidate.amount &&
      request.currency === candidate.currency
    );
  });
}

export function applyDecision(
  request: SpendRequest,
  decision: SpendDecision,
  opts: { decidedBy?: string; denyReason?: string; orderId?: string } = {},
  at = new Date(),
): SpendRequest {
  const current = maybeExpire(request, at);
  if (current.status === "denied") {
    throw new SpendError(
      "Deny is final for this spend request. Do not retry or re-submit.",
    );
  }
  if (current.status === "expired") {
    throw new SpendError("This spend request has expired.");
  }
  if (current.status !== "pending_approval") {
    throw new SpendError(
      `Cannot decide a spend request in status "${current.status}".`,
    );
  }
  if (decision === "denied") {
    return {
      ...current,
      status: "denied",
      decidedAt: nowIso(at),
      decidedBy: opts.decidedBy ?? "human",
      denyReason: opts.denyReason,
      updatedAt: nowIso(at),
    };
  }
  return {
    ...current,
    status: "approved",
    decidedAt: nowIso(at),
    decidedBy: opts.decidedBy ?? "human",
    orderId: opts.orderId ?? current.orderId,
    updatedAt: nowIso(at),
  };
}

export function prepareHandoff(
  request: SpendRequest,
  at = new Date(),
): { request: SpendRequest; result: CheckoutHandoffResult } {
  const current = maybeExpire(request, at);
  if (current.status === "denied") {
    throw new SpendError(
      "Deny is final for this spend request. Checkout handoff is not allowed.",
    );
  }
  if (current.status !== "approved" && current.status !== "checkout_ready") {
    throw new SpendError(
      `Checkout handoff requires status approved or checkout_ready (got "${current.status}").`,
    );
  }
  const checkoutUrl = current.checkoutUrl ?? current.merchantUrl;
  const next: SpendRequest = {
    ...current,
    status: "checkout_ready",
    checkoutUrl,
    updatedAt: nowIso(at),
  };
  return {
    request: next,
    result: {
      spendRequestId: next.spendRequestId,
      status: "checkout_ready",
      checkoutUrl,
      handoffInstructions: HANDOFF_INSTRUCTIONS,
    },
  };
}

export function assertSameTenant(
  request: SpendRequest,
  tenantId: string,
): void {
  if (request.tenantId !== tenantId) {
    throw new SpendError("Spend request not found.");
  }
}
