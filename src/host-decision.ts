import {
  extractAssertionToken,
  verifyApprovalAssertion,
} from "./assertion.ts";
import { HostDecisionError, SpendError } from "./errors.ts";
import { spendStoreForTenant } from "./store.ts";

export {
  assertFingerprintMatch,
  assertJtiUnused,
  decideFromVerifiedClaims,
} from "./decision.ts";

function statusForSpendError(error: SpendError): number {
  if (error instanceof HostDecisionError) {
    return error.status;
  }
  if (/not found/i.test(error.message)) {
    return 404;
  }
  return 409;
}

export function hostDecisionErrorResponse(
  error: unknown,
  asHtml: boolean,
): Response {
  if (error instanceof SpendError) {
    const status = statusForSpendError(error);
    const code =
      error instanceof HostDecisionError ? error.code : "spend_error";
    return decisionResponse(
      { error: code, message: error.message },
      status,
      asHtml,
    );
  }
  return decisionResponse(
    {
      error: "internal_error",
      message: "Failed to apply spend decision.",
    },
    500,
    asHtml,
  );
}

export function wantsHtmlResult(request: Request): boolean {
  const accept = request.headers.get("accept") ?? "";
  if (accept.includes("application/json") && !accept.includes("text/html")) {
    return false;
  }
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return false;
  }
  if (
    contentType.includes("application/x-www-form-urlencoded") ||
    contentType.includes("multipart/form-data")
  ) {
    return true;
  }
  return accept.includes("text/html");
}

export function decisionResponse(
  data: unknown,
  status: number,
  asHtml: boolean,
): Response {
  if (!asHtml) {
    return new Response(JSON.stringify(data, null, 2), {
      status,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  }
  const payload = data as {
    error?: string;
    message?: string;
    status?: string;
    spendRequestId?: string;
    decidedBy?: string;
  };
  const ok = status < 400;
  const title = ok
    ? payload.status === "DENIED"
      ? "Denied"
      : "Approved"
    : "Decision failed";
  const detail = ok
    ? `Spend ${escapeHtml(payload.spendRequestId ?? "")} is now <strong>${escapeHtml(payload.status ?? "")}</strong>. decidedBy is recorded as <code>oob-assertion</code> (never a body string).`
    : escapeHtml(payload.message ?? "Request failed.");
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Money Bot — ${escapeHtml(title)}</title>
  <style>
    body { font-family: ui-sans-serif, system-ui, sans-serif; margin: 2rem; color: #111; }
    .card { max-width: 40rem; border: 1px solid #d4d4d4; border-radius: 8px; padding: 1.25rem 1.5rem; }
    .ok { border-color: #16a34a; }
    .bad { border-color: #dc2626; }
    code { font-size: 0.9em; }
  </style>
</head>
<body>
  <div class="card ${ok ? "ok" : "bad"}">
    <h1>${escapeHtml(title)}</h1>
    <p>${detail}</p>
    <p>This is <strong>local HMAC-signed browser Approve</strong>, not passkey/WebAuthn.</p>
  </div>
</body>
</html>`;
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export async function handleSpendDecision(
  request: Request,
  env: Env,
): Promise<Response> {
  const asHtml = wantsHtmlResult(request);
  try {
    const token = await extractAssertionToken(request);
    const claims = await verifyApprovalAssertion(
      env.APPROVAL_HMAC_SECRET,
      token,
    );
    const store = spendStoreForTenant(env, claims.tenantId);
    const result = await store.applyHostDecision(
      claims.spendRequestId,
      claims.tenantId,
      claims.decision,
      {
        assertionVerified: true,
        jti: claims.jti,
        lockedCartFingerprint: claims.lockedCartFingerprint,
      },
    );
    if (!result.ok) {
      if (/fingerprint/i.test(result.error)) {
        throw new HostDecisionError(
          result.error,
          409,
          "fingerprint_mismatch",
        );
      }
      if (/jti has already been used/i.test(result.error)) {
        throw new HostDecisionError(result.error, 409, "replayed_jti");
      }
      throw new SpendError(result.error);
    }
    const updated = result.value;
    return decisionResponse(
      {
        spendRequestId: updated.spendRequestId,
        status: updated.status,
        decidedBy: updated.decidedBy,
        decidedAt: updated.decidedAt,
        lockedCart: updated.lockedCart,
        lockedCartFingerprint: updated.lockedCartFingerprint,
      },
      200,
      asHtml,
    );
  } catch (error) {
    return hostDecisionErrorResponse(error, asHtml);
  }
}
