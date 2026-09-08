interface Env {
  MCP_OBJECT: DurableObjectNamespace;
  SPEND_STORE: DurableObjectNamespace<import("./src/store").SpendStore>;
  DEV_MODE: string;
  AUTO_APPROVE_MAX: string;
}
