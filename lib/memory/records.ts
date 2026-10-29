import { randomBytes } from "node:crypto";
import { z } from "zod";
import { CategorySchema } from "../../config/sources";
import { BudgetRangeSchema } from "./profile";

/** Storage-assigned identity for memory records. */
export function createRecordId(): string {
  return randomBytes(12).toString("hex");
}

const StoredIdentity = {
  id: z.string().min(1).max(64),
  createdAt: z.string().min(1),
};

export const VerdictSchema = z.enum([
  "BUY",
  "WAIT",
  "AVOID",
  "INSUFFICIENT_EVIDENCE",
  "NEEDS_CLARIFICATION",
]);
export type Verdict = z.infer<typeof VerdictSchema>;

// --- Decisions: snapshots of past recommendations. ---

export const DecisionTopPickSchema = z.object({
  productId: z.string().min(1).max(64),
  title: z.string().min(1).max(300),
  merchant: z.string().min(1).max(120),
  priceInr: z.number().nonnegative().max(100_000_000).optional(),
});
export type DecisionTopPick = z.infer<typeof DecisionTopPickSchema>;

export const DecisionRecordSchema = z.object({
  ...StoredIdentity,
  query: z.string().trim().min(2).max(500),
  category: CategorySchema,
  budgetInr: BudgetRangeSchema.optional(),
  topPick: DecisionTopPickSchema.nullable(),
  verdict: VerdictSchema,
  personalizationApplied: z.array(z.string().max(300)).max(20).optional(),
});
export type DecisionRecord = z.infer<typeof DecisionRecordSchema>;

export const NewDecisionRecordSchema = DecisionRecordSchema.omit({
  id: true,
  createdAt: true,
});
export type NewDecisionRecord = z.infer<typeof NewDecisionRecordSchema>;

// --- Saved products: explicit keepsakes, keyed by productId (re-save upserts). ---

export const SavedProductSchema = z.object({
  productId: z.string().min(1).max(64),
  title: z.string().min(1).max(300),
  url: z.string().url().max(2000),
  merchant: z.string().min(1).max(120),
  priceInr: z.number().nonnegative().max(100_000_000).optional(),
  imageUrl: z.string().url().max(2000).optional(),
  note: z.string().trim().min(1).max(300).optional(),
  savedAt: z.string().min(1),
  sourceDecisionId: z.string().min(1).max(64).optional(),
});
export type SavedProduct = z.infer<typeof SavedProductSchema>;

export const NewSavedProductSchema = SavedProductSchema.omit({ savedAt: true });
export type NewSavedProduct = z.infer<typeof NewSavedProductSchema>;

// --- Saved comparisons: self-contained product sets (2–6 snapshots). ---

export const ComparisonProductSchema = z.object({
  productId: z.string().min(1).max(64),
  title: z.string().min(1).max(300),
  merchant: z.string().min(1).max(120),
  priceInr: z.number().nonnegative().max(100_000_000).optional(),
  url: z.string().url().max(2000).optional(),
});
export type ComparisonProduct = z.infer<typeof ComparisonProductSchema>;

export const SavedComparisonSchema = z.object({
  ...StoredIdentity,
  category: CategorySchema,
  query: z.string().trim().min(1).max(500).optional(),
  products: z.array(ComparisonProductSchema).min(2).max(6),
  note: z.string().trim().min(1).max(500).optional(),
});
export type SavedComparison = z.infer<typeof SavedComparisonSchema>;

export const NewSavedComparisonSchema = SavedComparisonSchema.omit({
  id: true,
  createdAt: true,
});
export type NewSavedComparison = z.infer<typeof NewSavedComparisonSchema>;

// --- Feedback: user reactions to recommendations. Product references carry
// --- their own snapshots so feedback stays interpretable without joins. ---

export const FeedbackProductSchema = z.object({
  productId: z.string().min(1).max(64),
  title: z.string().min(1).max(300),
  merchant: z.string().min(1).max(120).optional(),
});
export type FeedbackProduct = z.infer<typeof FeedbackProductSchema>;

const FeedbackBase = z.object({
  ...StoredIdentity,
  decisionId: z.string().min(1).max(64).nullable().optional(),
  helpful: z.boolean().nullable().optional(),
  preferred: FeedbackProductSchema.nullable().optional(),
  rejected: FeedbackProductSchema.nullable().optional(),
  rejectionReason: z.string().trim().min(1).max(500).optional(),
  purchased: FeedbackProductSchema.nullable().optional(),
  note: z.string().trim().min(1).max(500).optional(),
});

function hasSignal(value: {
  helpful?: boolean | null;
  preferred?: unknown;
  rejected?: unknown;
  purchased?: unknown;
  note?: string | null;
}): boolean {
  return (
    value.helpful != null ||
    value.preferred != null ||
    value.rejected != null ||
    value.purchased != null ||
    value.note != null
  );
}

export const FeedbackSchema = FeedbackBase.refine(hasSignal, {
  message: "feedback must include at least one signal",
});
export type Feedback = z.infer<typeof FeedbackSchema>;

export const NewFeedbackSchema = FeedbackBase.omit({
  id: true,
  createdAt: true,
}).refine(hasSignal, {
  message: "feedback must include at least one signal",
});
export type NewFeedback = z.infer<typeof NewFeedbackSchema>;
