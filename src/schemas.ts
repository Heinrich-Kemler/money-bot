import { z } from "zod";

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
  currency: z.enum(["GBP", "EUR"]).default("GBP"),
  checkoutUrl: httpsUrl.optional(),
  description: z.string().max(2000).optional(),
  lineItems: z.array(lineItemSchema).max(50).optional(),
  shipping: shippingSchema.optional(),
  spendCap: z.number().positive().finite().optional(),
});

export const getSpendStatusInputSchema = z.object({
  spendRequestId: z.string().min(1),
});

export const prepareCheckoutHandoffInputSchema = z.object({
  spendRequestId: z.string().min(1),
});

export const devSetSpendDecisionInputSchema = z.object({
  spendRequestId: z.string().min(1),
  decision: z.enum(["approved", "denied"]),
  denyReason: z.string().max(500).optional(),
  decidedBy: z.string().max(200).optional(),
  orderId: z.string().max(200).optional(),
});

export const editSpendCapInputSchema = z.object({
  spendRequestId: z.string().min(1),
  spendCap: z.number().positive().finite(),
});

export const reportCheckoutOutcomeInputSchema = z.object({
  spendRequestId: z.string().min(1),
  outcome: z.enum(["PAID", "CHALLENGE", "FAILED"]),
  challengeKind: z
    .enum(["sca", "amex_safekey", "revolut_3ds", "other"])
    .optional(),
  orderId: z.string().max(200).optional(),
});

export type RequestSpendInput = z.infer<typeof requestSpendInputSchema>;
export type GetSpendStatusInput = z.infer<typeof getSpendStatusInputSchema>;
export type PrepareCheckoutHandoffInput = z.infer<
  typeof prepareCheckoutHandoffInputSchema
>;
export type DevSetSpendDecisionInput = z.infer<
  typeof devSetSpendDecisionInputSchema
>;
export type EditSpendCapInput = z.infer<typeof editSpendCapInputSchema>;
export type ReportCheckoutOutcomeInput = z.infer<
  typeof reportCheckoutOutcomeInputSchema
>;
