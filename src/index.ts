import { handleApprovePage } from "./approve-page.ts";
import { handleSpendDecision } from "./host-decision.ts";
import { gateMcpFetch } from "./mcp-auth.ts";
import { MoneyBotMCP } from "./mcp.ts";
import { SpendStore } from "./store.ts";
import { assertTestAuthAllowedForEnv } from "./test-auth.ts";
import { AGENT_MCP_TOOLS, OOB_ASSERTION_CONTRACT } from "./types.ts";
import { TestAuthConfigError } from "./errors.ts";

export { MoneyBotMCP, SpendStore };

const mcpHandler = MoneyBotMCP.serve("/mcp", { binding: "MCP_OBJECT" });
const sseHandler = MoneyBotMCP.serveSSE("/sse", { binding: "MCP_OBJECT" });

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);

    try {
      assertTestAuthAllowedForEnv(env);
    } catch (error) {
      const message =
        error instanceof TestAuthConfigError
          ? error.message
          : "ALLOW_TEST_AUTH is forbidden on the production deploy path.";
      return json(
        { error: "allow_test_auth_forbidden_in_production", message },
        500,
      );
    }

    if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) {
      const gated = gateMcpFetch(request, env, ctx);
      if (!gated.ok) {
        return gated.response;
      }
      return mcpHandler.fetch(request, env, ctx);
    }

    if (url.pathname === "/sse" || url.pathname.startsWith("/sse/")) {
      const gated = gateMcpFetch(request, env, ctx);
      if (!gated.ok) {
        return gated.response;
      }
      return sseHandler.fetch(request, env, ctx);
    }

    if (url.pathname === "/approve" && request.method === "GET") {
      return handleApprovePage(request, env);
    }

    if (url.pathname === "/host/spend-decision" && request.method === "POST") {
      return handleSpendDecision(request, env);
    }

    if (url.pathname === "/host/checkout-outcome" && request.method === "POST") {
      // C1: payment outcome is host/OOB only — not implemented in v0.
      void request.body;
      return json(
        {
          error: "host_outcome_bridge_not_connected",
          scaffoldOnly: true,
          message:
            "Checkout outcome is still 501. The shopping agent cannot mark PAID.",
        },
        501,
      );
    }

    if (url.pathname === "/dev/spend-decision") {
      return json(
        {
          error: "removed",
          message:
            "HTTP decide endpoints do not apply spend decisions from a body string. " +
            "Use GET /approve and POST /host/spend-decision with a signed assertion.",
          contract: OOB_ASSERTION_CONTRACT,
        },
        410,
      );
    }

    if (url.pathname === "/" && request.method === "GET") {
      return json({
        name: "Money Bot",
        id: "money-bot",
        version: "0.1.0",
        scaffoldOnly: true,
        notProduction: true,
        localHmacApprove: true,
        notPasskey: true,
        mcp: "/mcp",
        approve: "/approve",
        stateMachine:
          "IDLE → PENDING → APPROVED → WAITING_FOR_YOU → PAID | CHALLENGE | FAILED (+ DENIED | EXPIRED | REAUTH_REQUIRED)",
        tools: [...AGENT_MCP_TOOLS],
        approval: "local_hmac_signed_browser_approve",
        revolut: "optional_in_v0",
        autoApproveMax: 0,
        v1: "not_implemented",
        oobAssertionContract: OOB_ASSERTION_CONTRACT,
      });
    }

    return json({ error: "Not found" }, 404);
  },
} satisfies ExportedHandler<Env>;
