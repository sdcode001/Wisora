import { createHash } from "node:crypto";
import { z } from "zod";

export const PriceEvidenceSchema = z.enum(["repeated", "single"]);
export type PriceEvidence = z.infer<typeof PriceEvidenceSchema>;

export const ProductSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  url: z.string().url(),
  sourceId: z.string().min(1),
  merchant: z.string().min(1),
  snippet: z.string().default(""),
  score: z.number().default(0),
  priceInr: z.number().positive().optional(),
  priceEvidence: PriceEvidenceSchema.optional(),
  priceSeenAt: z.string().optional(),
  imageUrl: z.string().url().optional(),
  rating: z
    .object({
      value: z.number().min(0).max(5),
      count: z.number().int().nonnegative().optional(),
      seenAt: z.string(),
    })
    .optional(),
  retrievedAt: z.string(),
});
export type Product = z.infer<typeof ProductSchema>;

export function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    const asin = /\/(?:dp|gp\/product)\/([A-Z0-9]{10})/.exec(parsed.pathname);
    if (asin?.[1]) {
      return `${parsed.hostname.toLowerCase()}/dp/${asin[1]}`;
    }
    for (const key of [...parsed.searchParams.keys()]) {
      if (/^(utm_|ref|ref_|psc|tag|linkCode|smid|th|crid|keywords|qid|sr|sprefix)/i.test(key)) {
        parsed.searchParams.delete(key);
      }
    }
    return `${parsed.hostname.toLowerCase()}${parsed.pathname}${parsed.search}`;
  } catch {
    return url.trim().toLowerCase();
  }
}

export function productIdFor(url: string): string {
  return createHash("sha256").update(normalizeUrl(url)).digest("hex").slice(0, 16);
}
