import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { registerDevSetSpendDecision } from "./tools/dev_set_spend_decision.ts";
import { registerGetSpendStatus } from "./tools/get_spend_status.ts";
import { registerPrepareCheckoutHandoff } from "./tools/prepare_checkout_handoff.ts";
import { registerRequestSpend } from "./tools/request_spend.ts";
import type { ToolContext } from "./types.ts";

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
      throw new Error("Worker env is not available.");
    }
    return {
      env,
      tenantId: this.props?.userId ?? "anonymous",
    };
  }

  async init() {
    const ctx = (): ToolContext => this.toolContext();

    registerRequestSpend(this.server, ctx);
    registerGetSpendStatus(this.server, ctx);
    registerPrepareCheckoutHandoff(this.server, ctx);
    registerDevSetSpendDecision(this.server, ctx);
  }
}
