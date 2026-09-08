/**
 * Money Bot spend state machine (internal metaphor: “Spend Gate”).
 *
 *   IDLE → PENDING → APPROVED → WAITING_FOR_YOU → PAID | CHALLENGE | FAILED
 *                    ↘ DENIED | EXPIRED
 *                    ↘ REAUTH_REQUIRED  (90-day tenant re-consent; v1 Revolut)
 *
 * IDLE is the empty machine (no active request). It is not persisted.
 *
 * Tenant connection (separate, exists from day one):
 *   NOT_CONNECTED → CONNECTED → REAUTH_REQUIRED → CONNECTED
 * Revolut Business is optional in v0. There is no public OAuth.
 *
 * Legacy names (aliases only, not stored):
 *   pending_approval → PENDING
 *   approved → APPROVED
 *   checkout_ready → WAITING_FOR_YOU
 *   completed → PAID
 *   denied → DENIED
 *   expired → EXPIRED
 *   failed → FAILED
 */
export const SPEND_STATUSES = [
  "IDLE",
  "PENDING",
  "APPROVED",
  "WAITING_FOR_YOU",
  "PAID",
  "CHALLENGE",
  "FAILED",
  "DENIED",
  "EXPIRED",
  "REAUTH_REQUIRED",
] as const;

export type SpendStatus = (typeof SPEND_STATUSES)[number];

export const PERSISTED_SPEND_STATUSES = SPEND_STATUSES.filter(
  (status) => status !== "IDLE",
);

export type PersistedSpendStatus = Exclude<SpendStatus, "IDLE">;

export const TERMINAL_FROM_PENDING = ["DENIED", "EXPIRED"] as const;

export const COMPLETION_FROM_HANDOFF = ["PAID", "CHALLENGE", "FAILED"] as const;

export type CheckoutOutcome = (typeof COMPLETION_FROM_HANDOFF)[number];

export const DECISIONS = ["approved", "denied"] as const;
export type SpendDecision = (typeof DECISIONS)[number];

/**
 * Per-tenant Revolut Business connection.
 * No public OAuth: cert + client_id + JWT + Enable access (wizard, not one-tap).
 * Access token ~40 minutes; refresh requires ~90-day re-consent.
 * Never store PAN, CVV, or access tokens in this object.
 */
export const TENANT_CONNECTION_STATUSES = [
  "NOT_CONNECTED",
  "CONNECTED",
  "REAUTH_REQUIRED",
] as const;

export type TenantConnectionStatus = (typeof TENANT_CONNECTION_STATUSES)[number];

export type TenantConnection = {
  tenantId: string;
  status: TenantConnectionStatus;
  /** Revolut is optional in v0; false until a v1 wizard completes. */
  revolutConnected: boolean;
  connectedAt?: string;
  /** 90-day Enable-access / re-consent deadline. */
  consentExpiresAt?: string;
  /** Access-token lifetime hint (~40m). Never persist the token. */
  accessTokenExpiresAt?: string;
  updatedAt: string;
};

export const REVOLUT_ACCESS_TOKEN_TTL_MS = 40 * 60 * 1000;
export const REVOLUT_RECONSENT_MS = 90 * 24 * 60 * 60 * 1000;

export type LineItem = {
  name: string;
  quantity: number;
  unitAmount: number;
};

/** Shipping snapshot locked at Approve (AP2 Cart Mandate–style). */
export type Shipping = {
  name?: string;
  line1?: string;
  city?: string;
  postalCode?: string;
  country?: string;
};

export type LockedCart = {
  amount: number;
  currency: string;
  merchantName: string;
  merchantDomain: string;
  shipping?: Shipping;
};

export type CartDiffField = keyof LockedCart;

export type CartDiff = {
  fields: CartDiffField[];
  previous: LockedCart;
  next: LockedCart;
};

export type ChallengeInfo = {
  kind: "sca" | "amex_safekey" | "revolut_3ds" | "other";
  startedAt: string;
  expectedMinutes: number;
  note: string;
};

export type SpendRequest = {
  spendRequestId: string;
  tenantId: string;
  status: PersistedSpendStatus;
  merchantName: string;
  merchantUrl: string;
  merchantDomain: string;
  amount: number;
  currency: string;
  shipping?: Shipping;
  /** Cart proposed at request time; frozen onto the record at APPROVED. */
  lockedCart: LockedCart;
  /** Optional spend cap (v0/v1). Editing cap never grants approval. */
  spendCap?: number;
  checkoutUrl?: string;
  description?: string;
  lineItems?: LineItem[];
  cartDiff?: CartDiff;
  supersededSpendRequestId?: string;
  challenge?: ChallengeInfo;
  /**
   * v1 only: spend is bound to this tenant's Revolut Business.
   * v0 handoff (Apple Pay / Revolut Pay) does not require a connection.
   */
  requiresTenantConnection: boolean;
  statusBeforeReauth?: PersistedSpendStatus;
  createdAt: string;
  updatedAt: string;
  decidedAt?: string;
  decidedBy?: string;
  denyReason?: string;
  orderId?: string;
  expiresAt: string;
};

export type RequestSpendResult = {
  spendRequestId: string;
  status: "PENDING";
  merchantName: string;
  amount: number;
  currency: string;
  createdAt: string;
  lockedCart: LockedCart;
  supersededSpendRequestId?: string;
  cartDiff?: CartDiff;
};

export type SpendStatusResult = SpendRequest & {
  tenantConnection: TenantConnection;
};

export type CheckoutHandoffResult = {
  spendRequestId: string;
  status: "WAITING_FOR_YOU" | "CHALLENGE";
  checkoutUrl: string;
  handoffInstructions: string;
};

export type ToolContext = {
  env: Env;
  tenantId: string;
};

export const AUTO_APPROVE_MAX = 0;

export const SPEND_TTL_MS = 30 * 60 * 1000;

export const DENY_RETRY_WINDOW_MS = 24 * 60 * 60 * 1000;

/** SCA still applies in the UK (~£25) and EU (~€30). */
export const SCA_THRESHOLD_GBP = 25;
export const SCA_THRESHOLD_EUR = 30;

export const CHALLENGE_MINUTES = {
  amex_safekey: 4,
  revolut_3ds: 5,
  sca: 5,
  other: 5,
} as const;

export const HANDOFF_INSTRUCTIONS =
  "Open the checkout URL and hand the screen to the human. " +
  "Never show, type, or return a raw PAN, CVC, or expiry. " +
  "Apple Pay on desktop Safari uses the payment sheet. " +
  "Apple Pay on desktop non-Safari: the human scans a QR with iPhone (iOS 18+), about 30 seconds. " +
  "Revolut Pay: if the merchant supports it, the human scans a QR and approves in the Revolut app; otherwise fall back to Apple Pay. " +
  "If a 3-D Secure / SCA challenge appears (UK ~£25, EU ~€30), report CHALLENGE and wait — " +
  "Amex SafeKey about 4 minutes, Revolut 3DS about 5 minutes. Do not complete the challenge as the agent.";

export const CHALLENGE_INSTRUCTIONS =
  "A strong-customer-authentication challenge is in progress. " +
  "Hand the screen back to the human and wait. " +
  "Amex SafeKey typically takes about 4 minutes; Revolut 3DS about 5 minutes. " +
  "Do not enter card numbers. After the human finishes, report PAID or FAILED.";
