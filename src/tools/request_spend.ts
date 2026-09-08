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
        "Create a PENDING spend request from IDLE after the cart is filled. " +
        "autoApproveMax is £0. A chat control may only *initiate* out-of-band " +
        "Approve (phone passkey/PWA) — the agent must never press Approve. " +
        "checkoutUrl is the money path and must be https on the merchant domain. " +
        "Cart (amount, merchant, domain, checkoutUrl, shipping) locks at Approve. " +
        "Never include payment credentials.",
      inputSchema: requestSpendInputSchema,
    },
    async (input) => {
      try {
        // TODO(host-approval-bridge): Chat may only *initiate* Approve.
        // The human must confirm out-of-band (phone passkey / PWA).
        // The agent must never be able to press Approve (Ramp-style SoD).
        // Wire a signed OOB decision to POST /host/spend-decision.
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
