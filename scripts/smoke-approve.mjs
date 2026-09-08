/**
 * Local e2e: request_spend (MCP) → GET /approve → POST signed assertion → handoff.
 * Not passkey/WebAuthn. Requires wrangler dev + ALLOW_TEST_AUTH=true.
 */
const BASE = (process.env.MONEY_BOT_URL ?? "http://localhost:8787").replace(
  /\/$/,
  "",
);
const TENANT = process.env.SMOKE_TENANT ?? "smoke-user";
const AUTH = { Authorization: `Bearer test:${TENANT}` };

function fail(message) {
  console.error(message);
  process.exit(1);
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

  const init = await mcp("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "money-bot-smoke-approve", version: "0.1.0" },
  });
  const sessionId = init.sessionId;
  if (!sessionId) {
    fail("MCP initialize did not return mcp-session-id");
  }
  await mcp("notifications/initialized", {}, sessionId);

  const tools = await mcp("tools/list", {}, sessionId, 2);
  const names = (tools.json?.result?.tools ?? []).map((tool) => tool.name);
  const forbidden = names.filter((name) =>
    ["dev_set_spend_decision", "report_checkout_outcome", "edit_spend_cap"].includes(
      name,
    ),
  );
  if (forbidden.length > 0) {
    fail(`Agent surface leaked decide tools: ${forbidden.join(", ")}`);
  }
  if (
    !names.includes("request_spend") ||
    !names.includes("get_spend_status") ||
    !names.includes("prepare_checkout_handoff")
  ) {
    fail(`Unexpected tools: ${names.join(", ")}`);
  }

  const createdRpc = await mcp(
    "tools/call",
    {
      name: "request_spend",
      arguments: {
        merchantName: "Smoke Shop",
        merchantUrl: `https://${shop}`,
        amount: 4.2,
        currency: "GBP",
        checkoutUrl,
        description: "smoke-approve",
      },
    },
    sessionId,
    3,
  );
  const created = toolPayload(createdRpc);
  if (created.status !== "PENDING" || !created.approveUrl) {
    fail(`request_spend did not return PENDING + approveUrl: ${JSON.stringify(created)}`);
  }
  console.log(`PENDING ${created.spendRequestId}`);
  console.log(`approveUrl ${created.approveUrl}`);

  const page = await fetch(created.approveUrl, { redirect: "follow" });
  const html = await page.text();
  if (!page.ok) {
    fail(`GET /approve failed ${page.status}: ${html}`);
  }
  const assertion = html.match(/id="approve-assertion" value="([^"]+)"/)?.[1];
  if (!assertion) {
    fail("Approve page did not embed a server-minted assertion");
  }

  const decide = await fetch(`${BASE}/host/spend-decision`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: new URLSearchParams({ assertion }),
  });
  const decided = JSON.parse(await decide.text());
  if (!decide.ok || decided.status !== "APPROVED") {
    fail(`Approve POST failed ${decide.status}: ${JSON.stringify(decided)}`);
  }
  if (decided.decidedBy !== "oob-assertion") {
    fail(`decidedBy must be oob-assertion, got ${decided.decidedBy}`);
  }
  console.log(`APPROVED (locked cart re-snapshotted)`);

  const statusRpc = await mcp(
    "tools/call",
    { name: "get_spend_status", arguments: { spendRequestId: created.spendRequestId } },
    sessionId,
    4,
  );
  const status = toolPayload(statusRpc);
  if (status.status !== "APPROVED") {
    fail(`get_spend_status expected APPROVED, got ${status.status}`);
  }

  const handoffRpc = await mcp(
    "tools/call",
    {
      name: "prepare_checkout_handoff",
      arguments: { spendRequestId: created.spendRequestId },
    },
    sessionId,
    5,
  );
  const handoff = toolPayload(handoffRpc);
  if (handoff.checkoutUrl !== checkoutUrl || handoff.status !== "WAITING_FOR_YOU") {
    fail(`handoff mismatch: ${JSON.stringify(handoff)}`);
  }
  console.log(`WAITING_FOR_YOU ${handoff.checkoutUrl}`);
  console.log("smoke-approve: ok");
}

main().catch((error) => {
  fail(error?.stack ?? String(error));
});
