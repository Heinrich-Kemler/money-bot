import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { prepareCheckoutHandoffInputSchema } from "../schemas.ts";
import { SpendError } from "../logic.ts";
import { errorToolResult, jsonToolResult } from "../sanitize.ts";
import { spendStoreForTenant } from "../store.ts";
import type { ToolContext } from "../types.ts";

export function registerPrepareCheckoutHandoff(
  server: McpServer,
  getCtx: () => ToolContext,
): void {
  server.registerTool(
    "prepare_checkout_handoff",
    {
      description:
        "After APPROVED, move to WAITING_FOR_YOU and return the locked checkoutUrl " +
        "(the money path). Host must match the locked merchantDomain. " +
        "Never open a different URL. NEVER returns payment credentials.",
      inputSchema: prepareCheckoutHandoffInputSchema,
    },
    async ({ spendRequestId }) => {
      try {
        const ctx = getCtx();
        const store = spendStoreForTenant(ctx.env, ctx.tenantId);
        const result = await store.handoff(spendRequestId, ctx.tenantId);
        if (!result.ok) {
          return errorToolResult(result.error);
        }
        return jsonToolResult(result.value);
      } catch (error) {
        const message =
          error instanceof SpendError
            ? error.message
            : "Failed to prepare checkout handoff.";
        return errorToolResult(message);
      }
    },
  );
}
