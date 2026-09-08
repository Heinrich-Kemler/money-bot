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

const PAN_LIKE = /\b(?:\d[ -]*?){13,19}\b/g;

function isBlockedKey(key: string): boolean {
  return BLOCKED_KEYS.has(key.toLowerCase().replace(/[\s-]/g, ""));
}

export function redactPaymentSecrets<T>(value: T): T {
  return redact(value) as T;
}

function redact(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replace(PAN_LIKE, "[REDACTED]");
  }
  if (Array.isArray(value)) {
    return value.map(redact);
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (isBlockedKey(key)) {
        continue;
      }
      out[key] = redact(nested);
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
    content: [{ type: "text", text: redactPaymentSecrets(message) }],
    isError: true,
  };
}
