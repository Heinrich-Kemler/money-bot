import { HostDecisionError } from "./errors.ts";
import {
  DECISIONS,
  WIDGET_DECISIONS,
  type SpendDecision,
  type WidgetDecision,
} from "./types.ts";

export const OOB_ISS = "money-bot-oob";
export const WIDGET_ISS = "grokbot-widget";
export const OOB_AUD = "money-bot";
export const ASSERTION_TTL_SECONDS = 10 * 60;
export const CLOCK_SKEW_SECONDS = 30;
export const MIN_HMAC_SECRET_LENGTH = 16;

export type AssertionIssuer = typeof OOB_ISS | typeof WIDGET_ISS;

export type ApprovalClaims = {
  iss: AssertionIssuer;
  aud: typeof OOB_AUD;
  exp: number;
  iat: number;
  jti: string;
  spendRequestId: string;
  tenantId: string;
  decision: SpendDecision | "keep_looking";
  lockedCartFingerprint: string;
};

const HMAC_PREFIX = "mb1.";

function textEncode(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const pad = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
  const binary = atob(padded + pad);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a[i]! ^ b[i]!;
  }
  return diff === 0;
}

/** Constant-time string compare (length mismatch still returns false). */
export function timingSafeEqualString(a: string, b: string): boolean {
  const left = textEncode(a);
  const right = textEncode(b);
  const max = Math.max(left.length, right.length, 1);
  const leftPad = new Uint8Array(max);
  const rightPad = new Uint8Array(max);
  leftPad.set(left);
  rightPad.set(right);
  return timingSafeEqual(leftPad, rightPad) && left.length === right.length;
}

export function requireApprovalSecret(secret: string | undefined): string {
  const trimmed = secret?.trim() ?? "";
  if (trimmed.length < MIN_HMAC_SECRET_LENGTH) {
    throw new HostDecisionError(
      "APPROVAL_HMAC_SECRET is not configured (need a secret of at least 16 characters).",
      503,
      "missing_approval_secret",
    );
  }
  return trimmed;
}

async function hmacSha256(
  secret: string,
  data: string,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    textEncode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, textEncode(data));
  return new Uint8Array(sig);
}

export async function signApproveTicket(
  secret: string,
  spendRequestId: string,
  tenantId: string,
): Promise<string> {
  const mac = await hmacSha256(
    requireApprovalSecret(secret),
    `approve-ticket|${tenantId}|${spendRequestId}`,
  );
  return bytesToBase64Url(mac);
}

export async function verifyApproveTicket(
  secret: string,
  spendRequestId: string,
  tenantId: string,
  mac: string | undefined,
): Promise<void> {
  const expected = await signApproveTicket(secret, spendRequestId, tenantId);
  const provided = mac?.trim() ?? "";
  if (
    !provided ||
    !timingSafeEqual(textEncode(provided), textEncode(expected))
  ) {
    throw new HostDecisionError(
      "Invalid or missing approve URL mac.",
      403,
      "bad_approve_ticket",
    );
  }
}

function unixSeconds(at = new Date()): number {
  return Math.floor(at.getTime() / 1000);
}

function isSpendDecision(value: unknown): value is SpendDecision {
  return (
    typeof value === "string" &&
    (DECISIONS as readonly string[]).includes(value)
  );
}

function isWidgetDecision(value: unknown): value is WidgetDecision {
  return (
    typeof value === "string" &&
    (WIDGET_DECISIONS as readonly string[]).includes(value)
  );
}

export function isAssertionIssuer(value: unknown): value is AssertionIssuer {
  return value === OOB_ISS || value === WIDGET_ISS;
}

function parseClaims(raw: unknown, now = new Date()): ApprovalClaims {
  if (!raw || typeof raw !== "object") {
    throw new HostDecisionError(
      "Approval assertion claims are not an object.",
      401,
      "bad_assertion",
    );
  }
  const c = raw as Record<string, unknown>;
  const missing = [
    "iss",
    "aud",
    "exp",
    "iat",
    "jti",
    "spendRequestId",
    "tenantId",
    "decision",
    "lockedCartFingerprint",
  ].filter((key) => c[key] === undefined || c[key] === "");
  if (missing.length > 0) {
    throw new HostDecisionError(
      `Approval assertion missing claims: ${missing.join(", ")}.`,
      401,
      "bad_assertion",
    );
  }
  if (!isAssertionIssuer(c.iss)) {
    throw new HostDecisionError(
      `Approval assertion iss must be "${OOB_ISS}" or "${WIDGET_ISS}".`,
      401,
      "bad_assertion",
    );
  }
  if (c.aud !== OOB_AUD) {
    throw new HostDecisionError(
      `Approval assertion aud must be "${OOB_AUD}".`,
      401,
      "bad_assertion",
    );
  }
  if (typeof c.exp !== "number" || typeof c.iat !== "number") {
    throw new HostDecisionError(
      "Approval assertion exp/iat must be unix seconds.",
      401,
      "bad_assertion",
    );
  }
  if (
    typeof c.jti !== "string" ||
    typeof c.spendRequestId !== "string" ||
    typeof c.tenantId !== "string" ||
    typeof c.lockedCartFingerprint !== "string"
  ) {
    throw new HostDecisionError(
      "Approval assertion claim types are invalid.",
      401,
      "bad_assertion",
    );
  }
  if (c.tenantId === "anonymous") {
    throw new HostDecisionError(
      "Approval assertion tenantId cannot be anonymous.",
      401,
      "bad_assertion",
    );
  }
  let decision: SpendDecision | "keep_looking";
  if (c.iss === OOB_ISS) {
    if (!isSpendDecision(c.decision)) {
      throw new HostDecisionError(
        'Approval assertion decision must be "approved" or "denied".',
        401,
        "bad_assertion",
      );
    }
    decision = c.decision;
  } else if (!isWidgetDecision(c.decision)) {
    throw new HostDecisionError(
      'Widget assertion decision must be "approved", "denied", or "keep_looking".',
      401,
      "bad_assertion",
    );
  } else {
    decision = c.decision;
  }
  const nowSec = unixSeconds(now);
  if (c.exp + CLOCK_SKEW_SECONDS < nowSec) {
    throw new HostDecisionError(
      "Approval assertion has expired.",
      401,
      "expired_assertion",
    );
  }
  if (c.iat - CLOCK_SKEW_SECONDS > nowSec) {
    throw new HostDecisionError(
      "Approval assertion iat is in the future.",
      401,
      "bad_assertion",
    );
  }
  return {
    iss: c.iss,
    aud: OOB_AUD,
    exp: c.exp,
    iat: c.iat,
    jti: c.jti,
    spendRequestId: c.spendRequestId,
    tenantId: c.tenantId,
    decision,
    lockedCartFingerprint: c.lockedCartFingerprint,
  };
}

export function buildApprovalClaims(
  input: {
    spendRequestId: string;
    tenantId: string;
    decision: SpendDecision | "keep_looking";
    lockedCartFingerprint: string;
    ttlSeconds?: number;
    iss?: AssertionIssuer;
  },
  at = new Date(),
): ApprovalClaims {
  const iss = input.iss ?? OOB_ISS;
  if (iss === OOB_ISS && input.decision === "keep_looking") {
    throw new HostDecisionError(
      "OOB assertions cannot carry keep_looking; use iss=grokbot-widget.",
      400,
      "bad_assertion",
    );
  }
  const iat = unixSeconds(at);
  return {
    iss,
    aud: OOB_AUD,
    iat,
    exp: iat + (input.ttlSeconds ?? ASSERTION_TTL_SECONDS),
    jti: crypto.randomUUID(),
    spendRequestId: input.spendRequestId,
    tenantId: input.tenantId,
    decision: input.decision,
    lockedCartFingerprint: input.lockedCartFingerprint,
  };
}

export function buildWidgetApprovalClaims(
  input: {
    spendRequestId: string;
    tenantId: string;
    decision: WidgetDecision;
    lockedCartFingerprint: string;
    ttlSeconds?: number;
  },
  at = new Date(),
): ApprovalClaims {
  return buildApprovalClaims({ ...input, iss: WIDGET_ISS }, at);
}

export async function signApprovalJwt(
  secret: string,
  claims: ApprovalClaims,
): Promise<string> {
  const key = requireApprovalSecret(secret);
  const header = bytesToBase64Url(
    textEncode(JSON.stringify({ alg: "HS256", typ: "JWT" })),
  );
  const payload = bytesToBase64Url(textEncode(JSON.stringify(claims)));
  const signingInput = `${header}.${payload}`;
  const sig = await hmacSha256(key, signingInput);
  return `${signingInput}.${bytesToBase64Url(sig)}`;
}

export async function signApprovalHmac(
  secret: string,
  claims: ApprovalClaims,
): Promise<string> {
  const key = requireApprovalSecret(secret);
  const payload = bytesToBase64Url(textEncode(JSON.stringify(claims)));
  const sig = await hmacSha256(key, `${HMAC_PREFIX}${payload}`);
  return `${HMAC_PREFIX}${payload}.${bytesToBase64Url(sig)}`;
}

async function verifyMac(
  secret: string,
  signingInput: string,
  signatureB64: string,
): Promise<void> {
  const expected = await hmacSha256(secret, signingInput);
  let provided: Uint8Array;
  try {
    provided = base64UrlToBytes(signatureB64);
  } catch {
    throw new HostDecisionError(
      "Approval assertion signature is not valid base64url.",
      401,
      "bad_signature",
    );
  }
  if (!timingSafeEqual(expected, provided)) {
    throw new HostDecisionError(
      "Approval assertion signature is invalid.",
      401,
      "bad_signature",
    );
  }
}

async function verifyJwt(
  secret: string,
  token: string,
  now: Date,
): Promise<ApprovalClaims> {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
    throw new HostDecisionError(
      "Approval JWT is malformed.",
      401,
      "bad_assertion",
    );
  }
  let header: { alg?: string; typ?: string };
  try {
    header = JSON.parse(
      new TextDecoder().decode(base64UrlToBytes(parts[0])),
    ) as { alg?: string; typ?: string };
  } catch {
    throw new HostDecisionError(
      "Approval JWT header is malformed.",
      401,
      "bad_assertion",
    );
  }
  if (header.alg !== "HS256") {
    throw new HostDecisionError(
      "Approval JWT alg must be HS256.",
      401,
      "bad_signature",
    );
  }
  await verifyMac(secret, `${parts[0]}.${parts[1]}`, parts[2]);
  let payload: unknown;
  try {
    payload = JSON.parse(
      new TextDecoder().decode(base64UrlToBytes(parts[1])),
    );
  } catch {
    throw new HostDecisionError(
      "Approval JWT payload is malformed.",
      401,
      "bad_assertion",
    );
  }
  return parseClaims(payload, now);
}

async function verifyHmacCompact(
  secret: string,
  token: string,
  now: Date,
): Promise<ApprovalClaims> {
  const rest = token.slice(HMAC_PREFIX.length);
  const dot = rest.lastIndexOf(".");
  if (dot <= 0 || dot === rest.length - 1) {
    throw new HostDecisionError(
      "Approval HMAC assertion is malformed.",
      401,
      "bad_assertion",
    );
  }
  const payloadB64 = rest.slice(0, dot);
  const sigB64 = rest.slice(dot + 1);
  await verifyMac(secret, `${HMAC_PREFIX}${payloadB64}`, sigB64);
  let payload: unknown;
  try {
    payload = JSON.parse(
      new TextDecoder().decode(base64UrlToBytes(payloadB64)),
    );
  } catch {
    throw new HostDecisionError(
      "Approval HMAC payload is malformed.",
      401,
      "bad_assertion",
    );
  }
  return parseClaims(payload, now);
}

/**
 * Verify a signed OOB JWT (HS256) or compact HMAC (`mb1.<payload>.<mac>`).
 * Never treats an unsigned JSON body as an assertion.
 */
export async function verifyApprovalAssertion(
  secret: string | undefined,
  token: string | undefined,
  now = new Date(),
): Promise<ApprovalClaims> {
  const key = requireApprovalSecret(secret);
  const raw = token?.trim() ?? "";
  if (!raw) {
    throw new HostDecisionError(
      "Missing signed approval assertion.",
      401,
      "missing_assertion",
    );
  }
  if (raw.startsWith(HMAC_PREFIX)) {
    return verifyHmacCompact(key, raw, now);
  }
  return verifyJwt(key, raw, now);
}

export async function extractAssertionToken(
  request: Request,
): Promise<string | undefined> {
  const header = request.headers.get("Authorization") ?? "";
  const bearer = /^Bearer\s+(\S+)/i.exec(header)?.[1];
  if (bearer && !bearer.startsWith("test:")) {
    return bearer;
  }

  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const body: unknown = await request.json().catch(() => undefined);
    if (body && typeof body === "object") {
      const assertion = (body as { assertion?: unknown }).assertion;
      if (typeof assertion === "string" && assertion.trim()) {
        return assertion.trim();
      }
    }
    return undefined;
  }
  if (
    contentType.includes("application/x-www-form-urlencoded") ||
    contentType.includes("multipart/form-data")
  ) {
    const form = await request.formData();
    const assertion = form.get("assertion");
    if (typeof assertion === "string" && assertion.trim()) {
      return assertion.trim();
    }
  }
  return undefined;
}
