import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { buildApproveUrl } from "../approve-page.ts";
import { getSpendStatusInputSchema } from "../schemas.ts";
import { SpendError } from "../logic.ts";
import { errorToolResult, jsonToolResult } from "../sanitize.ts";
import { spendStoreForTenant } from "../store.ts";
import type { ToolContext } from "../types.ts";
import { grokbotWidgetForPending } from "../widget.ts";

export function registerGetSpendStatus(
  server: McpServer,
  getCtx: () => ToolContext,
): void {
  server.registerTool(
    "get_spend_status",
    {
      description:
        "Return the full spend-request status using the Money Bot state machine: " +
        "PENDING | APPROVED | WAITING_FOR_YOU | PAID | CHALLENGE | FAILED | DENIED | EXPIRED | CANCELLED | REAUTH_REQUIRED. " +
        "While PENDING, includes a human-only `widget` (Approve / Reject / Keep looking) " +
        "and approveUrl (local smoke only). Never returns payment credentials.",
      inputSchema: getSpendStatusInputSchema,
    },
    async ({ spendRequestId }) => {
      try {
        const ctx = getCtx();
        const store = spendStoreForTenant(ctx.env, ctx.tenantId);
        const loaded = await store.getForTenant(spendRequestId, ctx.tenantId);
        if (!loaded.ok) {
          return errorToolResult(loaded.error);
        }
        const request = loaded.value;
        const tenantConnection = await store.getTenantConnection(ctx.tenantId);
        const approveUrl =
          request.status === "PENDING"
            ? await buildApproveUrl(ctx.env, request.spendRequestId, ctx.tenantId)
            : undefined;
        const widget = grokbotWidgetForPending(request);
        return jsonToolResult({
          spendRequestId: request.spendRequestId,
          status: request.status,
          approveUrl,
          approveUrlLocalSmokeOnly: true,
          widget,
          lockedCartFingerprint: request.lockedCartFingerprint,
          tenantConnection,
          merchantName: request.merchantName,
          merchantUrl: request.merchantUrl,
          merchantDomain: request.merchantDomain,
          amount: request.amount,
          currency: request.currency,
          shipping: request.shipping,
          lockedCart: request.lockedCart,
          spendCap: request.spendCap,
          checkoutUrl: request.checkoutUrl,
          description: request.description,
          lineItems: request.lineItems,
          cartDiff: request.cartDiff,
          supersededSpendRequestId: request.supersededSpendRequestId,
          challenge: request.challenge,
          createdAt: request.createdAt,
          updatedAt: request.updatedAt,
          decidedAt: request.decidedAt,
          decidedBy: request.decidedBy,
          denyReason: request.denyReason,
          orderId: request.orderId,
          expiresAt: request.expiresAt,
        });
      } catch (error) {
        const message =
          error instanceof SpendError
            ? error.message
            : "Failed to load spend status.";
        return errorToolResult(message);
      }
    },
  );
}
