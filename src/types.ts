export const SPEND_STATUSES = [
  "pending_approval",
  "approved",
  "denied",
  "checkout_ready",
  "completed",
  "expired",
  "failed",
] as const;

export type SpendStatus = (typeof SPEND_STATUSES)[number];

export const DECISIONS = ["approved", "denied"] as const;
export type SpendDecision = (typeof DECISIONS)[number];

export type LineItem = {
  name: string;
  quantity: number;
  unitAmount: number;
};

export type SpendRequest = {
  spendRequestId: string;
  tenantId: string;
  status: SpendStatus;
  merchantName: string;
  merchantUrl: string;
  amount: number;
  currency: string;
  checkoutUrl?: string;
  description?: string;
  lineItems?: LineItem[];
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
  status: "pending_approval";
  merchantName: string;
  amount: number;
  currency: string;
  createdAt: string;
};

export type SpendStatusResult = SpendRequest;

export type CheckoutHandoffResult = {
  spendRequestId: string;
  status: "checkout_ready";
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

export const HANDOFF_INSTRUCTIONS =
  "Open the checkout URL in a browser and hand the screen to the human. " +
  "The human completes Apple Pay, Revolut Pay, or 3-D Secure on that screen. " +
  "Never enter, request, store, or return card numbers, CVC, or expiry. " +
  "The agent must not handle payment credentials.";
