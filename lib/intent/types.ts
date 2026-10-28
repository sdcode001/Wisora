import { z } from "zod";
import { CategorySchema } from "../../config/sources";

export const BudgetSchema = z.object({
  min: z.number().nonnegative().optional(),
  max: z.number().positive().optional(),
});
export type Budget = z.infer<typeof BudgetSchema>;

export const ConfidenceSchema = z.enum(["high", "medium", "low"]);
export type Confidence = z.infer<typeof ConfidenceSchema>;

export const IntentSchema = z.object({
  query: z.string(),
  category: CategorySchema,
  categoryConfidence: ConfidenceSchema,
  budgetInr: BudgetSchema.optional(),
  searchTerms: z.string(),
});
export type Intent = z.infer<typeof IntentSchema>;
