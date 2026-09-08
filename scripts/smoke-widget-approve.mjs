/**
 * Life Admin host path: request_spend widget → POST /host/widget-decision
 * with Bearer host:<HOST_API_TOKEN>. Does not GET/POST approveUrl.
 */
const BASE = (process.env.MONEY_BOT_URL ?? "http://localhost:8787").replace(
  /\/$/,
  "",
);
const TENANT = process.env.SMOKE_TENANT ?? "smoke-user";
const AUTH = { Authorization: `Bearer test:${TENANT}` };
const HOST_TOKEN = process.env.HOST_API_TOKEN ?? "";

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (!HOST_TOKEN) {
  fail("HOST_API_TOKEN is required for the widget smoke (never use approveUrl).");
}

async function parseRpc(response) {
  const text = await response.text();
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream")) {
    const payloads = [];
    for (const line of text.split(/\r?\n/)) {
      if (line.startsWith("data:")) {
        const raw = line.slice(5).trim();
        if (raw && raw !== "[DONE]") {
          payloads.push(JSON.parse(raw));
        }
      }
    }
    if (payloads.length === 0) {
      fail(`SSE response had no data frames:\n${text}`);
    }
    return { json: payloads.at(-1), sessionId: response.headers.get("mcp-session-id") };
  }
  return {
    json: text ? JSON.parse(text) : undefined,
    sessionId: response.headers.get("mcp-session-id"),
  };
}

async function mcp(method, params, sessionId, id = 1) {
  const headers = {
    ...AUTH,
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (sessionId) {
    headers["mcp-session-id"] = sessionId;
  }
  const body =
    method === "notifications/initialized"
      ? { jsonrpc: "2.0", method, params: params ?? {} }
      : { jsonrpc: "2.0", id, method, params };
  const response = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (method === "notifications/initialized") {
    if (!response.ok && response.status !== 202 && response.status !== 204) {
      fail(`initialized notification failed: ${response.status} ${await response.text()}`);
    }
    return { json: undefined, sessionId: sessionId ?? response.headers.get("mcp-session-id") };
  }
  const parsed = await parseRpc(response);
  if (!response.ok) {
    fail(`MCP ${method} HTTP ${response.status}: ${JSON.stringify(parsed.json)}`);
  }
  if (parsed.json?.error) {
    fail(`MCP ${method} error: ${JSON.stringify(parsed.json.error)}`);
  }
  return parsed;
}

function toolPayload(result) {
  const payload = result.json ?? result;
  const text = payload?.result?.content?.[0]?.text;
  if (!text) {
    fail(`Tool result missing text: ${JSON.stringify(result, null, 2)}`);
  }
  if (payload.result.isError) {
    fail(`Tool error: ${text}`);
  }
  return JSON.parse(text);
}

async function main() {
  const shop = `smoke-${crypto.randomUUID().replace(/-/g, "").slice(0, 10)}.example.co.uk`;
  const checkoutUrl = `https://${shop}/checkout`;

  const unauth = await fetch(`${BASE}/host/widget-decision`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      spendRequestId: "sr_nope",
      decision: "approved",
      lockedCartFingerprint: "x",
    }),
  });
  if (unauth.status !== 401) {
    fail(`missing HOST_API_TOKEN must be 401, got ${unauth.status}`);
  }

  const init = await mcp("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "money-bot-smoke-widget", version: "0.1.0" },
  });
  const sessionId = init.sessionId;
  if (!sessionId) {
    fail("MCP initialize did not return mcp-session-id");
  }
  await mcp("notifications/initialized", {}, sessionId);

  const tools = await mcp("tools/list", {}, sessionId, 2);
  const names = (tools.json?.result?.tools ?? []).map((tool) => tool.name);
  if (names.length !== 3) {
    fail(`Expected exactly 3 MCP tools, got ${names.join(", ")}`);
  }
  const forbidden = names.filter((name) =>
    /decide|approve|widget.decision|outcome|spend_cap/i.test(name),
  );
  if (forbidden.length > 0) {
    fail(`Agent surface leaked decide tools: ${forbidden.join(", ")}`);
  }

  const createdRpc = await mcp(
    "tools/call",
    {
      name: "request_spend",
      arguments: {
        merchantName: "Widget Smoke Shop",
        merchantUrl: `https://${shop}`,
        amount: 6.5,
        currency: "GBP",
        checkoutUrl,
        description: "smoke-widget-approve",
      },
    },
    sessionId,
    3,
  );
  const created = toolPayload(createdRpc);
  if (created.status !== "PENDING" || !created.widget) {
    fail(`request_spend did not return PENDING + widget: ${JSON.stringify(created)}`);
  }
  if (created.approveUrlLocalSmokeOnly !== true) {
    fail("approveUrl must be flagged local-smoke-only");
  }
  const widget = created.widget;
  if (
    !widget.lockedCartFingerprint ||
    !widget.options?.includes("Approve") ||
    !widget.options?.includes("Reject") ||
    !widget.options?.includes("Keep looking")
  ) {
    fail(`widget payload incomplete: ${JSON.stringify(widget)}`);
  }
  console.log(`PENDING ${created.spendRequestId}`);
  console.log(`widget options ${widget.options.join(" / ")}`);
  console.log("(not fetching approveUrl)");

  const decide = await fetch(`${BASE}/host/widget-decision`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      Authorization: `Bearer host:${HOST_TOKEN}`,
      "X-Money-Bot-Tenant": TENANT,
    },
    body: JSON.stringify({
      spendRequestId: widget.spendRequestId,
      decision: "approved",
      lockedCartFingerprint: widget.lockedCartFingerprint,
      tenantId: TENANT,
      decidedBy: "must-be-ignored",
    }),
  });
  const decided = JSON.parse(await decide.text());
  if (!decide.ok || decided.status !== "APPROVED") {
    fail(`widget-decision failed ${decide.status}: ${JSON.stringify(decided)}`);
  }
  if (decided.decidedBy !== "oob-assertion") {
    fail(`decidedBy must be oob-assertion, got ${decided.decidedBy}`);
  }
  console.log("APPROVED via POST /host/widget-decision (host token, not approveUrl)");

  const handoffRpc = await mcp(
    "tools/call",
    {
      name: "prepare_checkout_handoff",
      arguments: { spendRequestId: created.spendRequestId },
    },
    sessionId,
    4,
  );
  const handoff = toolPayload(handoffRpc);
  if (handoff.checkoutUrl !== checkoutUrl || handoff.status !== "WAITING_FOR_YOU") {
    fail(`handoff mismatch: ${JSON.stringify(handoff)}`);
  }
  console.log(`WAITING_FOR_YOU ${handoff.checkoutUrl}`);
  console.log("smoke-widget-approve: ok");
}

main().catch((error) => {
  fail(error?.stack ?? String(error));
});
