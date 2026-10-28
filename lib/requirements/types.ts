import { z } from "zod";
import { CategorySchema, type Category } from "../../config/sources";

export const CATEGORY_LABELS: Record<Category, string> = {
  electronics: "Electronics",
  fashion: "Fashion",
  footwear: "Footwear",
  beauty: "Beauty & Skincare",
  "home-kitchen": "Home & Kitchen",
  general: "General",
};

export const RequirementKindSchema = z.enum(["must", "want", "exclude"]);
export type RequirementKind = z.infer<typeof RequirementKindSchema>;

export const RequirementSchema = z.object({
  key: z.string().min(1).max(60),
  label: z.string().min(1).max(120),
  kind: RequirementKindSchema,
  importance: z.number().min(0).max(1).default(0.5),
  evidence: z.string().max(300).optional(),
});
export type Requirement = z.infer<typeof RequirementSchema>;

export const RequirementSetSchema = z.object({
  category: CategorySchema,
  useContext: z.string().max(300).optional(),
  must: z.array(RequirementSchema).default([]),
  want: z.array(RequirementSchema).default([]),
  exclude: z.array(RequirementSchema).default([]),
  unanswered: z.array(z.string().max(300)).default([]),
});
export type RequirementSet = z.infer<typeof RequirementSetSchema>;

export const ClarificationQuestionSchema = z.object({
  id: z.string(),
  prompt: z.string(),
  options: z.array(z.string()).optional(),
  freeText: z.boolean(),
});
export type ClarificationQuestion = z.infer<
  typeof ClarificationQuestionSchema
>;

export const ClarificationAnswerSchema = z.object({
  questionId: z.string(),
  value: z.string().min(1).max(300),
});
export type ClarificationAnswer = z.infer<typeof ClarificationAnswerSchema>;
