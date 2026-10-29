import { expect, test } from "vitest";
import {
  createRecordId,
  FeedbackSchema,
  NewDecisionRecordSchema,
  NewFeedbackSchema,
  NewSavedComparisonSchema,
  NewSavedProductSchema,
} from "./records";

test("record ids are unique 24-char hex strings", () => {
  const first = createRecordId();
  const second = createRecordId();
  expect(first).toMatch(/^[0-9a-f]{24}$/);
  expect(second).not.toBe(first);
});

test("decision input requires a query, category, and verdict", () => {
  const valid = {
    query: "laptop for coding",
    category: "electronics",
    topPick: null,
    verdict: "BUY",
  };
  expect(NewDecisionRecordSchema.safeParse(valid).success).toBe(true);
  expect(
    NewDecisionRecordSchema.safeParse({ ...valid, query: "x" }).success,
  ).toBe(false);
  expect(
    NewDecisionRecordSchema.safeParse({ ...valid, verdict: "MAYBE" }).success,
  ).toBe(false);
  expect(
    NewDecisionRecordSchema.safeParse({
      ...valid,
      budgetInr: { min: 90000, max: 50000 },
    }).success,
  ).toBe(false);
});

test("feedback requires at least one signal", () => {
  expect(NewFeedbackSchema.safeParse({}).success).toBe(false);
  expect(
    NewFeedbackSchema.safeParse({
      helpful: null,
      preferred: null,
      note: null,
    }).success,
  ).toBe(false);
  // helpful:false is a signal, not an absence.
  expect(NewFeedbackSchema.safeParse({ helpful: false }).success).toBe(true);
  expect(NewFeedbackSchema.safeParse({ note: "too pricey" }).success).toBe(
    true,
  );
  expect(
    NewFeedbackSchema.safeParse({
      preferred: { productId: "p1", title: "Sony X" },
    }).success,
  ).toBe(true);
});

test("stored feedback enforces the same signal rule", () => {
  expect(
    FeedbackSchema.safeParse({ id: "f1", createdAt: "now" }).success,
  ).toBe(false);
});

test("saved products require a valid URL", () => {
  const valid = {
    productId: "p1",
    title: "Sony X",
    url: "https://www.amazon.in/dp/B0TEST1",
    merchant: "Amazon India",
  };
  expect(NewSavedProductSchema.safeParse(valid).success).toBe(true);
  expect(
    NewSavedProductSchema.safeParse({ ...valid, url: "not-a-url" }).success,
  ).toBe(false);
});

test("saved comparisons require two to six products", () => {
  const product = { productId: "p1", title: "A", merchant: "M" };
  const base = { category: "electronics", products: [product] };
  expect(NewSavedComparisonSchema.safeParse(base).success).toBe(false);
  expect(
    NewSavedComparisonSchema.safeParse({
      ...base,
      products: [
        product,
        { ...product, productId: "p2" },
      ],
    }).success,
  ).toBe(true);
  expect(
    NewSavedComparisonSchema.safeParse({
      ...base,
      products: Array.from({ length: 7 }, (_, i) => ({
        ...product,
        productId: `p${i}`,
      })),
    }).success,
  ).toBe(false);
});
