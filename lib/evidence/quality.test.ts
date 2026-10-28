import { describe, expect, it } from "vitest";
import { assessConfidence, buildProductEvidence, isStale } from "./quality";
import type { ConflictRecord, Product } from "../products/schema";

const FRESH = new Date().toISOString();
const SEEN_AT = "2026-10-27T00:00:00.000Z";

function product(overrides: Partial<Product> & { id: string }): Product {
  return {
    sourceId: "amazon-in",
    title: "Test Laptop",
    url: `https://www.amazon.in/dp/${overrides.id}`,
    merchant: "Amazon India",
    snippet: "",
    priceInr: 45000,
    priceEvidence: "repeated",
    rating: { value: 4.3, count: 1200, seenAt: SEEN_AT },
    score: 30,
    retrievedAt: FRESH,
    priceSeenAt: FRESH,
    ...overrides,
  };
}

describe("isStale", () => {
  it("flags old and unparseable timestamps", () => {
    expect(isStale("2020-01-01T00:00:00.000Z")).toBe(true);
    expect(isStale("not-a-date")).toBe(true);
    expect(isStale(FRESH)).toBe(false);
  });
});

describe("buildProductEvidence", () => {
  it("grades repeated prices as verified and single sightings as observed", () => {
    expect(buildProductEvidence(product({ id: "a" }), []).price.status).toBe(
      "verified",
    );
    expect(
      buildProductEvidence(product({ id: "a", priceEvidence: "single" }), [])
        .price.status,
    ).toBe("observed");
    expect(
      buildProductEvidence(
        product({ id: "a", priceInr: undefined, priceEvidence: undefined }),
        [],
      ).price.status,
    ).toBe("missing");
  });

  it("grades ratings by count and surfaces conflicts", () => {
    expect(buildProductEvidence(product({ id: "a" }), []).rating.status).toBe(
      "verified",
    );
    expect(
      buildProductEvidence(
        product({ id: "a", rating: { value: 4.1, seenAt: SEEN_AT } }),
        [],
      ).rating.status,
    ).toBe("observed");
    const conflicts: ConflictRecord[] = [
      { productId: "a", field: "price", values: [45000, 47000] },
    ];
    const ev = buildProductEvidence(product({ id: "a" }), conflicts);
    expect(ev.price.status).toBe("conflicting");
    expect(ev.price.detail).toContain("₹45,000");
  });

  it("leaves specs missing and grades identity by URL shape", () => {
    const ev = buildProductEvidence(product({ id: "a" }), []);
    expect(ev.specs.status).toBe("missing");
    expect(ev.identity.status).toBe("verified");
    const search = buildProductEvidence(
      product({ id: "b", url: "https://www.amazon.in/s/laptops" }),
      [],
    );
    expect(search.identity.status).toBe("observed");
  });

  it("flags stale records", () => {
    const ev = buildProductEvidence(
      product({ id: "a", retrievedAt: "2020-01-01T00:00:00.000Z" }),
      [],
    );
    expect(ev.stale).toBe(true);
  });
});

describe("assessConfidence", () => {
  it("scores strong multi-merchant evidence high", () => {
    const products = [
      product({ id: "a" }),
      product({ id: "b", sourceId: "flipkart", merchant: "Flipkart" }),
      product({ id: "c" }),
    ];
    const evidence = new Map(
      products.map((p) => [p.id, buildProductEvidence(p, [])]),
    );
    const result = assessConfidence(products, evidence);
    expect(result.level).toBe("high");
    expect(result.score).toBeGreaterThanOrEqual(70);
  });

  it("scores thin evidence low with gaps", () => {
    const products = [
      product({
        id: "a",
        priceInr: undefined,
        priceEvidence: undefined,
        rating: undefined,
        url: "https://www.amazon.in/s/laptops",
      }),
    ];
    const evidence = new Map(
      products.map((p) => [p.id, buildProductEvidence(p, [])]),
    );
    const result = assessConfidence(products, evidence);
    expect(result.level).toBe("low");
    expect(result.gaps.length).toBeGreaterThan(0);
    expect(result.gaps.length).toBeLessThanOrEqual(3);
  });

  it("scores empty input as zero", () => {
    expect(assessConfidence([], new Map())).toMatchObject({
      score: 0,
      level: "low",
    });
  });
});
