import { describe, expect, it } from "vitest";
import type { ExcludedProduct } from "../eligibility/filter";
import type { ConfidenceAssessment } from "../evidence/quality";
import type { Intent } from "../intent/types";
import type { Product } from "../products/schema";
import type { RankedProduct } from "./score";
import {
  buildGroundingCorpus,
  decideRecommendation,
  findUngroundedClaims,
  validateWaitReason,
} from "./policy";

function product(overrides: Partial<Product> & { id: string }): Product {
  return {
    sourceId: "amazon-in",
    title: "Test Laptop",
    url: `https://www.amazon.in/dp/${overrides.id}`,
    merchant: "Amazon India",
    snippet: "",
    priceInr: 45000,
    priceEvidence: "repeated",
    rating: { value: 4.3, count: 1200, seenAt: "2026-10-27T00:00:00.000Z" },
    score: 40,
    retrievedAt: new Date().toISOString(),
    ...overrides,
  };
}

function ranked(entry: Product, total: number): RankedProduct {
  return {
    product: entry,
    score: {
      price: 0,
      relevance: 0,
      evidence: 0,
      wants: 0,
      total,
      reasons: [],
    },
  };
}

function intent(overrides: Partial<Intent> = {}): Intent {
  return {
    query: "laptop under 50000",
    category: "electronics",
    categoryConfidence: "high",
    searchTerms: "laptop",
    budgetInr: { max: 50000 },
    ...overrides,
  };
}

function confidence(
  overrides: Partial<ConfidenceAssessment> = {},
): ConfidenceAssessment {
  return { score: 90, level: "high", gaps: [], ...overrides };
}

describe("validateWaitReason", () => {
  it("rejects sale and launch predictions", () => {
    expect(validateWaitReason("Wait for the Diwali sale.")).toBe(false);
    expect(validateWaitReason("Prices may drop soon.")).toBe(false);
  });

  it("allows evidence-based waiting", () => {
    expect(
      validateWaitReason("Wait until pricing is verified on the page."),
    ).toBe(true);
  });
});

describe("findUngroundedClaims", () => {
  it("flags prices and ratings outside the evidence", () => {
    const corpus = buildGroundingCorpus(
      [ranked(product({ id: "a" }), 90)],
      intent(),
    );
    expect(
      findUngroundedClaims("Costs ₹45,000 with a 4.3 stars rating.", corpus),
    ).toEqual([]);
    expect(
      findUngroundedClaims("Costs ₹99,999 with a 4.9 stars rating.", corpus),
    ).toHaveLength(2);
  });

  it("permits arithmetic over evidenced numbers", () => {
    const corpus = buildGroundingCorpus(
      [ranked(product({ id: "a" }), 90)],
      intent(),
    );
    // 50000 - 45000 = 5000 is derived from evidence.
    expect(findUngroundedClaims("Saves you ₹5,000.", corpus)).toEqual([]);
  });
});

describe("decideRecommendation", () => {
  const excluded: ExcludedProduct[] = [];

  it("abstains when nothing was found", () => {
    const rec = decideRecommendation({
      ranked: [],
      totalFound: 0,
      excluded,
      intent: intent(),
      confidence: confidence(),
    });
    expect(rec.verdict).toBe("INSUFFICIENT_EVIDENCE");
  });

  it("asks when every option is excluded", () => {
    const rec = decideRecommendation({
      ranked: [],
      totalFound: 2,
      excluded: [
        {
          productId: "a",
          title: "A",
          merchant: "M",
          reasons: ["Over budget: ₹60,000 exceeds ₹50,000 maximum"],
        },
      ],
      intent: intent(),
      confidence: confidence(),
    });
    expect(rec.verdict).toBe("NEEDS_CLARIFICATION");
    expect(rec.reason).toContain("budget");
  });

  it("abstains on low confidence", () => {
    const rec = decideRecommendation({
      ranked: [ranked(product({ id: "a" }), 90)],
      totalFound: 1,
      excluded,
      intent: intent(),
      confidence: confidence({ score: 20, level: "low", gaps: ["No prices."] }),
    });
    expect(rec.verdict).toBe("INSUFFICIENT_EVIDENCE");
    expect(rec.uncertainties).toEqual(["No prices."]);
  });

  it("accepts a grounded LLM verdict", () => {
    const rec = decideRecommendation({
      ranked: [ranked(product({ id: "a" }), 90)],
      totalFound: 1,
      excluded,
      intent: intent(),
      confidence: confidence(),
      llmVerdict: {
        verdict: "BUY",
        productId: "a",
        reason: "Solid at ₹45,000.",
        tradeoffs: [],
        uncertainties: [],
      },
    });
    expect(rec.verdict).toBe("BUY");
    expect(rec.source).toBe("llm");
  });

  it("falls back when the LLM invents a price", () => {
    const rec = decideRecommendation({
      ranked: [ranked(product({ id: "a" }), 90)],
      totalFound: 1,
      excluded,
      intent: intent(),
      confidence: confidence(),
      llmVerdict: {
        verdict: "BUY",
        productId: "a",
        reason: "Solid at ₹99,999.",
        tradeoffs: [],
        uncertainties: [],
      },
    });
    expect(rec.verdict).toBe("BUY");
    expect(rec.source).toBe("rules");
    expect(
      rec.uncertainties.some((u) => u.includes("failed validation")),
    ).toBe(true);
  });

  it("falls back on banned WAIT reasons", () => {
    const rec = decideRecommendation({
      ranked: [ranked(product({ id: "a" }), 90)],
      totalFound: 1,
      excluded,
      intent: intent(),
      confidence: confidence(),
      llmVerdict: {
        verdict: "WAIT",
        productId: "a",
        reason: "Wait for the big sale.",
        tradeoffs: [],
        uncertainties: [],
      },
    });
    expect(rec.source).toBe("rules");
  });

  it("annotates medium confidence and near-ties", () => {
    const rec = decideRecommendation({
      ranked: [
        ranked(product({ id: "a" }), 90),
        ranked(product({ id: "b", title: "Other Laptop" }), 88),
      ],
      totalFound: 2,
      excluded,
      intent: intent(),
      confidence: confidence({
        score: 60,
        level: "medium",
        gaps: ["No ratings found."],
      }),
    });
    expect(rec.verdict).toBe("BUY");
    expect(
      rec.uncertainties.some((u) => u.includes("Evidence gap")),
    ).toBe(true);
    expect(rec.uncertainties.some((u) => u.includes("within 5 points"))).toBe(
      true,
    );
  });
});
