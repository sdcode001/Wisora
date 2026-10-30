import { z } from "zod";
import { PriceEvidenceSchema } from "../products/schema";

export const ObservationSourceSchema = z.enum(["search", "watch-check"]);
export type ObservationSource = z.infer<typeof ObservationSourceSchema>;

/**
 * One verified sighting of a product's selling price. Identity is the
 * normalized-URL hash, so re-checks of the same listing extend one history
 * and different variants never merge.
 */
export const PriceObservationSchema = z.object({
  productId: z.string().min(1).max(64),
  url: z.string().url().max(2000),
  title: z.string().min(1).max(300),
  merchant: z.string().min(1).max(120),
  sourceId: z.string().min(1).max(64),
  priceInr: z.number().positive().max(100_000_000),
  currency: z.literal("INR"),
  evidence: PriceEvidenceSchema,
  candidates: z.number().int().nonnegative(),
  observedAt: z.string().min(1),
  source: ObservationSourceSchema,
});
export type PriceObservation = z.infer<typeof PriceObservationSchema>;

export const CheckStatusSchema = z.enum([
  "ok",
  "no-price",
  "unavailable",
  "fetch-failed",
]);
export type CheckStatus = z.infer<typeof CheckStatusSchema>;

export const WatchCheckSchema = z.object({
  at: z.string().min(1),
  priceInr: z.number().positive().max(100_000_000).optional(),
  status: CheckStatusSchema,
  error: z.string().max(300).optional(),
});
export type WatchCheck = z.infer<typeof WatchCheckSchema>;

export const WatchSchema = z.object({
  id: z.string().min(1).max(64),
  createdAt: z.string().min(1),
  productId: z.string().min(1).max(64),
  url: z.string().url().max(2000),
  title: z.string().min(1).max(300),
  merchant: z.string().min(1).max(120),
  sourceId: z.string().min(1).max(64).optional(),
  variantLabel: z.string().max(200).optional(),
  targetPrice: z.number().positive().max(100_000_000),
  currency: z.literal("INR"),
  active: z.boolean(),
  canWait: z.boolean(),
  notifyEmail: z.string().email().max(320).nullable().optional(),
  lastCheck: WatchCheckSchema.optional(),
  lastAlertAt: z.string().min(1).optional(),
  lastAlertedPrice: z.number().positive().optional(),
});
export type Watch = z.infer<typeof WatchSchema>;

export const NewWatchSchema = WatchSchema.omit({
  id: true,
  createdAt: true,
  lastCheck: true,
  lastAlertAt: true,
  lastAlertedPrice: true,
}).extend({
  currency: z.literal("INR").default("INR"),
  active: z.boolean().default(true),
  canWait: z.boolean().default(true),
});
export type NewWatch = z.infer<typeof NewWatchSchema>;

export const WatchUpdateSchema = z.object({
  id: z.string().min(1).max(64),
  targetPrice: z.number().positive().max(100_000_000).optional(),
  active: z.boolean().optional(),
  canWait: z.boolean().optional(),
  notifyEmail: z.string().email().max(320).nullable().optional(),
  variantLabel: z.string().max(200).nullable().optional(),
});
export type WatchUpdate = z.infer<typeof WatchUpdateSchema>;

export const PriceAlertSchema = z.object({
  id: z.string().min(1).max(64),
  createdAt: z.string().min(1),
  watchId: z.string().min(1).max(64),
  productId: z.string().min(1).max(64),
  title: z.string().min(1).max(300),
  merchant: z.string().min(1).max(120),
  url: z.string().url().max(2000),
  observedPrice: z.number().positive().max(100_000_000),
  targetPrice: z.number().positive().max(100_000_000),
  currency: z.literal("INR"),
  observedAt: z.string().min(1),
  read: z.boolean(),
  email: z
    .object({
      attempted: z.boolean(),
      sent: z.boolean(),
      error: z.string().max(300).optional(),
    })
    .optional(),
});
export type PriceAlert = z.infer<typeof PriceAlertSchema>;

/** Server-built alert input; the store stamps id/createdAt. */
export interface NewPriceAlert {
  watchId: string;
  productId: string;
  title: string;
  merchant: string;
  url: string;
  observedPrice: number;
  targetPrice: number;
  observedAt: string;
  email?: { attempted: boolean; sent: boolean; error?: string };
}
