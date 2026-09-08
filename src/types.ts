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
  /** Money path. Host must equal merchantDomain. Locked at request + Approve. */
  checkoutUrl: string;
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
  supersededBySpendRequestId?: string;
  lineageSpendRequestIds?: string[];
  lockedCartFingerprint?: string;
  challenge?: ChallengeInfo;
  /**
   * v1 only: spend is bound to this tenant's Revolut Business.
   * v0 URL handoff does not require a Revolut connection.
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
  /** Browser Approve page. Agent must present this — never complete Approve. */
  approveUrl: string;
  supersededSpendRequestId?: string;
  cartDiff?: CartDiff;
};

export type SpendStatusResult = SpendRequest & {
  tenantConnection: TenantConnection;
};

export type CheckoutHandoffResult = {
  spendRequestId: string;
  status: "WAITING_FOR_YOU" | "CHALLENGE";
  /** The payment path. Host is locked to merchantDomain. Never substitute another URL. */
  checkoutUrl: string;
  merchantDomain: string;
  moneyPath: true;
  handoffInstructions: string;
};

export type ToolContext = {
  env: Env;
  tenantId: string;
};

export const AUTO_APPROVE_MAX = 0;

export const SPEND_TTL_MS = 30 * 60 * 1000;

export const DENY_RETRY_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Same-domain deny matches if |Δamount| is within this (blocks ±£0.01 retries). */
export const DENY_AMOUNT_EPSILON = 0.5;

/** Complete production agent MCP surface. No decide, outcome, or cap tools. */
export const AGENT_MCP_TOOLS = [
  "request_spend",
  "get_spend_status",
  "prepare_checkout_handoff",
] as const;

/**
 * First testable Approve: local HMAC-signed browser page → POST /host/spend-decision.
 * This is not passkey/WebAuthn. Raw `decidedBy` is never enough.
 */
export const OOB_ASSERTION_CONTRACT = {
  scaffoldOnly: false,
  localHmacOnly: true,
  notPasskey: true,
  transport:
    "GET /approve?… then POST /host/spend-decision with Authorization: Bearer <jwt-or-hmac> (or form field assertion=)",
  type: "HS256 JWT or compact HMAC (mb1.<payload>.<mac>) minted by the Worker — not WebAuthn yet",
  requiredClaims: {
    iss: "money-bot-oob",
    aud: "money-bot",
    exp: "unix seconds, short-lived (minutes)",
    iat: "unix seconds",
    jti: "unique assertion id (replay protection)",
    spendRequestId: "sr_…",
    tenantId:
      "from the verified assertion only — never anonymous, never a JSON body field",
    decision: "approved | denied",
    lockedCartFingerprint:
      "MUST equal the stored locked-cart fingerprint (binds token to amount+merchantDomain+currency+shipping+checkoutUrl)",
  },
  rejected: [
    "raw decidedBy string",
    'decidedBy: "human"',
    "tenantId from request JSON body",
    "agent tools/call",
    "unsigned JSON body",
    "DEV_MODE decide switch",
  ],
} as const;

/** Informational only — Money Bot does not implement SCA. */
export const SCA_THRESHOLD_GBP = 25;
export const SCA_THRESHOLD_EUR = 30;

export const CHALLENGE_MINUTES = {
  amex_safekey: 4,
  revolut_3ds: 5,
  sca: 5,
  other: 5,
} as const;

export const HANDOFF_INSTRUCTIONS =
  "checkoutUrl is the money path. Open only that https URL; its host must match " +
  "the locked merchantDomain. Never substitute merchantUrl or another host. " +
  "Hand the screen to the human. Never show, type, or return a raw PAN, CVC, or expiry. " +
  "The merchant page may present its own wallet or SCA UI — Money Bot does not implement those flows. " +
  "Do not mark PAID yourself; only the human/host records payment outcome.";

export const CHALLENGE_INSTRUCTIONS =
  "A merchant authentication challenge appears to be in progress. " +
  "Hand the screen back to the human and wait. Do not enter card numbers. " +
  "Only the human/host records PAID or FAILED.";
