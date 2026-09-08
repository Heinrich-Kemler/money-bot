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
        if (!updated.ok) {
          return errorToolResult(updated.error);
        }
        return jsonToolResult({
          spendRequestId: updated.value.spendRequestId,
          status: updated.value.status,
          decidedAt: updated.value.decidedAt,
          decidedBy: updated.value.decidedBy,
          denyReason: updated.value.denyReason,
          orderId: updated.value.orderId,
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
