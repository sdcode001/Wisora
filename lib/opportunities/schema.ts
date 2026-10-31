import { z } from "zod";
import { CategorySchema, type Category } from "../../config/sources";

/**
 * Opportunity kinds detected from verified price observations and watch
 * check statuses. Each kind maps to one human-readable feed card.
 * Availability kinds carry no prices — the event is the signal.
 */
export const OpportunityKindSchema = z.enum([
  "target-reached",
  "price-drop",
  "price-increase",
  "back-in-range",
  "restored",
  "unavailable",
  "reminder-due",
]);
export type OpportunityKind = z.infer<typeof OpportunityKindSchema>;

export const OpportunityStatusSchema = z.enum([
  "active",
  "read",
  "dismissed",
]);
export type OpportunityStatus = z.infer<typeof OpportunityStatusSchema>;

/**
 * Personalization snapshot stamped at creation so feed order stays stable
 * even when preferences change later. Scored by lib/opportunities/relevance.
 */
export const RelevanceSchema = z.object({
  score: z.number().min(0).max(100),
  reasons: z.array(z.string().max(200)).max(10),
});
export type OpportunityRelevance = z.infer<typeof RelevanceSchema>;

const PriceEvidenceSchema = z.object({
  source: z.enum(["search", "watch-check", "reminder"]),
  /** Newest-first observation timestamps backing this opportunity. */
  observedAt: z.string().min(1),
  previousObservedAt: z.string().min(1).optional(),
});
export type OpportunityEvidence = z.infer<typeof PriceEvidenceSchema>;

export const OpportunitySchema = z.object({
  id: z.string().min(1).max(64),
  createdAt: z.string().min(1),
  kind: OpportunityKindSchema,
  status: OpportunityStatusSchema,
  /**
   * Stable identity for dedupe: same kind + product + price state never
   * creates a second opportunity, even across dismissed ones.
   */
  dedupeKey: z.string().min(1).max(200),
  watchId: z.string().min(1).max(64).optional(),
  /** Best-effort category resolved from decisions/comparisons; absent when unknown. */
  category: CategorySchema.optional(),
  relevance: RelevanceSchema.optional(),
  productId: z.string().min(1).max(64),
  title: z.string().min(1).max(500),
  merchant: z.string().min(1).max(120),
  url: z.string().url().max(2000),
  imageUrl: z.string().url().max(2000).optional(),
  currentPriceInr: z.number().positive().max(100_000_000).nullable(),
  previousPriceInr: z.number().positive().max(100_000_000).nullable(),
  targetPriceInr: z.number().positive().max(100_000_000).nullable(),
  /** Deterministic human sentence built by the detector. */
  reason: z.string().min(1).max(500),
  /** Prior decision on this product, when one exists (re-evaluation aid). */
  decisionContext: z.string().min(1).max(300).optional(),
  email: z
    .object({
      attempted: z.boolean(),
      sent: z.boolean(),
      error: z.string().max(300).optional(),
    })
    .optional(),
  evidence: PriceEvidenceSchema,
});
export type Opportunity = z.infer<typeof OpportunitySchema>;

/** Server-built opportunity input; the store stamps id/createdAt/status. */
export interface NewOpportunity {
  kind: OpportunityKind;
  dedupeKey: string;
  watchId?: string;
  category?: Category;
  relevance?: OpportunityRelevance;
  productId: string;
  title: string;
  merchant: string;
  url: string;
  imageUrl?: string;
  currentPriceInr: number | null;
  previousPriceInr: number | null;
  targetPriceInr: number | null;
  reason: string;
  decisionContext?: string;
  email?: { attempted: boolean; sent: boolean; error?: string };
  evidence: OpportunityEvidence;
}

/**
 * Build the dedupe key for a candidate opportunity. Price identity is the
 * rounded rupee value. Availability kinds key on kind + product; their
 * duplicate check is latest-state based (see below), so repeat outages
 * after a genuine restock still alert.
 */
export function buildDedupeKey(
  kind: OpportunityKind,
  productId: string,
  priceInr: number | null,
): string {
  if (priceInr == null) {
    return `${kind}:${productId}`;
  }
  return `${kind}:${productId}:${Math.round(priceInr)}`;
}

/**
 * True when an equivalent price opportunity already exists in any status —
 * dismissed ones included, so users are never re-alerted for the same
 * price state after explicitly dismissing it. Availability kinds must use
 * isAvailabilityDuplicate instead: a key-only check would suppress every
 * outage after the first one forever.
 */
export function isDuplicateOpportunity(
  existing: Opportunity[],
  dedupeKey: string,
): boolean {
  return existing.some((entry) => entry.dedupeKey === dedupeKey);
}

/**
 * True when the product's latest opportunity (newest-first list) already
 * reports the same availability state. A repeat outage after a restock
 * produces the opposite kind in between, so it correctly alerts again.
 */
export function isAvailabilityDuplicate(
  existingNewestFirst: Opportunity[],
  productId: string,
  kind: "restored" | "unavailable",
): boolean {
  return (
    existingNewestFirst.find((entry) => entry.productId === productId)
      ?.kind === kind
  );
}
