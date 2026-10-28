import { describe, expect, it } from "vitest";
import { dedupeProducts, normalizeTitle } from "./dedup";
import type { Product } from "./schema";

const SEEN_AT = "2026-10-27T00:00:00.000Z";

function product(overrides: Partial<Product> & { id: string }): Product {
  return {
    sourceId: "amazon-in",
    title: "Test Laptop",
    url: `https://www.amazon.in/dp/${overrides.id}`,
    merchant: "Amazon India",
    snippet: "A test laptop.",
    priceInr: 45000,
    priceEvidence: "single",
    rating: { value: 4.0, count: 100, seenAt: SEEN_AT },
    score: 30,
    retrievedAt: SEEN_AT,
    ...overrides,
  };
}

describe("normalizeTitle", () => {
  it("lowercases and strips punctuation", () => {
    expect(normalizeTitle("Sony WH-1000XM5, Black!!")).toBe(
      "sony wh 1000xm5 black",
    );
  });
});

describe("dedupeProducts", () => {
  it("keeps the higher-scoring duplicate and reports removals", () => {
    const result = dedupeProducts([
      product({ id: "a", score: 10 }),
      product({ id: "a", score: 40 }),
    ]);
    expect(result.products).toHaveLength(1);
    expect(result.products[0]?.score).toBe(40);
    expect(result.removed).toBe(1);
    expect(result.conflicts).toEqual([]);
  });

  it("prefers stronger price evidence over a higher score", () => {
    const result = dedupeProducts([
      product({ id: "a", score: 90, priceEvidence: "single" }),
      product({ id: "a", score: 10, priceEvidence: "repeated" }),
    ]);
    expect(result.products[0]?.score).toBe(10);
    expect(result.products[0]?.priceEvidence).toBe("repeated");
  });

  it("records conflicting prices across duplicates", () => {
    const result = dedupeProducts([
      product({ id: "a", priceInr: 45000 }),
      product({ id: "a", priceInr: 47000 }),
    ]);
    expect(result.conflicts).toEqual([
      { productId: "a", field: "price", values: [45000, 47000] },
    ]);
  });

  it("records conflicting ratings across duplicates", () => {
    const result = dedupeProducts([
      product({ id: "a", rating: { value: 4.2, count: 100, seenAt: SEEN_AT } }),
      product({ id: "a", rating: { value: 3.1, count: 50, seenAt: SEEN_AT } }),
    ]);
    expect(result.conflicts).toEqual([
      { productId: "a", field: "rating", values: [3.1, 4.2] },
    ]);
  });

  it("merges fuzzy title-plus-price duplicates", () => {
    const result = dedupeProducts([
      product({ id: "a", title: "Sony WH-1000XM5 Black" }),
      product({ id: "b", title: "sony wh 1000xm5, black" }),
    ]);
    expect(result.products).toHaveLength(1);
    expect(result.removed).toBe(1);
  });

  it("keeps distinct products untouched", () => {
    const result = dedupeProducts([
      product({ id: "a" }),
      product({ id: "b", priceInr: 50000 }),
    ]);
    expect(result.products).toHaveLength(2);
    expect(result.removed).toBe(0);
    expect(result.conflicts).toEqual([]);
  });
});
