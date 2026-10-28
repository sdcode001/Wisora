import { describe, expect, it } from "vitest";
import {
  filterEligible,
  matchRequirement,
  OVER_BUDGET_TOLERANCE,
} from "./filter";
import type { Intent } from "../intent/types";
import type { Product } from "../products/schema";
import type { Requirement, RequirementSet } from "../requirements/types";

const SEEN_AT = "2026-10-27T00:00:00.000Z";

function req(
  overrides: Partial<Requirement> & { label: string },
): Requirement {
  return {
    key: overrides.label.toLowerCase().replace(/\s+/g, "-"),
    kind: "must",
    importance: 1,
    ...overrides,
  };
}

function requirements(overrides: Partial<RequirementSet> = {}): RequirementSet {
  return {
    category: "electronics",
    must: [],
    want: [],
    exclude: [],
    unanswered: [],
    ...overrides,
  };
}

function product(overrides: Partial<Product> & { id: string }): Product {
  return {
    sourceId: "amazon-in",
    title: "Test Laptop",
    url: `https://www.amazon.in/dp/${overrides.id}`,
    merchant: "Amazon India",
    snippet: "",
    priceInr: 45000,
    priceEvidence: "repeated",
    rating: { value: 4.3, count: 100, seenAt: SEEN_AT },
    score: 30,
    retrievedAt: SEEN_AT,
    ...overrides,
  };
}

function intent(overrides: Partial<Intent> = {}): Intent {
  return {
    query: "laptop",
    category: "electronics",
    categoryConfidence: "high",
    searchTerms: "laptop",
    budgetInr: { max: 50000 },
    ...overrides,
  };
}

describe("matchRequirement", () => {
  it("treats numeric requirements as minimums", () => {
    const ram = req({ label: "16GB RAM" });
    expect(matchRequirement(ram, "Laptop with 32GB RAM")).toBe("met");
    expect(matchRequirement(ram, "Laptop with 8GB RAM")).toBe("not-met");
    expect(matchRequirement(ram, "Laptop with fast memory")).toBe("unknown");
  });

  it("normalizes units before comparing", () => {
    const storage = req({ label: "1TB storage" });
    expect(matchRequirement(storage, "Gaming rig with 2TB storage")).toBe(
      "met",
    );
    expect(matchRequirement(storage, "Laptop with 512GB storage")).toBe(
      "not-met",
    );
  });

  it("requires every token for textual requirements", () => {
    const anc = req({ label: "noise cancelling" });
    expect(matchRequirement(anc, "Headphones with noise cancelling")).toBe(
      "met",
    );
    expect(matchRequirement(anc, "Headphones with noise isolation")).toBe(
      "unknown",
    );
  });
});

describe("filterEligible", () => {
  it("excludes over-budget products with a reason", () => {
    const result = filterEligible(
      [product({ id: "a", priceInr: 80000 })],
      requirements(),
      intent(),
    );
    expect(result.eligible).toEqual([]);
    expect(result.excluded[0]?.reasons[0]).toContain("Over budget");
  });

  it("keeps near-budget products only with the tolerance flag", () => {
    const near = 50000 * OVER_BUDGET_TOLERANCE;
    const strict = filterEligible(
      [product({ id: "a", priceInr: near })],
      requirements(),
      intent(),
    );
    expect(strict.eligible).toEqual([]);
    const relaxed = filterEligible(
      [product({ id: "a", priceInr: near })],
      requirements(),
      intent(),
      { allowOverBudget: true },
    );
    expect(relaxed.eligible).toHaveLength(1);
  });

  it("excludes failed musts and hit exclusions, never unknowns", () => {
    const result = filterEligible(
      [
        product({
          id: "fail",
          title: "Laptop with 8GB RAM",
          snippet: "8GB RAM model",
        }),
        product({ id: "hit", title: "Refurbished Laptop" }),
        product({
          id: "unknown-price",
          priceInr: undefined,
          priceEvidence: undefined,
        }),
      ],
      requirements({
        must: [req({ label: "16GB RAM" })],
        exclude: [req({ label: "Refurbished", kind: "exclude" })],
      }),
      intent(),
    );
    expect(result.eligible.map((p) => p.id)).toEqual(["unknown-price"]);
    expect(result.excluded.map((e) => e.productId).sort()).toEqual([
      "fail",
      "hit",
    ]);
  });

  it("records per-product requirement checks", () => {
    const result = filterEligible(
      [product({ id: "a", title: "Laptop with 16GB RAM" })],
      requirements({ must: [req({ label: "16GB RAM" })] }),
      intent(),
    );
    expect(result.checks["a"]).toEqual([
      {
        key: "16gb-ram",
        label: "16GB RAM",
        kind: "must",
        status: "met",
      },
    ]);
  });
});
