import { expect, test } from "vitest";
import {
  applyCategoryPatch,
  applyGeneralPatch,
  createDefaultProfile,
  defaultGeneralPreferences,
  parseCategoryPatch,
  UserProfileSchema,
} from "./profile";

test("default profile is a valid, neutral starting point", () => {
  const profile = createDefaultProfile("user-1", {
    updatedAt: "2026-01-01T00:00:00.000Z",
    provenance: "explicit",
  });
  expect(UserProfileSchema.safeParse(profile).success).toBe(true);
  expect(profile.general.value).toEqual({
    currency: "INR",
    locale: "en-IN",
    categories: [],
    preferredBrands: [],
    avoidedBrands: [],
    preferredMerchants: [],
  });
  expect(profile.categories).toEqual({});
});

test("default general preferences return fresh arrays per call", () => {
  const first = defaultGeneralPreferences();
  const second = defaultGeneralPreferences();
  first.preferredBrands.push("Sony");
  expect(second.preferredBrands).toEqual([]);
});

test("general patch sets fields and keeps the rest", () => {
  const merged = applyGeneralPatch(defaultGeneralPreferences(), {
    preferredBrands: ["Sony"],
    decisionPriority: "durability",
  });
  expect(merged.preferredBrands).toEqual(["Sony"]);
  expect(merged.decisionPriority).toBe("durability");
  expect(merged.currency).toBe("INR");
});

test("general patch replaces arrays wholesale and clears with null", () => {
  const current = {
    ...defaultGeneralPreferences(),
    preferredBrands: ["Sony", "Bose"],
    decisionPriority: "durability" as const,
  };
  const merged = applyGeneralPatch(current, {
    preferredBrands: ["Bose"],
    decisionPriority: null,
  });
  expect(merged.preferredBrands).toEqual(["Bose"]);
  expect(merged.decisionPriority).toBeUndefined();
});

test("category patch creates a new section", () => {
  const created = applyCategoryPatch(undefined, "electronics", {
    budgetInr: { max: 90000 },
    minRamGb: 16,
  });
  expect(created.category).toBe("electronics");
  expect(created).toMatchObject({ budgetInr: { max: 90000 }, minRamGb: 16 });
});

test("category patch merges, removes nulled fields, keeps the rest", () => {
  const created = applyCategoryPatch(undefined, "fashion", {
    sizes: ["M"],
    styles: ["casual"],
  });
  const merged = applyCategoryPatch(created, "fashion", {
    sizes: ["L"],
    styles: null,
  });
  expect(merged).toMatchObject({ category: "fashion", sizes: ["L"] });
  expect("styles" in merged).toBe(false);
});

test("category patch never reuses a section from another category", () => {
  const fashion = applyCategoryPatch(undefined, "fashion", { sizes: ["M"] });
  const merged = applyCategoryPatch(fashion, "electronics", { minRamGb: 8 });
  expect(merged.category).toBe("electronics");
  expect("sizes" in merged).toBe(false);
});

test("category patch rejects an inverted budget range", () => {
  const parsed = parseCategoryPatch("electronics", {
    budgetInr: { min: 90000, max: 50000 },
  });
  expect(parsed.success).toBe(false);
});

test("category patch strips fields from other categories", () => {
  const parsed = parseCategoryPatch("fashion", {
    sizes: ["M"],
    minRamGb: 16,
  });
  expect(parsed.success).toBe(true);
  expect(parsed.data).toEqual({ sizes: ["M"] });
});

test("category patch rejects a non-object body", () => {
  expect(parseCategoryPatch("general", null).success).toBe(false);
  expect(parseCategoryPatch("general", "nope").success).toBe(false);
});
