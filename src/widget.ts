import { lockedCartFingerprint } from "./logic.ts";
import {
  WIDGET_OPTIONS,
  type GrokbotWidget,
  type SpendRequest,
} from "./types.ts";

/** Human-only card Life Admin can render after request_spend (PENDING). */
export function grokbotWidgetForPending(
  request: SpendRequest,
): GrokbotWidget | undefined {
  if (request.status !== "PENDING") {
    return undefined;
  }
  return {
    spendRequestId: request.spendRequestId,
    merchantName: request.merchantName,
    amount: request.amount,
    currency: request.currency,
    merchantDomain: request.merchantDomain,
    checkoutUrl: request.lockedCart.checkoutUrl,
    lockedCartFingerprint:
      request.lockedCartFingerprint ??
      lockedCartFingerprint(request.lockedCart),
    options: WIDGET_OPTIONS,
  };
}
