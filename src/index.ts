import { MoneyBotMCP } from "./mcp.ts";
import { spendStoreForTenant, SpendStore } from "./store.ts";
import { SpendError } from "./logic.ts";
import { redactPaymentSecrets } from "./sanitize.ts";
import { isDevMode } from "./tools/dev_set_spend_decision.ts";

export { MoneyBotMCP, SpendStore };

const mcpHandler = MoneyBotMCP.serve("/mcp", { binding: "MCP_OBJECT" });
const sseHandler = MoneyBotMCP.serveSSE("/sse", { binding: "MCP_OBJECT" });

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(redactPaymentSecrets(data), null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    return (await request.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function applyHostDecision(
  env: Env,
  body: Record<string, unknown>,
): Promise<Response> {
  const spendRequestId = String(body.spendRequestId ?? "");
  const decision = body.decision;
  const tenantId = String(body.tenantId ?? "anonymous");
  if (!spendRequestId || (decision !== "approved" && decision !== "denied")) {
    return json(
      { error: "spendRequestId and decision (approved|denied) are required." },
      400,
    );
  }
  try {
    const store = spendStoreForTenant(env, tenantId);
    const updated = await store.decide(spendRequestId, tenantId, decision, {
      decidedBy: typeof body.decidedBy === "string" ? body.decidedBy : "human",
      denyReason:
        typeof body.denyReason === "string" ? body.denyReason : undefined,
      orderId: typeof body.orderId === "string" ? body.orderId : undefined,
    });
    if (!updated.ok) {
      return json({ error: updated.error }, 400);
    }
    return json({
      spendRequestId: updated.value.spendRequestId,
      status: updated.value.status,
      decidedAt: updated.value.decidedAt,
      decidedBy: updated.value.decidedBy,
      denyReason: updated.value.denyReason,
    });
  } catch (error) {
    const message =
      error instanceof SpendError ? error.message : "Decision failed.";
    return json({ error: message }, 400);
  }
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) {
      return mcpHandler.fetch(request, env, ctx);
    }

    if (url.pathname === "/sse" || url.pathname.startsWith("/sse/")) {
      return sseHandler.fetch(request, env, ctx);
    }

    if (url.pathname === "/host/spend-decision" && request.method === "POST") {
      // TODO(host-approval-bridge): Production Cursor host should POST here
      // after the human taps Approve/Deny in chat (Stripe Link parity).
      // Authenticate the host, map the Cursor user to tenantId / OAuth props,
      // and never accept agent-originated retries after deny.
      if (!isDevMode(env)) {
        return json(
          {
            error: "host_approval_bridge_not_connected",
            message:
              "TODO: Wire Cursor host Approve/Deny UI to this endpoint. " +
              "autoApproveMax is 0; spend stays PENDING until a human decides. " +
              "Approve locks amount + merchant + domain + shipping.",
          },
          501,
        );
      }
      return applyHostDecision(env, await readJson(request));
    }

    if (url.pathname === "/dev/spend-decision" && request.method === "POST") {
      if (!isDevMode(env)) {
        return json({ error: "DEV_MODE is not enabled." }, 404);
      }
      return applyHostDecision(env, await readJson(request));
    }

    if (url.pathname === "/" && request.method === "GET") {
      return json({
        name: "Money Bot",
        id: "money-bot",
        version: "0.1.0",
        mcp: "/mcp",
        stateMachine:
          "IDLE → PENDING → APPROVED → WAITING_FOR_YOU → PAID | CHALLENGE | FAILED",
        tools: [
          "request_spend",
          "get_spend_status",
          "prepare_checkout_handoff",
          "report_checkout_outcome",
          "edit_spend_cap",
        ],
        autoApproveMax: 0,
        v1: "not_implemented",
      });
    }

    return json({ error: "Not found" }, 404);
  },
} satisfies ExportedHandler<Env>;
