import { z } from "zod";
import { ReviewSourceTypeSchema } from "../../config/review-sources";

export const RelevanceSchema = z.enum([
  "exact",
  "likely",
  "uncertain",
  "irrelevant",
]);
export type Relevance = z.infer<typeof RelevanceSchema>;

export const ReviewRecordSchema = z.object({
  id: z.string().min(1),
  productId: z.string().min(1),
  url: z.string().url(),
  sourceId: z.string().min(1),
  sourceName: z.string().min(1),
  sourceType: ReviewSourceTypeSchema,
  title: z.string().default(""),
  excerpt: z.string().max(2000).default(""),
  contentSource: z.enum(["extract", "snippet"]).default("extract"),
  publishedAt: z.string().optional(),
  retrievedAt: z.string(),
  relevance: RelevanceSchema,
  duplicateOf: z.string().optional(),
});
export type ReviewRecord = z.infer<typeof ReviewRecordSchema>;

export const InsightSentimentSchema = z.enum([
  "positive",
  "negative",
  "mixed",
]);
export type InsightSentiment = z.infer<typeof InsightSentimentSchema>;

export const InsightQualitySchema = z.enum([
  "strong",
  "moderate",
  "preliminary",
]);
export type InsightQuality = z.infer<typeof InsightQualitySchema>;

export const ReviewInsightSchema = z.object({
  theme: z.string().min(1).max(200),
  category: z.string().min(1).max(60),
  sentiment: InsightSentimentSchema,
  sources: z.array(z.string().min(1)).min(1).max(8),
  distinctSources: z.number().int().nonnegative(),
  excerpt: z.string().max(500).optional(),
  quality: InsightQualitySchema,
  limitations: z.array(z.string().max(300)).default([]),
});
export type ReviewInsight = z.infer<typeof ReviewInsightSchema>;

export const ContradictionSchema = z.object({
  topic: z.string().min(1).max(60),
  positiveSources: z.array(z.string().min(1)),
  negativeSources: z.array(z.string().min(1)),
  note: z.string().max(300),
});
export type Contradiction = z.infer<typeof ContradictionSchema>;

export const ReviewAdjustmentSchema = z.object({
  delta: z.number().int(),
  reasons: z.array(z.string().max(300)),
  unknownDimension: z.boolean(),
});
export type ReviewAdjustment = z.infer<typeof ReviewAdjustmentSchema>;

export const ReportQualitySchema = z.object({
  level: z.enum(["strong", "moderate", "weak", "insufficient"]),
  distinctSources: z.number().int().nonnegative(),
  exactMatches: z.number().int().nonnegative(),
});
export type ReportQuality = z.infer<typeof ReportQualitySchema>;

export const ProductReviewReportSchema = z.object({
  productId: z.string().min(1),
  records: z.array(ReviewRecordSchema),
  insights: z.array(ReviewInsightSchema),
  contradictions: z.array(ContradictionSchema),
  quality: ReportQualitySchema,
  adjustment: ReviewAdjustmentSchema,
  adjustedTotal: z.number().int().nullable(),
  limitations: z.array(z.string().max(300)),
  searchedAt: z.string(),
});
export type ProductReviewReport = z.infer<typeof ProductReviewReportSchema>;
