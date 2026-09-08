import {
  AUTO_APPROVE_MAX,
  CHALLENGE_INSTRUCTIONS,
  CHALLENGE_MINUTES,
  DENY_RETRY_WINDOW_MS,
  HANDOFF_INSTRUCTIONS,
  SPEND_TTL_MS,
  type CartDiff,
  type CartDiffField,
  type ChallengeInfo,
  type CheckoutHandoffResult,
  type CheckoutOutcome,
  type LockedCart,
  type RequestSpendResult,
  type Shipping,
  type SpendDecision,
  type SpendRequest,
  type SpendStatus,
  type TenantConnection,
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

export function merchantDomainFromUrl(url: string): string {
  const hostname = new URL(url).hostname.toLowerCase();
  return hostname.startsWith("www.") ? hostname.slice(4) : hostname;
}

export function shippingKey(shipping?: Shipping): string {
  if (!shipping) {
    return "";
  }
  return [
    shipping.name ?? "",
    shipping.line1 ?? "",
    shipping.city ?? "",
    shipping.postalCode ?? "",
    shipping.country ?? "",
  ].join("|");
}

export function cartFromInput(input: RequestSpendInput): LockedCart {
  return {
    amount: input.amount,
    currency: input.currency,
    merchantName: input.merchantName,
    merchantDomain: merchantDomainFromUrl(input.merchantUrl),
    shipping: input.shipping,
  };
}

export function cartFromRequest(request: SpendRequest): LockedCart {
  return request.lockedCart;
}

export function diffLockedCart(
  previous: LockedCart,
  next: LockedCart,
): CartDiff | undefined {
  const fields: CartDiffField[] = [];
  if (previous.amount !== next.amount) {
    fields.push("amount");
  }
  if (previous.currency !== next.currency) {
    fields.push("currency");
  }
  if (previous.merchantName !== next.merchantName) {
    fields.push("merchantName");
  }
  if (previous.merchantDomain !== next.merchantDomain) {
    fields.push("merchantDomain");
  }
  if (shippingKey(previous.shipping) !== shippingKey(next.shipping)) {
    fields.push("shipping");
  }
  if (fields.length === 0) {
    return undefined;
  }
  return { fields, previous, next };
}

export function isExpired(request: SpendRequest, at = new Date()): boolean {
  if (request.status === "EXPIRED") {
    return true;
  }
  // Deny/expire are terminal from PENDING only.
  if (request.status !== "PENDING") {
    return false;
  }
  return at.getTime() > Date.parse(request.expiresAt);
}

export function maybeExpire(
  request: SpendRequest,
  at = new Date(),
): SpendRequest {
  if (!isExpired(request, at) || request.status === "EXPIRED") {
    return request;
  }
  return {
    ...request,
    status: "EXPIRED",
    updatedAt: nowIso(at),
  };
}

export function createPendingSpendRequest(
  input: RequestSpendInput,
  tenantId: string,
  extras: {
    supersededSpendRequestId?: string;
    cartDiff?: CartDiff;
  } = {},
  at = new Date(),
): SpendRequest {
  if (AUTO_APPROVE_MAX !== 0) {
    throw new SpendError("AUTO_APPROVE_MAX must remain 0");
  }
  const lockedCart = cartFromInput(input);
  return {
    spendRequestId: newSpendRequestId(),
    tenantId,
    status: "PENDING",
    merchantName: input.merchantName,
    merchantUrl: input.merchantUrl,
    merchantDomain: lockedCart.merchantDomain,
    amount: input.amount,
    currency: input.currency,
    shipping: input.shipping,
    lockedCart,
    spendCap: input.spendCap,
    checkoutUrl: input.checkoutUrl,
    description: input.description,
    lineItems: input.lineItems,
    cartDiff: extras.cartDiff,
    supersededSpendRequestId: extras.supersededSpendRequestId,
    requiresTenantConnection: false,
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
    status: "PENDING",
    merchantName: request.merchantName,
    amount: request.amount,
    currency: request.currency,
    createdAt: request.createdAt,
    lockedCart: request.lockedCart,
    supersededSpendRequestId: request.supersededSpendRequestId,
    cartDiff: request.cartDiff,
  };
}

export function isRetryOfDenied(
  existing: SpendRequest[],
  candidate: Pick<SpendRequest, "merchantUrl" | "amount" | "currency">,
  at = new Date(),
  windowMs = DENY_RETRY_WINDOW_MS,
): SpendRequest | undefined {
  return existing.find((request) => {
    if (request.status !== "DENIED") {
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

const LOCKED_STATUSES: SpendStatus[] = [
  "APPROVED",
  "WAITING_FOR_YOU",
  "CHALLENGE",
];

export function findLockedCartMismatch(
  existing: SpendRequest[],
  nextCart: LockedCart,
): { request: SpendRequest; diff: CartDiff } | undefined {
  const locked = existing
    .filter((request) => LOCKED_STATUSES.includes(request.status))
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];
  if (!locked) {
    return undefined;
  }
  const diff = diffLockedCart(locked.lockedCart, nextCart);
  if (!diff) {
    return undefined;
  }
  return { request: locked, diff };
}

export function applyDecision(
  request: SpendRequest,
  decision: SpendDecision,
  opts: { decidedBy?: string; denyReason?: string; orderId?: string } = {},
  at = new Date(),
): SpendRequest {
  const current = maybeExpire(request, at);
  if (current.status === "DENIED") {
    throw new SpendError(
      "Deny is final for this spend request. Do not retry or re-submit.",
    );
  }
  if (current.status === "EXPIRED") {
    throw new SpendError("This spend request has expired.");
  }
  if (current.status === "REAUTH_REQUIRED") {
    throw new SpendError(
      "Tenant re-authorisation is required (90-day Revolut Business re-consent). Complete the connect wizard; the agent cannot Approve.",
    );
  }
  if (opts.decidedBy === "agent") {
    throw new SpendError(
      "The agent cannot Approve. Approval must be out-of-band (phone passkey/PWA). A chat button may only initiate that flow.",
    );
  }
  if (current.status !== "PENDING") {
    throw new SpendError(
      `Cannot decide a spend request in status "${current.status}".`,
    );
  }
  if (decision === "denied") {
    return {
      ...current,
      status: "DENIED",
      decidedAt: nowIso(at),
      decidedBy: opts.decidedBy ?? "human",
      denyReason: opts.denyReason,
      updatedAt: nowIso(at),
    };
  }
  return {
    ...current,
    status: "APPROVED",
    lockedCart: current.lockedCart,
    decidedAt: nowIso(at),
    decidedBy: opts.decidedBy ?? "human",
    orderId: opts.orderId ?? current.orderId,
    updatedAt: nowIso(at),
  };
}

export function editSpendCap(
  request: SpendRequest,
  spendCap: number,
  at = new Date(),
): SpendRequest {
  const current = maybeExpire(request, at);
  if (current.status !== "PENDING") {
    throw new SpendError(
      "Spend cap can only be edited while PENDING. Changing the cap never grants approval.",
    );
  }
  return {
    ...current,
    spendCap,
    updatedAt: nowIso(at),
  };
}

export function prepareHandoff(
  request: SpendRequest,
  at = new Date(),
): { request: SpendRequest; result: CheckoutHandoffResult } {
  const current = maybeExpire(request, at);
  if (current.status === "REAUTH_REQUIRED") {
    throw new SpendError(
      "Tenant re-authorisation is required before checkout handoff. Revolut Business uses a 90-day re-consent wizard (no public OAuth).",
    );
  }
  if (current.status === "DENIED") {
    throw new SpendError(
      "Deny is final for this spend request. Checkout handoff is not allowed.",
    );
  }
  if (current.status === "CHALLENGE") {
    const checkoutUrl = current.checkoutUrl ?? current.merchantUrl;
    return {
      request: current,
      result: {
        spendRequestId: current.spendRequestId,
        status: "CHALLENGE",
        checkoutUrl,
        handoffInstructions: CHALLENGE_INSTRUCTIONS,
      },
    };
  }
  if (current.status !== "APPROVED" && current.status !== "WAITING_FOR_YOU") {
    throw new SpendError(
      `Checkout handoff requires status APPROVED or WAITING_FOR_YOU (got "${current.status}").`,
    );
  }
  const checkoutUrl = current.checkoutUrl ?? current.merchantUrl;
  const next: SpendRequest = {
    ...current,
    status: "WAITING_FOR_YOU",
    checkoutUrl,
    updatedAt: nowIso(at),
  };
  return {
    request: next,
    result: {
      spendRequestId: next.spendRequestId,
      status: "WAITING_FOR_YOU",
      checkoutUrl,
      handoffInstructions: HANDOFF_INSTRUCTIONS,
    },
  };
}

function challengeFromKind(
  kind: ChallengeInfo["kind"],
  at: Date,
): ChallengeInfo {
  return {
    kind,
    startedAt: nowIso(at),
    expectedMinutes: CHALLENGE_MINUTES[kind],
    note:
      kind === "amex_safekey"
        ? "Amex SafeKey typically takes about 4 minutes. Hand the screen to the human."
        : kind === "revolut_3ds"
          ? "Revolut 3DS typically takes about 5 minutes. Hand the screen to the human."
          : "SCA/3DS is still required in the UK (~£25) and EU (~€30). Hand the screen to the human.",
  };
}

export function applyCheckoutOutcome(
  request: SpendRequest,
  outcome: CheckoutOutcome,
  opts: { challengeKind?: ChallengeInfo["kind"]; orderId?: string } = {},
  at = new Date(),
): SpendRequest {
  const current = maybeExpire(request, at);
  if (current.status === "WAITING_FOR_YOU") {
    if (outcome === "CHALLENGE") {
      return {
        ...current,
        status: "CHALLENGE",
        challenge: challengeFromKind(opts.challengeKind ?? "sca", at),
        orderId: opts.orderId ?? current.orderId,
        updatedAt: nowIso(at),
      };
    }
    return {
      ...current,
      status: outcome,
      orderId: opts.orderId ?? current.orderId,
      updatedAt: nowIso(at),
    };
  }
  if (current.status === "CHALLENGE") {
    if (outcome === "CHALLENGE") {
      return current;
    }
    return {
      ...current,
      status: outcome,
      orderId: opts.orderId ?? current.orderId,
      updatedAt: nowIso(at),
    };
  }
  throw new SpendError(
    `Cannot report ${outcome} from status "${current.status}". ` +
      "Completion paths start from WAITING_FOR_YOU (or CHALLENGE → PAID/FAILED).",
  );
}

export function assertSameTenant(
  request: SpendRequest,
  tenantId: string,
): void {
  if (request.tenantId !== tenantId) {
    throw new SpendError("Spend request not found.");
  }
}

export function defaultTenantConnection(
  tenantId: string,
  at = new Date(),
): TenantConnection {
  return {
    tenantId,
    status: "NOT_CONNECTED",
    revolutConnected: false,
    updatedAt: nowIso(at),
  };
}

export function refreshTenantConnection(
  connection: TenantConnection,
  at = new Date(),
): TenantConnection {
  if (connection.status === "NOT_CONNECTED" || !connection.consentExpiresAt) {
    return connection;
  }
  if (at.getTime() > Date.parse(connection.consentExpiresAt)) {
    return {
      ...connection,
      status: "REAUTH_REQUIRED",
      updatedAt: nowIso(at),
    };
  }
  return connection;
}

const REAUTH_PAUSEABLE: SpendStatus[] = [
  "PENDING",
  "APPROVED",
  "WAITING_FOR_YOU",
  "CHALLENGE",
];

/** Pause a v1-bound spend when the tenant's 90-day consent lapses. v0 handoff is not paused. */
export function applyTenantReauth(
  request: SpendRequest,
  connection: TenantConnection,
  at = new Date(),
): SpendRequest {
  const tenant = refreshTenantConnection(connection, at);
  if (
    !request.requiresTenantConnection ||
    tenant.status !== "REAUTH_REQUIRED" ||
    !REAUTH_PAUSEABLE.includes(request.status)
  ) {
    return request;
  }
  return {
    ...request,
    status: "REAUTH_REQUIRED",
    statusBeforeReauth: request.status,
    updatedAt: nowIso(at),
  };
}

export function resumeAfterReauth(
  request: SpendRequest,
  connection: TenantConnection,
  at = new Date(),
): SpendRequest {
  const tenant = refreshTenantConnection(connection, at);
  if (request.status !== "REAUTH_REQUIRED") {
    throw new SpendError("Spend request is not waiting for re-authorisation.");
  }
  if (tenant.status === "REAUTH_REQUIRED") {
    throw new SpendError(
      "Complete the Revolut Business connect wizard (cert + client_id + JWT + Enable access). There is no public OAuth or one-tap connect.",
    );
  }
  const previous = request.statusBeforeReauth ?? "PENDING";
  if (previous === "REAUTH_REQUIRED") {
    return { ...request, status: "PENDING", updatedAt: nowIso(at) };
  }
  return {
    ...request,
    status: previous,
    statusBeforeReauth: undefined,
    updatedAt: nowIso(at),
  };
}
