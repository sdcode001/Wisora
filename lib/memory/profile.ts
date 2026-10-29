import { z } from "zod";
import { CategorySchema, type Category } from "../../config/sources";

/**
 * How a stored preference value came to be. Only user-approved data is
 * ever stored: "inferred" means a user-approved inference, never a silent
 * guess. Pending (unapproved) proposals live outside the profile.
 */
export const ProvenanceSchema = z.enum(["explicit", "confirmed", "inferred"]);
export type Provenance = z.infer<typeof ProvenanceSchema>;

/**
 * Key prefix marking requirements injected from the user's saved profile
 * (as opposed to the current request). Scoring and the UI use it for
 * attribution; matching itself only sees the requirement label.
 */
export const PROFILE_KEY_PREFIX = "profile:";

export const DecisionPrioritySchema = z.enum([
  "lowest-price",
  "best-value",
  "performance",
  "durability",
  "premium",
]);
export type DecisionPriority = z.infer<typeof DecisionPrioritySchema>;

const brandField = z.string().trim().min(1).max(60);
const merchantField = z.string().trim().min(1).max(60);
const useCaseField = z.string().trim().min(1).max(120);
const notesField = z.string().trim().min(1).max(500);
const nameListField = z.array(z.string().trim().min(1).max(60)).max(30);
const sizeListField = z.array(z.string().trim().min(1).max(20)).max(20);

export const GeneralPreferencesSchema = z.object({
  currency: z.string().regex(/^[A-Z]{3}$/, "currency must be a 3-letter code"),
  locale: z.string().trim().min(2).max(20),
  categories: z.array(CategorySchema).max(10),
  preferredBrands: z.array(brandField).max(50),
  avoidedBrands: z.array(brandField).max(50),
  preferredMerchants: z.array(merchantField).max(20),
  decisionPriority: DecisionPrioritySchema.optional(),
});
export type GeneralPreferences = z.infer<typeof GeneralPreferencesSchema>;

/**
 * Partial update for the general section: absent fields are kept,
 * explicit null resets a field to its default, arrays replace wholesale.
 */
export const GeneralPreferencesPatchSchema = z.object({
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/, "currency must be a 3-letter code")
    .nullable()
    .optional(),
  locale: z.string().trim().min(2).max(20).nullable().optional(),
  categories: z.array(CategorySchema).max(10).nullable().optional(),
  preferredBrands: z.array(brandField).max(50).nullable().optional(),
  avoidedBrands: z.array(brandField).max(50).nullable().optional(),
  preferredMerchants: z.array(merchantField).max(20).nullable().optional(),
  decisionPriority: DecisionPrioritySchema.nullable().optional(),
});
export type GeneralPreferencesPatch = z.infer<
  typeof GeneralPreferencesPatchSchema
>;

export function defaultGeneralPreferences(): GeneralPreferences {
  return {
    currency: "INR",
    locale: "en-IN",
    categories: [],
    preferredBrands: [],
    avoidedBrands: [],
    preferredMerchants: [],
  };
}

export const BudgetRangeSchema = z
  .object({
    min: z.number().nonnegative().max(100_000_000).optional(),
    max: z.number().positive().max(100_000_000).optional(),
  })
  .refine(
    (budget) =>
      budget.min === undefined ||
      budget.max === undefined ||
      budget.min <= budget.max,
    { message: "budget min must not exceed max" },
  );
export type BudgetRange = z.infer<typeof BudgetRangeSchema>;

// --- Category schemas. Each category has independent settings; add a new
// --- stored/patch pair plus a parseCategoryPatch case to extend.

export const ElectronicsPreferencesSchema = z.object({
  category: z.literal("electronics"),
  budgetInr: BudgetRangeSchema.optional(),
  useCase: useCaseField.optional(),
  performanceLevel: z
    .enum(["basic", "balanced", "high", "workstation"])
    .optional(),
  minRamGb: z.number().positive().max(512).optional(),
  minStorageGb: z.number().positive().max(65536).optional(),
  batteryPriority: z.number().min(0).max(1).optional(),
  portability: z.enum(["desk", "balanced", "ultralight"]).optional(),
  warrantyPriority: z.number().min(0).max(1).optional(),
  notes: notesField.optional(),
});

export const ElectronicsPreferencesPatchSchema = z.object({
  budgetInr: BudgetRangeSchema.nullable().optional(),
  useCase: useCaseField.nullable().optional(),
  performanceLevel: z
    .enum(["basic", "balanced", "high", "workstation"])
    .nullable()
    .optional(),
  minRamGb: z.number().positive().max(512).nullable().optional(),
  minStorageGb: z.number().positive().max(65536).nullable().optional(),
  batteryPriority: z.number().min(0).max(1).nullable().optional(),
  portability: z.enum(["desk", "balanced", "ultralight"]).nullable().optional(),
  warrantyPriority: z.number().min(0).max(1).nullable().optional(),
  notes: notesField.nullable().optional(),
});

export const FashionPreferencesSchema = z.object({
  category: z.literal("fashion"),
  budgetInr: BudgetRangeSchema.optional(),
  sizes: sizeListField.optional(),
  styles: nameListField.optional(),
  materials: nameListField.optional(),
  notes: notesField.optional(),
});

export const FashionPreferencesPatchSchema = z.object({
  budgetInr: BudgetRangeSchema.nullable().optional(),
  sizes: sizeListField.nullable().optional(),
  styles: nameListField.nullable().optional(),
  materials: nameListField.nullable().optional(),
  notes: notesField.nullable().optional(),
});

export const FootwearPreferencesSchema = z.object({
  category: z.literal("footwear"),
  budgetInr: BudgetRangeSchema.optional(),
  sizes: sizeListField.optional(),
  useCase: useCaseField.optional(),
  notes: notesField.optional(),
});

export const FootwearPreferencesPatchSchema = z.object({
  budgetInr: BudgetRangeSchema.nullable().optional(),
  sizes: sizeListField.nullable().optional(),
  useCase: useCaseField.nullable().optional(),
  notes: notesField.nullable().optional(),
});

export const BeautyPreferencesSchema = z.object({
  category: z.literal("beauty"),
  budgetInr: BudgetRangeSchema.optional(),
  concerns: nameListField.optional(),
  notes: notesField.optional(),
});

export const BeautyPreferencesPatchSchema = z.object({
  budgetInr: BudgetRangeSchema.nullable().optional(),
  concerns: nameListField.nullable().optional(),
  notes: notesField.nullable().optional(),
});

export const HomeKitchenPreferencesSchema = z.object({
  category: z.literal("home-kitchen"),
  budgetInr: BudgetRangeSchema.optional(),
  useCase: useCaseField.optional(),
  notes: notesField.optional(),
});

export const HomeKitchenPreferencesPatchSchema = z.object({
  budgetInr: BudgetRangeSchema.nullable().optional(),
  useCase: useCaseField.nullable().optional(),
  notes: notesField.nullable().optional(),
});

export const GeneralCategoryPreferencesSchema = z.object({
  category: z.literal("general"),
  budgetInr: BudgetRangeSchema.optional(),
  notes: notesField.optional(),
});

export const GeneralCategoryPreferencesPatchSchema = z.object({
  budgetInr: BudgetRangeSchema.nullable().optional(),
  notes: notesField.nullable().optional(),
});

export const CategoryPreferencesSchema = z.discriminatedUnion("category", [
  ElectronicsPreferencesSchema,
  FashionPreferencesSchema,
  FootwearPreferencesSchema,
  BeautyPreferencesSchema,
  HomeKitchenPreferencesSchema,
  GeneralCategoryPreferencesSchema,
]);
export type CategoryPreferences = z.infer<typeof CategoryPreferencesSchema>;

export type CategoryPreferencesPatch =
  | z.infer<typeof ElectronicsPreferencesPatchSchema>
  | z.infer<typeof FashionPreferencesPatchSchema>
  | z.infer<typeof FootwearPreferencesPatchSchema>
  | z.infer<typeof BeautyPreferencesPatchSchema>
  | z.infer<typeof HomeKitchenPreferencesPatchSchema>
  | z.infer<typeof GeneralCategoryPreferencesPatchSchema>;

/** Validate a category PATCH body against that category's schema. */
export function parseCategoryPatch(category: Category, body: unknown) {
  switch (category) {
    case "electronics":
      return ElectronicsPreferencesPatchSchema.safeParse(body);
    case "fashion":
      return FashionPreferencesPatchSchema.safeParse(body);
    case "footwear":
      return FootwearPreferencesPatchSchema.safeParse(body);
    case "beauty":
      return BeautyPreferencesPatchSchema.safeParse(body);
    case "home-kitchen":
      return HomeKitchenPreferencesPatchSchema.safeParse(body);
    case "general":
      return GeneralCategoryPreferencesPatchSchema.safeParse(body);
  }
}

export const StoredGeneralPreferencesSchema = z.object({
  value: GeneralPreferencesSchema,
  updatedAt: z.string().min(1),
  provenance: ProvenanceSchema,
});
export type StoredGeneralPreferences = z.infer<
  typeof StoredGeneralPreferencesSchema
>;

export const StoredCategoryPreferencesSchema = z.object({
  value: CategoryPreferencesSchema,
  updatedAt: z.string().min(1),
  provenance: ProvenanceSchema,
});
export type StoredCategoryPreferences = z.infer<
  typeof StoredCategoryPreferencesSchema
>;

export const CategoryPreferenceMapSchema = z.object({
  electronics: StoredCategoryPreferencesSchema.optional(),
  fashion: StoredCategoryPreferencesSchema.optional(),
  footwear: StoredCategoryPreferencesSchema.optional(),
  beauty: StoredCategoryPreferencesSchema.optional(),
  "home-kitchen": StoredCategoryPreferencesSchema.optional(),
  general: StoredCategoryPreferencesSchema.optional(),
});
export type CategoryPreferenceMap = z.infer<typeof CategoryPreferenceMapSchema>;

export const UserProfileSchema = z.object({
  version: z.literal(1),
  userSub: z.string().min(1),
  general: StoredGeneralPreferencesSchema,
  categories: CategoryPreferenceMapSchema,
});
export type UserProfile = z.infer<typeof UserProfileSchema>;

/**
 * A fresh profile for first write. The general section starts at neutral
 * defaults (no brand claims, app-locale currency) stamped with the write's
 * own provenance — empty defaults assert nothing about the user.
 */
export function createDefaultProfile(
  userSub: string,
  meta: { updatedAt?: string; provenance?: Provenance } = {},
): UserProfile {
  return {
    version: 1,
    userSub,
    general: {
      value: defaultGeneralPreferences(),
      updatedAt: meta.updatedAt ?? new Date().toISOString(),
      provenance: meta.provenance ?? "explicit",
    },
    categories: {},
  };
}

/** Merge a general PATCH: absent keeps, null resets to default. */
export function applyGeneralPatch(
  current: GeneralPreferences,
  patch: GeneralPreferencesPatch,
): GeneralPreferences {
  const next: Record<string, unknown> = { ...current };
  const defaults = defaultGeneralPreferences() as Record<string, unknown>;
  for (const [key, value] of Object.entries(
    patch as Record<string, unknown>,
  )) {
    if (value === undefined) {
      continue;
    }
    next[key] = value === null ? defaults[key] : value;
  }
  return GeneralPreferencesSchema.parse(next);
}

/**
 * Merge a category PATCH: absent keeps, null removes the field, arrays
 * replace wholesale. A stored section for a different category is never
 * reused — each category keeps independent settings.
 */
export function applyCategoryPatch(
  current: CategoryPreferences | undefined,
  category: Category,
  patch: CategoryPreferencesPatch,
): CategoryPreferences {
  const base: Record<string, unknown> =
    current && current.category === category ? { ...current } : {};
  for (const [key, value] of Object.entries(
    patch as Record<string, unknown>,
  )) {
    if (value === undefined || value === null) {
      delete base[key];
    } else {
      base[key] = value;
    }
  }
  base.category = category;
  return CategoryPreferencesSchema.parse(base);
}
