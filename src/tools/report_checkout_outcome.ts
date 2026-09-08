import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { reportCheckoutOutcomeInputSchema } from "../schemas.ts";
import { SpendError } from "../logic.ts";
import { errorToolResult, jsonToolResult } from "../sanitize.ts";
import { spendStoreForTenant } from "../store.ts";
import type { ToolContext } from "../types.ts";

export function registerReportCheckoutOutcome(
  server: McpServer,
  getCtx: () => ToolContext,
): void {
  server.registerTool(
    "report_checkout_outcome",
    {
      description:
        "Record the human checkout result after WAITING_FOR_YOU: PAID, CHALLENGE, or FAILED. " +
        "From CHALLENGE, report PAID or FAILED once the human finishes 3DS. " +
        "Never include payment credentials.",
      inputSchema: reportCheckoutOutcomeInputSchema,
    },
    async (input) => {
      try {
        const ctx = getCtx();
        const store = spendStoreForTenant(ctx.env, ctx.tenantId);
        const updated = await store.reportOutcome(
          input.spendRequestId,
          ctx.tenantId,
          input.outcome,
          {
            challengeKind: input.challengeKind,
            orderId: input.orderId,
          },
        );
        if (!updated.ok) {
          return errorToolResult(updated.error);
        }
        return jsonToolResult({
          spendRequestId: updated.value.spendRequestId,
          status: updated.value.status,
          challenge: updated.value.challenge,
          orderId: updated.value.orderId,
        });
      } catch (error) {
        const message =
          error instanceof SpendError
            ? error.message
            : "Failed to report checkout outcome.";
        return errorToolResult(message);
      }
    },
  );
}
