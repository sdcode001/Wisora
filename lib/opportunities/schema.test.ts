import { expect, test } from "vitest";
import {
  OpportunitySchema,
  buildDedupeKey,
  isAvailabilityDuplicate,
  isDuplicateOpportunity,
  type Opportunity,
} from "./schema";

function stored(
  overrides: Partial<Opportunity> & { dedupeKey: string; kind: Opportunity["kind"] },
): Opportunity {
  return {
    id: "opp-1",
    createdAt: "2026-02-10T12:00:00.000Z",
    status: "active",
    productId: "p1",
    title: "Test Laptop",
    merchant: "Amazon India",
    url: "https://www.amazon.in/dp/B0TEST1",
    currentPriceInr: 84000,
    previousPriceInr: 90000,
    targetPriceInr: 85000,
    reason: "At ₹84,000 — within your ₹85,000 target.",
    evidence: {
      source: "watch-check",
      observedAt: "2026-02-10T12:00:00.000Z",
    },
    ...overrides,
  };
}

test("dedupe keys round prices and omit them for availability", () => {
  expect(buildDedupeKey("price-drop", "p1", 84999.6)).toBe(
    "price-drop:p1:85000",
  );
  expect(buildDedupeKey("unavailable", "p1", null)).toBe("unavailable:p1");
});

test("price duplicates match in any status, including dismissed", () => {
  const existing = [
    stored({
      kind: "price-drop",
      dedupeKey: "price-drop:p1:84000",
      status: "dismissed",
    }),
  ];
  expect(isDuplicateOpportunity(existing, "price-drop:p1:84000")).toBe(true);
  expect(isDuplicateOpportunity(existing, "price-drop:p1:83000")).toBe(false);
  expect(isDuplicateOpportunity([], "price-drop:p1:84000")).toBe(false);
});

test("availability checks the product's latest state, not key history", () => {
  // Outage -> restock -> outage: the newest entry decides.
  const newestFirst = [
    stored({ kind: "restored", dedupeKey: "restored:p1" }),
    stored({ kind: "unavailable", dedupeKey: "unavailable:p1" }),
  ];
  expect(isAvailabilityDuplicate(newestFirst, "p1", "restored")).toBe(true);
  expect(isAvailabilityDuplicate(newestFirst, "p1", "unavailable")).toBe(false);
  // Other products never interfere.
  expect(isAvailabilityDuplicate(newestFirst, "p2", "restored")).toBe(false);
  expect(isAvailabilityDuplicate([], "p1", "unavailable")).toBe(false);
});

test("opportunity records validate strictly", () => {
  const valid = stored({
    kind: "target-reached",
    dedupeKey: "target-reached:p1:84000",
  });
  expect(OpportunitySchema.parse(valid)).toEqual(valid);
  expect(
    OpportunitySchema.safeParse({ ...valid, kind: "jackpot" }).success,
  ).toBe(false);
  expect(
    OpportunitySchema.safeParse({ ...valid, reason: "" }).success,
  ).toBe(false);
});
