interface Env {
  MCP_OBJECT: DurableObjectNamespace;
  SPEND_STORE: DurableObjectNamespace<import("./src/store").SpendStore>;
  AUTO_APPROVE_MAX: string;
  /**
   * wrangler.toml deploy path is "production". Local `.dev.vars` must set
   * "development" (or "local" / "dev") before ALLOW_TEST_AUTH can be honored.
   */
  ENVIRONMENT: string;
  /**
   * Local-only. Production wrangler.toml must leave this unset (default false).
   * When "true" *and* ENVIRONMENT is development/local *and* Host is loopback,
   * `Authorization: Bearer test:<userId>` populates MCP props.userId.
   * If this is "true" on the production ENVIRONMENT, the Worker fails closed.
   */
  ALLOW_TEST_AUTH?: string;
  /** HMAC/JWT secret used to mint and verify Approve assertions. Never commit. */
  APPROVAL_HMAC_SECRET?: string;
  /**
   * Life Admin / Grokbot host token for POST /host/widget-decision.
   * Authorization: Bearer host:<HOST_API_TOKEN>
   * Fail closed if unset. Never expose to the agent.
   */
  HOST_API_TOKEN?: string;
  /** Origin for approveUrl (default http://localhost:8787). */
  PUBLIC_BASE_URL?: string;
}
