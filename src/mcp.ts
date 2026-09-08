import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { requireTenantId } from "./auth.ts";
import { SpendError } from "./errors.ts";
import { registerGetSpendStatus } from "./tools/get_spend_status.ts";
import { registerPrepareCheckoutHandoff } from "./tools/prepare_checkout_handoff.ts";
import { registerRequestSpend } from "./tools/request_spend.ts";
import { AGENT_MCP_TOOLS, type ToolContext } from "./types.ts";

export type MoneyBotProps = {
  userId?: string;
};

export class MoneyBotMCP extends McpAgent<
  Env,
  Record<string, never>,
  MoneyBotProps
> {
  server = new McpServer({
    name: "money-bot",
    version: "0.1.0",
  });

  initialState: Record<string, never> = {};

  private toolContext(): ToolContext {
    const env = this.env;
    if (!env) {
      throw new SpendError("Worker env is not available.");
    }
    return {
      env,
      tenantId: requireTenantId(this.props?.userId),
    };
  }

  async init() {
    const ctx = (): ToolContext => this.toolContext();

    registerRequestSpend(this.server, ctx);
    registerGetSpendStatus(this.server, ctx);
    registerPrepareCheckoutHandoff(this.server, ctx);
    // Prod agent surface is only the three tools above.
    // No decide, outcome, cap-edit, or DEV_MODE Approve tool — ever.
    void AGENT_MCP_TOOLS;
  }
}
