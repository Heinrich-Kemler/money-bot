import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { editSpendCapInputSchema } from "../schemas.ts";
import { SpendError } from "../logic.ts";
import { errorToolResult, jsonToolResult } from "../sanitize.ts";
import { spendStoreForTenant } from "../store.ts";
import type { ToolContext } from "../types.ts";

export function registerEditSpendCap(
  server: McpServer,
  getCtx: () => ToolContext,
): void {
  server.registerTool(
    "edit_spend_cap",
    {
      description:
        "Edit the spend cap only while PENDING. Changing the cap never grants approval. " +
        "The human must still Approve. After APPROVED, a cart/amount mismatch needs a new PENDING.",
      inputSchema: editSpendCapInputSchema,
    },
    async ({ spendRequestId, spendCap }) => {
      try {
        const ctx = getCtx();
        const store = spendStoreForTenant(ctx.env, ctx.tenantId);
        const updated = await store.editCap(spendRequestId, ctx.tenantId, spendCap);
        if (!updated.ok) {
          return errorToolResult(updated.error);
        }
        return jsonToolResult({
          spendRequestId: updated.value.spendRequestId,
          status: updated.value.status,
          spendCap: updated.value.spendCap,
        });
      } catch (error) {
        const message =
          error instanceof SpendError
            ? error.message
            : "Failed to edit spend cap.";
        return errorToolResult(message);
      }
    },
  );
}
