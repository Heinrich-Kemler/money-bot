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
        "After human approval, prepare checkout handoff. Returns a checkout URL " +
        "and instructions for the human to complete Apple Pay / Revolut Pay / 3DS. " +
        "NEVER returns payment credentials.",
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
