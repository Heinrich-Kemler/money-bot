import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { devSetSpendDecisionInputSchema } from "../schemas.ts";
import { SpendError } from "../logic.ts";
import { errorToolResult, jsonToolResult } from "../sanitize.ts";
import { spendStoreForTenant } from "../store.ts";
import type { ToolContext } from "../types.ts";

export function isDevMode(env: Env): boolean {
  return env.DEV_MODE === "true";
}

export function registerDevSetSpendDecision(
  server: McpServer,
  getCtx: () => ToolContext,
): void {
  if (!isDevMode(getCtx().env)) {
    return;
  }

  server.registerTool(
    "dev_set_spend_decision",
    {
      description:
        "DEV_MODE only. Simulate the host Approve/Deny UI for local testing. " +
        "Not available when DEV_MODE is false.",
      inputSchema: devSetSpendDecisionInputSchema,
    },
    async (input) => {
      try {
        const ctx = getCtx();
        const store = spendStoreForTenant(ctx.env, ctx.tenantId);
        const updated = await store.decide(
          input.spendRequestId,
          ctx.tenantId,
          input.decision,
          {
            decidedBy: input.decidedBy ?? "dev",
            denyReason: input.denyReason,
            orderId: input.orderId,
          },
        );
        return jsonToolResult({
          spendRequestId: updated.spendRequestId,
          status: updated.status,
          decidedAt: updated.decidedAt,
          decidedBy: updated.decidedBy,
          denyReason: updated.denyReason,
          orderId: updated.orderId,
        });
      } catch (error) {
        const message =
          error instanceof SpendError
            ? error.message
            : "Failed to set spend decision.";
        return errorToolResult(message);
      }
    },
  );
}
