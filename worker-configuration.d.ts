interface Env {
  MCP_OBJECT: DurableObjectNamespace;
  SPEND_STORE: DurableObjectNamespace<import("./src/store").SpendStore>;
  AUTO_APPROVE_MAX: string;
  /**
   * Local-only. Production wrangler.toml must leave this unset (default false).
   * When "true", `Authorization: Bearer test:<userId>` populates MCP props.userId.
   */
  ALLOW_TEST_AUTH?: string;
  /** HMAC/JWT secret used to mint and verify Approve assertions. Never commit. */
  APPROVAL_HMAC_SECRET?: string;
  /** Origin for approveUrl (default http://localhost:8787). */
  PUBLIC_BASE_URL?: string;
}
