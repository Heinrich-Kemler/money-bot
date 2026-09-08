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
        "autoApproveMax is £0. Returns approveUrl for local smoke / non-Grokbot " +
        "browser Approve (HMAC page; bearer capability, not human proof). " +
        "There is no decide MCP tool. On Grokbot/Life Admin the host shows a " +
        "human-only Approve/Reject widget — do not fetch or POST approveUrl. " +
        "checkoutUrl is the money path and must be https on the merchant domain. " +
        "Same-merchant locks may be superseded; other shops' APPROVED locks are not. " +
        "Never include payment credentials.",
      inputSchema: requestSpendInputSchema,
    },
    async (input) => {
      try {
        // No decide MCP tool. approveUrl is a local bearer capability (not
        // human-proof). Grokbot/Life Admin must use a human-only host widget.
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
