interface Env {
  MCP_OBJECT: DurableObjectNamespace;
  SPEND_STORE: DurableObjectNamespace<import("./src/store").SpendStore>;
  AUTO_APPROVE_MAX: string;
}
