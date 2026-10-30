import { describe, expect, it } from "vitest";
import type { Intent } from "../intent/types";
import type { Product } from "../products/schema";
import type { RankedProduct } from "./score";
import { deterministicVerdict, validateLlmVerdict } from "./verdict";

const SEEN_AT = "2026-10-27T00:00:00.000Z";

function product(overrides: Partial<Product> = {}): Product {
  return {
    id: "p1",
    sourceId: "amazon-in",
    title: "Test Laptop 16GB",
    url: "https://www.amazon.in/dp/B0TEST1",
    merchant: "Amazon India",
    snippet: "A test laptop.",
    priceInr: 45000,
    priceEvidence: "repeated",
    rating: { value: 4.3, count: 1200, seenAt: SEEN_AT },
    score: 40,
    retrievedAt: SEEN_AT,
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

describe("deterministicVerdict", () => {
  it("abstains when no listings exist", () => {
    const rec = deterministicVerdict([], intent());
    expect(rec.verdict).toBe("INSUFFICIENT_EVIDENCE");
    expect(rec.reason).toContain("nothing to recommend");
  });

  it("abstains when the top price cannot be verified", () => {
    const rec = deterministicVerdict(
      [
        ranked(
          product({ priceInr: undefined, priceEvidence: undefined }),
          40,
        ),
      ],
      intent(),
    );
    expect(rec.verdict).toBe("INSUFFICIENT_EVIDENCE");
    expect(rec.reason).toContain("closest match");
  });

  it("asks for clarification when slightly over budget", () => {
    const rec = deterministicVerdict(
      [ranked(product({ priceInr: 60000 }), 90)],
      intent(),
    );
    expect(rec.verdict).toBe("NEEDS_CLARIFICATION");
    expect(rec.reason).toContain("over your");
  });

  it("avoids when far over budget", () => {
    const rec = deterministicVerdict(
      [ranked(product({ priceInr: 80000 }), 90)],
      intent(),
    );
    expect(rec.verdict).toBe("AVOID");
    expect(rec.productId).toBe("p1");
  });

  it("buys a verified in-budget top pick", () => {
    const rec = deterministicVerdict([ranked(product(), 95)], intent());
    expect(rec.verdict).toBe("BUY");
    expect(rec.reason).toContain("Test Laptop 16GB");
  });

  it("flags single-sighting prices on a BUY", () => {
    const rec = deterministicVerdict(
      [ranked(product({ priceEvidence: "single" }), 90)],
      intent(),
    );
    expect(rec.verdict).toBe("BUY");
    expect(rec.uncertainties.some((u) => u.includes("seen once"))).toBe(true);
  });
});

describe("validateLlmVerdict", () => {
  const rankedList = [ranked(product(), 95)];

  it("discards suggestions outside the verified results", () => {
    const rec = validateLlmVerdict(
      {
        verdict: "BUY",
        productId: "ghost",
        reason: "Trust me.",
        tradeoffs: [],
        uncertainties: [],
      },
      rankedList,
      intent(),
    );
    expect(rec.verdict).toBe("INSUFFICIENT_EVIDENCE");
    expect(rec.source).toBe("rules");
  });

  it("discards BUY suggestions with no verifiable option", () => {
    const rec = validateLlmVerdict(
      {
        verdict: "BUY",
        reason: "Buy something.",
        tradeoffs: [],
        uncertainties: [],
      },
      rankedList,
      intent(),
    );
    expect(rec.verdict).toBe("INSUFFICIENT_EVIDENCE");
  });

  it("discards BUY suggestions whose price is unverified", () => {
    const rec = validateLlmVerdict(
      {
        verdict: "BUY",
        productId: "p1",
        reason: "Great deal.",
        tradeoffs: [],
        uncertainties: [],
      },
      [
        ranked(
          product({ priceInr: undefined, priceEvidence: undefined }),
          90,
        ),
      ],
      intent(),
    );
    expect(rec.verdict).toBe("INSUFFICIENT_EVIDENCE");
  });

  it("vetoes non-AVOID suggestions far over budget", () => {
    const rec = validateLlmVerdict(
      {
        verdict: "BUY",
        productId: "p1",
        reason: "Great deal.",
        tradeoffs: [],
        uncertainties: [],
      },
      [ranked(product({ priceInr: 80000 }), 90)],
      intent(),
    );
    expect(rec.verdict).toBe("AVOID");
    expect(rec.source).toBe("rules");
    expect(rec.reason).toContain("Vetoed");
  });

  it("accepts a grounded BUY as-is", () => {
    const rec = validateLlmVerdict(
      {
        verdict: "BUY",
        productId: "p1",
        reason: "Solid pick.",
        tradeoffs: ["Heavier than rivals."],
        uncertainties: [],
      },
      rankedList,
      intent(),
    );
    expect(rec.verdict).toBe("BUY");
    expect(rec.source).toBe("llm");
    expect(rec.tradeoffs).toEqual(["Heavier than rivals."]);
  });

  it("passes AVOID through", () => {
    const rec = validateLlmVerdict(
      {
        verdict: "AVOID",
        productId: "p1",
        reason: "Poor ratings.",
        tradeoffs: [],
        uncertainties: [],
      },
      rankedList,
      intent(),
    );
    expect(rec.verdict).toBe("AVOID");
    expect(rec.source).toBe("llm");
  });

  it("re-points the link to the product the reason describes", () => {
    const rec = validateLlmVerdict(
      {
        verdict: "BUY",
        productId: "p2",
        reason:
          "Test Laptop 16GB at ₹45,000 fits the budget with strong ratings.",
        tradeoffs: [],
        uncertainties: [],
      },
      [
        ranked(product({ id: "p1" }), 95),
        ranked(
          product({
            id: "p2",
            title: "Slim Notebook 8GB",
            url: "https://www.amazon.in/dp/B0TEST2",
            priceInr: 38000,
          }),
          90,
        ),
      ],
      intent(),
    );
    expect(rec.verdict).toBe("BUY");
    expect(rec.source).toBe("llm");
    expect(rec.productId).toBe("p1");
    expect(rec.reason).toContain("Test Laptop 16GB");
  });

  it("vetoes a re-pointed pick that is far over budget", () => {
    const rec = validateLlmVerdict(
      {
        verdict: "BUY",
        productId: "p2",
        reason: "Test Laptop 16GB leads on relevance.",
        tradeoffs: [],
        uncertainties: [],
      },
      [
        ranked(product({ id: "p1", priceInr: 80000 }), 95),
        ranked(
          product({
            id: "p2",
            title: "Slim Notebook 8GB",
            url: "https://www.amazon.in/dp/B0TEST2",
            priceInr: 38000,
          }),
          90,
        ),
      ],
      intent(),
    );
    expect(rec.verdict).toBe("AVOID");
    expect(rec.productId).toBe("p1");
    expect(rec.reason).toContain("Vetoed");
  });

  it("keeps the claimed link when the reason names no product", () => {
    const rec = validateLlmVerdict(
      {
        verdict: "BUY",
        productId: "p2",
        reason: "Great deal overall.",
        tradeoffs: [],
        uncertainties: [],
      },
      [
        ranked(product({ id: "p1" }), 95),
        ranked(
          product({
            id: "p2",
            title: "Slim Notebook 8GB",
            url: "https://www.amazon.in/dp/B0TEST2",
            priceInr: 38000,
          }),
          90,
        ),
      ],
      intent(),
    );
    expect(rec.verdict).toBe("BUY");
    expect(rec.productId).toBe("p2");
  });

  it("keeps the claimed link when the reason names several products", () => {
    const rec = validateLlmVerdict(
      {
        verdict: "BUY",
        productId: "p2",
        reason: "Test Laptop 16GB beats Slim Notebook 8GB on memory.",
        tradeoffs: [],
        uncertainties: [],
      },
      [
        ranked(product({ id: "p1" }), 95),
        ranked(
          product({
            id: "p2",
            title: "Slim Notebook 8GB",
            url: "https://www.amazon.in/dp/B0TEST2",
            priceInr: 38000,
          }),
          90,
        ),
      ],
      intent(),
    );
    expect(rec.verdict).toBe("BUY");
    expect(rec.productId).toBe("p2");
  });

  it("passes WAIT through with a thin-price note when priceless", () => {
    const rec = validateLlmVerdict(
      {
        verdict: "WAIT",
        productId: "p1",
        reason: "Wait for verification.",
        tradeoffs: [],
        uncertainties: [],
      },
      [
        ranked(
          product({ priceInr: undefined, priceEvidence: undefined }),
          90,
        ),
      ],
      intent(),
    );
    expect(rec.verdict).toBe("WAIT");
    expect(rec.source).toBe("llm");
    expect(rec.uncertainties.some((u) => u.includes("thin"))).toBe(true);
  });
});
