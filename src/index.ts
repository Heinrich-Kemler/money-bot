import { MoneyBotMCP } from "./mcp.ts";
import { SpendStore } from "./store.ts";
import { AGENT_MCP_TOOLS, OOB_ASSERTION_CONTRACT } from "./types.ts";

export { MoneyBotMCP, SpendStore };

const mcpHandler = MoneyBotMCP.serve("/mcp", { binding: "MCP_OBJECT" });
const sseHandler = MoneyBotMCP.serveSSE("/sse", { binding: "MCP_OBJECT" });

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function scaffoldNotImplemented(kind: "approve" | "outcome"): Response {
  return json(
    {
      error:
        kind === "approve"
          ? "host_approval_bridge_not_connected"
          : "host_outcome_bridge_not_connected",
      scaffoldOnly: true,
      message:
        "SCAFFOLD ONLY — not production. This endpoint does not apply decisions. " +
        "It never trusts a raw decidedBy string. A future host must present a signed " +
        "out-of-band assertion (phone passkey/PWA). The shopping agent cannot Approve " +
        "or mark PAID.",
      contract: OOB_ASSERTION_CONTRACT,
    },
    501,
  );
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
      // F2/F3: hard 501. Do not read the body (no tenantId / decidedBy).
      void request.body;
      return scaffoldNotImplemented("approve");
    }

    if (url.pathname === "/host/checkout-outcome" && request.method === "POST") {
      // C1: payment outcome is host/OOB only — not implemented in v0.
      void request.body;
      return scaffoldNotImplemented("outcome");
    }

    if (url.pathname === "/dev/spend-decision") {
      return json(
        {
          error: "removed",
          message:
            "HTTP decide endpoints do not apply spend decisions. " +
            "SCAFFOLD ONLY. Production needs a signed OOB assertion.",
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
        mcp: "/mcp",
        stateMachine:
          "IDLE → PENDING → APPROVED → WAITING_FOR_YOU → PAID | CHALLENGE | FAILED (+ DENIED | EXPIRED | REAUTH_REQUIRED)",
        tools: [...AGENT_MCP_TOOLS],
        approval: "out_of_band_signed_assertion_required",
        revolut: "optional_in_v0",
        autoApproveMax: 0,
        v1: "not_implemented",
        oobAssertionContract: OOB_ASSERTION_CONTRACT,
      });
    }

    return json({ error: "Not found" }, 404);
  },
} satisfies ExportedHandler<Env>;
