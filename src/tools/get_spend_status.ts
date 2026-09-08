import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getSpendStatusInputSchema } from "../schemas.ts";
import { SpendError } from "../logic.ts";
import { errorToolResult, jsonToolResult } from "../sanitize.ts";
import { spendStoreForTenant } from "../store.ts";
import type { ToolContext } from "../types.ts";

export function registerGetSpendStatus(
  server: McpServer,
  getCtx: () => ToolContext,
): void {
  server.registerTool(
    "get_spend_status",
    {
      description:
        "Return the full spend-request status, including decision and audit fields. " +
        "Never returns payment credentials.",
      inputSchema: getSpendStatusInputSchema,
    },
    async ({ spendRequestId }) => {
      try {
        const ctx = getCtx();
        const store = spendStoreForTenant(ctx.env, ctx.tenantId);
        const request = await store.getForTenant(spendRequestId, ctx.tenantId);
        return jsonToolResult({
          spendRequestId: request.spendRequestId,
          status: request.status,
          merchantName: request.merchantName,
          merchantUrl: request.merchantUrl,
          amount: request.amount,
          currency: request.currency,
          checkoutUrl: request.checkoutUrl,
          description: request.description,
          lineItems: request.lineItems,
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
