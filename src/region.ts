import { SpendError } from "./errors.ts";

export function merchantDomainFromUrl(url: string): string {
  const hostname = new URL(url).hostname.toLowerCase();
  return normalizeMerchantDomain(hostname);
}

/** Lowercase, strip leading www. Works on a bare host or a URL. */
export function normalizeMerchantDomain(domainOrUrl: string): string {
  const raw = domainOrUrl.trim().toLowerCase();
  const host = raw.includes("://") ? new URL(raw).hostname : raw;
  return host.startsWith("www.") ? host.slice(4) : host;
}

/**
 * v0 checkout currencies. Not a global FX list — pair with the UK/EU
 * public-suffix allowlist below. PLN is included for Allegro (.pl) and
 * other already-allowlisted EU merchants; USD and other currencies stay out.
 */
export const ALLOWED_CURRENCIES = ["GBP", "EUR", "PLN"] as const;
export type AllowedCurrency = (typeof ALLOWED_CURRENCIES)[number];

export function isAllowedCurrency(
  currency: string,
): currency is AllowedCurrency {
  return (ALLOWED_CURRENCIES as readonly string[]).includes(currency);
}

/**
 * Public suffixes treated as UK/EU for v0. Other regions are rejected
 * (Money Bot is not a global checkout agent). Includes `.pl`.
 */
export const UK_EU_PUBLIC_SUFFIXES = [
  "co.uk",
  "org.uk",
  "ac.uk",
  "gov.uk",
  "uk",
  "ie",
  "eu",
  "de",
  "fr",
  "es",
  "it",
  "nl",
  "be",
  "at",
  "pt",
  "pl",
  "se",
  "dk",
  "fi",
  "cz",
  "sk",
  "hu",
  "ro",
  "bg",
  "hr",
  "si",
  "lt",
  "lv",
  "ee",
  "lu",
  "mt",
  "cy",
  "gr",
] as const;

export function isUkEuMerchantDomain(domain: string): boolean {
  const host = domain.toLowerCase();
  return UK_EU_PUBLIC_SUFFIXES.some(
    (suffix) => host === suffix || host.endsWith(`.${suffix}`),
  );
}

export function assertUkEuMerchant(merchantUrl: string, currency: string): void {
  if (!isAllowedCurrency(currency)) {
    throw new SpendError(
      `Unsupported currency "${currency}". Money Bot v0 is UK/EU only (GBP, EUR, or PLN).`,
    );
  }
  const domain = merchantDomainFromUrl(merchantUrl);
  if (!isUkEuMerchantDomain(domain)) {
    throw new SpendError(
      `Unsupported merchant domain "${domain}". Money Bot v0 only supports UK/EU checkouts (GBP/EUR/PLN + UK/EU domain).`,
    );
  }
}

export function assertCheckoutUrlMatchesLock(
  checkoutUrl: string | undefined,
  merchantDomain: string,
): string {
  if (!checkoutUrl) {
    throw new SpendError(
      "checkoutUrl is required and must be https on the locked merchant domain.",
    );
  }
  if (!checkoutUrl.startsWith("https://")) {
    throw new SpendError("checkoutUrl must use https://.");
  }
  const host = merchantDomainFromUrl(checkoutUrl);
  if (host !== merchantDomain) {
    throw new SpendError(
      `checkoutUrl host "${host}" must match locked merchantDomain "${merchantDomain}".`,
    );
  }
  return checkoutUrl;
}
