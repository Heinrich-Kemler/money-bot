import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
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
        "Create a human-approval spend request after the cart is filled. " +
        "autoApproveMax is fixed at £0 — the host MUST surface Approve/Deny " +
        "(Stripe Link parity). Never include payment credentials.",
      inputSchema: requestSpendInputSchema,
    },
    async (input) => {
      try {
        // TODO(host-approval-bridge): Cursor/host must present Approve/Deny
        // in chat for this spendRequestId. This Worker never auto-approves
        // (AUTO_APPROVE_MAX is hardcoded to 0). Wire the host UI to
        // POST /host/spend-decision once the marketplace approval surface exists.
        void AUTO_APPROVE_MAX;

        const ctx = getCtx();
        const store = spendStoreForTenant(ctx.env, ctx.tenantId);
        const created = await store.createFromInput(input, ctx.tenantId);
        if (!created.ok) {
          return errorToolResult(created.error);
        }
        return jsonToolResult(toRequestSpendResult(created.value));
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
