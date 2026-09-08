const BLOCKED_KEYS = new Set([
  "pan",
  "cardnumber",
  "card_number",
  "card",
  "cvc",
  "cvv",
  "cid",
  "csc",
  "expiry",
  "exp",
  "exp_month",
  "exp_year",
  "expiration",
  "expirationdate",
  "expiration_date",
  "securitycode",
  "security_code",
  "pin",
  "track1",
  "track2",
  "fullpan",
]);

/** Do not run PAN regex on identifiers (order ids look numeric). */
const IDENTIFIER_KEYS = new Set([
  "orderid",
  "spendrequestid",
  "tenantid",
  "jti",
  "id",
  "supersededspendrequestid",
  "supersededbyspendrequestid",
]);

const DIGIT_RUN = /\b(?:\d[ -]*?){13,19}\b/g;

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[\s_-]/g, "");
}

function isBlockedKey(key: string): boolean {
  return BLOCKED_KEYS.has(normalizeKey(key));
}

function isIdentifierKey(key: string): boolean {
  return IDENTIFIER_KEYS.has(normalizeKey(key));
}

function luhnValid(digits: string): boolean {
  let sum = 0;
  let alternate = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let n = Number(digits[i]);
    if (Number.isNaN(n)) {
      return false;
    }
    if (alternate) {
      n *= 2;
      if (n > 9) {
        n -= 9;
      }
    }
    sum += n;
    alternate = !alternate;
  }
  return sum % 10 === 0;
}

function redactPanLike(value: string): string {
  return value.replace(DIGIT_RUN, (match) => {
    const digits = match.replace(/\D/g, "");
    return luhnValid(digits) ? "[REDACTED]" : match;
  });
}

export function redactPaymentSecrets<T>(value: T, keyHint = ""): T {
  return redact(value, keyHint) as T;
}

function redact(value: unknown, keyHint: string): unknown {
  if (typeof value === "string") {
    if (isIdentifierKey(keyHint)) {
      return value;
    }
    return redactPanLike(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redact(item, keyHint));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (isBlockedKey(key)) {
        continue;
      }
      out[key] = redact(nested, key);
    }
    return out;
  }
  return value;
}

export function jsonToolResult(payload: unknown): {
  content: [{ type: "text"; text: string }];
} {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(redactPaymentSecrets(payload), null, 2),
      },
    ],
  };
}

export function errorToolResult(message: string): {
  content: [{ type: "text"; text: string }];
  isError: true;
} {
  return {
    content: [{ type: "text", text: String(message) }],
    isError: true,
  };
}
