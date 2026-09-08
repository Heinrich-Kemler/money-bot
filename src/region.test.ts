import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SpendError } from "./errors.ts";
import { createPendingSpendRequest } from "./logic.ts";
import { requestSpendInputSchema } from "./schemas.ts";
import {
  ALLOWED_CURRENCIES,
  assertUkEuMerchant,
  isUkEuMerchantDomain,
} from "./region.ts";

/**
 * Policy (v0 region heuristic, not a legal geo check):
 * - Currencies: GBP | EUR | PLN only. No USD / CZK / other global FX.
 * - Merchant host must match UK_EU_PUBLIC_SUFFIXES (already includes `.pl`).
 * - PLN is allowed on any allowlisted UK/EU suffix (Allegro `.pl`, and e.g. `.de`).
 * - PLN (or GBP/EUR) on a clearly non-UK/EU host (`.com`) is rejected.
 */
describe("UK/EU + PLN region heuristic", () => {
  it("allowlist is GBP, EUR, PLN", () => {
    assert.deepEqual([...ALLOWED_CURRENCIES], ["GBP", "EUR", "PLN"]);
  });

  it("treats .pl as a UK/EU public suffix", () => {
    assert.equal(isUkEuMerchantDomain("allegro.pl"), true);
    assert.equal(isUkEuMerchantDomain("shop.example.pl"), true);
    assert.equal(isUkEuMerchantDomain("example.co.uk"), true);
    assert.equal(isUkEuMerchantDomain("shop.example.com"), false);
  });

  it("accepts GBP on .co.uk and PLN/EUR on .pl", () => {
    assert.doesNotThrow(() =>
      assertUkEuMerchant("https://shop.example.co.uk", "GBP"),
    );
    assert.doesNotThrow(() =>
      assertUkEuMerchant("https://allegro.pl", "PLN"),
    );
    assert.doesNotThrow(() =>
      assertUkEuMerchant("https://shop.example.pl", "PLN"),
    );
    assert.doesNotThrow(() =>
      assertUkEuMerchant("https://allegro.pl", "EUR"),
    );
    assert.doesNotThrow(() =>
      assertUkEuMerchant("https://shop.example.de", "PLN"),
    );
  });

  it("rejects currencies outside GBP|EUR|PLN even on .pl", () => {
    assert.throws(
      () => assertUkEuMerchant("https://allegro.pl", "USD"),
      (error: unknown) =>
        error instanceof SpendError &&
        /Unsupported currency "USD"/.test(error.message) &&
        /GBP, EUR, or PLN/.test(error.message),
    );
    assert.throws(
      () => assertUkEuMerchant("https://allegro.pl", "CZK"),
      (error: unknown) =>
        error instanceof SpendError && /Unsupported currency/.test(error.message),
    );
  });

  it("rejects PLN on a clearly non-UK/EU domain", () => {
    assert.throws(
      () => assertUkEuMerchant("https://shop.example.com", "PLN"),
      (error: unknown) =>
        error instanceof SpendError &&
        /Unsupported merchant domain "shop.example.com"/.test(error.message),
    );
  });

  it("request_spend schema accepts PLN and rejects USD", () => {
    const pln = requestSpendInputSchema.parse({
      merchantName: "Allegro",
      merchantUrl: "https://allegro.pl",
      amount: 49.99,
      currency: "PLN",
      checkoutUrl: "https://allegro.pl/checkout",
    });
    assert.equal(pln.currency, "PLN");
    assert.throws(() =>
      requestSpendInputSchema.parse({
        merchantName: "US Shop",
        merchantUrl: "https://shop.example.com",
        amount: 10,
        currency: "USD",
        checkoutUrl: "https://shop.example.com/checkout",
      }),
    );
  });

  it("locks an Allegro PLN cart through request_spend", () => {
    const created = createPendingSpendRequest(
      {
        merchantName: "Allegro",
        merchantUrl: "https://allegro.pl",
        amount: 49.99,
        currency: "PLN",
        checkoutUrl: "https://allegro.pl/checkout",
      },
      "user-1",
    );
    assert.equal(created.status, "PENDING");
    assert.equal(created.currency, "PLN");
    assert.equal(created.merchantDomain, "allegro.pl");
    assert.equal(created.lockedCart.checkoutUrl, "https://allegro.pl/checkout");
  });
});
