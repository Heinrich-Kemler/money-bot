import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { buildApproveUrl } from "../approve-page.ts";
import { requestSpendInputSchema } from "../schemas.ts";
import { SpendError, toRequestSpendResult } from "../logic.ts";
import { errorToolResult, jsonToolResult } from "../sanitize.ts";
import { spendStoreForTenant } from "../store.ts";
import { AUTO_APPROVE_MAX, type ToolContext } from "../types.ts";

export function registerRequestSpend(
  server: McpServer,
  getCtx: () => ToolContext,
): void {
  server.registerTool(
    "request_spend",
    {
      description:
        "Create a PENDING spend request from IDLE after the cart is filled. " +
        "autoApproveMax is £0. Returns approveUrl so a human can Approve in the " +
        "browser (HMAC-signed page). The agent must never press Approve. " +
        "checkoutUrl is the money path and must be https on the merchant domain. " +
        "Cart (amount, merchant, domain, checkoutUrl, shipping) locks at Approve. " +
        "Never include payment credentials.",
      inputSchema: requestSpendInputSchema,
    },
    async (input) => {
      try {
        // Chat / tool result may only *initiate* Approve via approveUrl.
        // The human confirms in the browser with a server-minted HMAC assertion.
        // The agent must never press Approve (no decide tool).
        void AUTO_APPROVE_MAX;

        const ctx = getCtx();
        const store = spendStoreForTenant(ctx.env, ctx.tenantId);
        const created = await store.createFromInput(input, ctx.tenantId);
        if (!created.ok) {
          return errorToolResult(created.error);
        }
        const approveUrl = await buildApproveUrl(
          ctx.env,
          created.value.spendRequestId,
          ctx.tenantId,
        );
        return jsonToolResult(
          toRequestSpendResult(created.value, { approveUrl }),
        );
      } catch (error) {
        const message =
          error instanceof SpendError
            ? error.message
            : "Failed to create spend request.";
        return errorToolResult(message);
      }
    },
  );
}
