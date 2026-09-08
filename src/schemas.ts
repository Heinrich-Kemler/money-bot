import { z } from "zod";
import { ALLOWED_CURRENCIES } from "./region.ts";

const httpsUrl = z
  .string()
  .url()
  .refine((value) => value.startsWith("https://"), {
    message: "URL must use https://",
  });

export const lineItemSchema = z.object({
  name: z.string().min(1).max(200),
  quantity: z.number().int().positive(),
  unitAmount: z.number().positive().finite(),
});

export const shippingSchema = z.object({
  name: z.string().max(200).optional(),
  line1: z.string().max(300).optional(),
  city: z.string().max(120).optional(),
  postalCode: z.string().max(32).optional(),
  country: z.string().max(2).optional(),
});

export const requestSpendInputSchema = z.object({
  merchantName: z.string().min(1).max(200),
  merchantUrl: httpsUrl,
  amount: z.number().positive().finite(),
  currency: z.enum(ALLOWED_CURRENCIES).default("GBP"),
  checkoutUrl: httpsUrl,
  description: z.string().max(2000).optional(),
  lineItems: z.array(lineItemSchema).max(50).optional(),
  shipping: shippingSchema.optional(),
  spendCap: z.number().positive().finite().optional(),
  /** Explicit same-merchantDomain lock to cancel. Cross-domain supersedes are rejected. */
  supersedes: z.string().min(1).max(128).optional(),
});

export const getSpendStatusInputSchema = z.object({
  spendRequestId: z.string().min(1),
});

export const prepareCheckoutHandoffInputSchema = z.object({
  spendRequestId: z.string().min(1),
});

export type RequestSpendInput = z.infer<typeof requestSpendInputSchema>;
export type GetSpendStatusInput = z.infer<typeof getSpendStatusInputSchema>;
export type PrepareCheckoutHandoffInput = z.infer<
  typeof prepareCheckoutHandoffInputSchema
>;
