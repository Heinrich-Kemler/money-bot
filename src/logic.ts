import { SpendError } from "./errors.ts";
import {
  assertCheckoutUrlMatchesLock,
  assertUkEuMerchant,
  merchantDomainFromUrl,
  normalizeMerchantDomain,
} from "./region.ts";
import {
  AUTO_APPROVE_MAX,
  CHALLENGE_INSTRUCTIONS,
  CHALLENGE_MINUTES,
  DENY_AMOUNT_EPSILON,
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

export { SpendError };
export { merchantDomainFromUrl };

export function newSpendRequestId(): string {
  return `sr_${crypto.randomUUID()}`;
}

export function nowIso(at = new Date()): string {
  return at.toISOString();
}

export function expiresAtFrom(created: Date, ttlMs = SPEND_TTL_MS): string {
  return new Date(created.getTime() + ttlMs).toISOString();
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

export function assertSpendCapAllowsAmount(
  spendCap: number | undefined,
  amount: number,
): void {
  if (spendCap !== undefined && spendCap < amount) {
    throw new SpendError(
      `spendCap (${spendCap}) must be greater than or equal to amount (${amount}).`,
    );
  }
}

export function cartFromInput(input: RequestSpendInput): LockedCart {
  assertUkEuMerchant(input.merchantUrl, input.currency);
  const merchantDomain = merchantDomainFromUrl(input.merchantUrl);
  const checkoutUrl = assertCheckoutUrlMatchesLock(
    input.checkoutUrl,
    merchantDomain,
  );
  assertSpendCapAllowsAmount(input.spendCap, input.amount);
  return {
    amount: input.amount,
    currency: input.currency,
    merchantName: input.merchantName,
    merchantDomain,
    checkoutUrl,
    shipping: input.shipping,
  };
}

/** Re-validate the cart the human is about to lock (F8). */
export function snapshotLockedCart(request: SpendRequest): LockedCart {
  assertUkEuMerchant(request.merchantUrl, request.currency);
  const merchantDomain = merchantDomainFromUrl(request.merchantUrl);
  if (normalizeMerchantDomain(request.merchantDomain) !== merchantDomain) {
    throw new SpendError(
      "merchantDomain does not match merchantUrl. Refusing to lock cart.",
    );
  }
  const checkoutUrl = assertCheckoutUrlMatchesLock(
    request.checkoutUrl,
    merchantDomain,
  );
  assertSpendCapAllowsAmount(request.spendCap, request.amount);
  return {
    amount: request.amount,
    currency: request.currency,
    merchantName: request.merchantName,
    merchantDomain,
    checkoutUrl,
    shipping: request.shipping,
  };
}

export function amountToMinorUnits(amount: number): number {
  return Math.round(amount * 100);
}

/** Canonical lock binding for OOB tokens (M11). Includes the money-path URL. */
export function lockedCartFingerprint(cart: LockedCart): string {
  return [
    normalizeMerchantDomain(cart.merchantDomain),
    cart.currency,
    String(amountToMinorUnits(cart.amount)),
    shippingKey(cart.shipping),
    cart.checkoutUrl,
  ].join("|");
}

export function denyFingerprint(
  domain: string,
  currency: string,
  amount: number,
): string {
  return `${normalizeMerchantDomain(domain)}|${currency}|${amountToMinorUnits(amount)}`;
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
    lineageSpendRequestIds?: string[];
  } = {},
  at = new Date(),
): SpendRequest {
  if (AUTO_APPROVE_MAX !== 0) {
    throw new SpendError("AUTO_APPROVE_MAX must remain 0");
  }
  const lockedCart = cartFromInput(input);
  const checkoutUrl = lockedCart.checkoutUrl;
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
    lockedCartFingerprint: lockedCartFingerprint(lockedCart),
    spendCap: input.spendCap,
    checkoutUrl,
    description: input.description,
    lineItems: input.lineItems,
    cartDiff: extras.cartDiff,
    supersededSpendRequestId: extras.supersededSpendRequestId,
    lineageSpendRequestIds: extras.lineageSpendRequestIds,
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
  candidate: {
    merchantDomain: string;
    amount: number;
    currency: string;
    lockedCart?: LockedCart;
    supersededSpendRequestId?: string;
    lineageSpendRequestIds?: string[];
  },
  at = new Date(),
  windowMs = DENY_RETRY_WINDOW_MS,
): SpendRequest | undefined {
  const candidateFp = denyFingerprint(
    candidate.merchantDomain,
    candidate.currency,
    candidate.amount,
  );
  const candidateCartFp = candidate.lockedCart
    ? lockedCartFingerprint(candidate.lockedCart)
    : undefined;
  const lineage = new Set(candidate.lineageSpendRequestIds ?? []);
  if (candidate.supersededSpendRequestId) {
    lineage.add(candidate.supersededSpendRequestId);
  }

  const candidateDomain = normalizeMerchantDomain(candidate.merchantDomain);

  return existing.find((request) => {
    if (request.status !== "DENIED" && request.status !== "EXPIRED") {
      return false;
    }
    const decided = request.decidedAt
      ? Date.parse(request.decidedAt)
      : request.status === "EXPIRED"
        ? Date.parse(request.expiresAt)
        : Date.parse(request.updatedAt);
    if (at.getTime() - decided > windowMs) {
      return false;
    }
    if (lineage.has(request.spendRequestId)) {
      return true;
    }
    if (request.currency !== candidate.currency) {
      return false;
    }
    if (normalizeMerchantDomain(request.merchantDomain) !== candidateDomain) {
      return false;
    }
    if (
      candidateCartFp &&
      request.lockedCartFingerprint &&
      candidateCartFp === request.lockedCartFingerprint
    ) {
      return true;
    }
    const requestFp = denyFingerprint(
      request.merchantDomain,
      request.currency,
      request.amount,
    );
    if (requestFp === candidateFp) {
      return true;
    }
    return Math.abs(request.amount - candidate.amount) <= DENY_AMOUNT_EPSILON;
  });
}

export function supersedeLockedRequest(
  request: SpendRequest,
  replacementId: string,
  at = new Date(),
): SpendRequest {
  return {
    ...request,
    status: "FAILED",
    supersededBySpendRequestId: replacementId,
    updatedAt: nowIso(at),
  };
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
  opts: {
    assertionVerified?: boolean;
    decidedBy?: string;
    denyReason?: string;
    orderId?: string;
  } = {},
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
  if (!opts.assertionVerified) {
    throw new SpendError(
      "Approve/Deny requires a verified signed OOB assertion. " +
        "Raw decidedBy or a request-body actor string is not accepted.",
    );
  }
  if (current.status !== "PENDING") {
    throw new SpendError(
      `Cannot decide a spend request in status "${current.status}".`,
    );
  }
  const lockedCart = snapshotLockedCart(current);
  if (decision === "denied") {
    return {
      ...current,
      status: "DENIED",
      lockedCart,
      lockedCartFingerprint: lockedCartFingerprint(lockedCart),
      checkoutUrl: lockedCart.checkoutUrl,
      decidedAt: nowIso(at),
      decidedBy: "oob-assertion",
      denyReason: opts.denyReason,
      updatedAt: nowIso(at),
    };
  }
  return {
    ...current,
    status: "APPROVED",
    lockedCart,
    lockedCartFingerprint: lockedCartFingerprint(lockedCart),
    checkoutUrl: lockedCart.checkoutUrl,
    merchantDomain: lockedCart.merchantDomain,
    decidedAt: nowIso(at),
    decidedBy: "oob-assertion",
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
  assertSpendCapAllowsAmount(spendCap, current.amount);
  return {
    ...current,
    spendCap,
    updatedAt: nowIso(at),
  };
}

/** Open only the locked money-path URL (F4). Reject host swaps after Approve. */
export function resolveHandoffUrl(request: SpendRequest): string {
  const lockedDomain = normalizeMerchantDomain(request.lockedCart.merchantDomain);
  const lockedUrl = request.lockedCart.checkoutUrl;
  if (!lockedUrl) {
    throw new SpendError(
      "Locked cart is missing checkoutUrl (the money path). Handoff refused.",
    );
  }
  if (request.checkoutUrl && request.checkoutUrl !== lockedUrl) {
    throw new SpendError(
      "checkoutUrl was swapped after the cart lock. Handoff refused.",
    );
  }
  return assertCheckoutUrlMatchesLock(lockedUrl, lockedDomain);
}

function handoffResult(
  request: SpendRequest,
  status: CheckoutHandoffResult["status"],
  checkoutUrl: string,
  instructions: string,
): CheckoutHandoffResult {
  return {
    spendRequestId: request.spendRequestId,
    status,
    checkoutUrl,
    merchantDomain: request.lockedCart.merchantDomain,
    moneyPath: true,
    handoffInstructions: instructions,
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
  const checkoutUrl = resolveHandoffUrl(current);
  if (current.status === "CHALLENGE") {
    return {
      request: current,
      result: handoffResult(
        current,
        "CHALLENGE",
        checkoutUrl,
        CHALLENGE_INSTRUCTIONS,
      ),
    };
  }
  if (current.status !== "APPROVED" && current.status !== "WAITING_FOR_YOU") {
    throw new SpendError(
      `Checkout handoff requires status APPROVED or WAITING_FOR_YOU (got "${current.status}").`,
    );
  }
  const next: SpendRequest = {
    ...current,
    status: "WAITING_FOR_YOU",
    checkoutUrl,
    updatedAt: nowIso(at),
  };
  return {
    request: next,
    result: handoffResult(
      next,
      "WAITING_FOR_YOU",
      checkoutUrl,
      HANDOFF_INSTRUCTIONS,
    ),
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
    note: "A merchant authentication challenge may be in progress. Hand the screen to the human. Money Bot does not implement brand SCA flows.",
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
