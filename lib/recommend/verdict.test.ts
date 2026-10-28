import { expect, test } from "vitest";
import type { Intent } from "../intent/types";
import type { Product } from "../products/schema";
import { scoreProducts } from "./score";
import { deterministicVerdict, validateLlmVerdict } from "./verdict";

const intent: Intent = {
  query: "Find a laptop under 90000 for development",
  category: "electronics",
  categoryConfidence: "high",
  budgetInr: { max: 90000 },
  searchTerms: "laptop development",
};

const mk = (over: Partial<Product> & { id: string }): Product => ({
  title: "Laptop",
  url: `https://www.amazon.in/dp/${over.id}`,
  sourceId: "amazon-in",
  merchant: "Amazon India",
  snippet: "",
  score: 0.5,
  retrievedAt: "t",
  ...over,
});

const fit = mk({
  id: "a1",
  title: "Laptop Pro 16GB for development",
  priceInr: 85000,
  priceEvidence: "repeated",
  snippet: "laptop development machine",
  score: 0.9,
});
const over = mk({
  id: "b2",
  title: "Laptop Ultra 32GB development",
  priceInr: 120000,
  priceEvidence: "repeated",
  snippet: "laptop",
  score: 0.95,
});

test("ranking prefers in-budget evidence-backed options", () => {
  const ranked = scoreProducts([over, fit], intent);
  expect(ranked.map((r) => r.product.id)).toEqual(["a1", "b2"]);
  expect(ranked[0]?.score.total).toBeGreaterThan(ranked[1]?.score.total ?? 0);
});

test("deterministic verdicts never force a recommendation", () => {
  expect(deterministicVerdict([], intent).verdict).toBe("NEEDS_MORE_INFO");

  const ranked = scoreProducts([over, fit], intent);
  const buy = deterministicVerdict(ranked, intent);
  expect(buy.verdict).toBe("BUY");
  expect(buy.productId).toBe("a1");

  const onlyOver = scoreProducts([over], intent);
  expect(deterministicVerdict(onlyOver, intent).verdict).toBe("AVOID");

  const unpriced = scoreProducts(
    [mk({ id: "c3", title: "Laptop Basic development", snippet: "laptop" })],
    intent,
  );
  expect(deterministicVerdict(unpriced, intent).verdict).toBe("NEEDS_MORE_INFO");
});

test("LLM verdicts are validated against verified results", () => {
  const ranked = scoreProducts([over, fit], intent);

  const good = validateLlmVerdict(
    {
      verdict: "BUY",
      productId: "a1",
      reason: "Fits budget with strong evidence across options.",
      tradeoffs: [],
      uncertainties: [],
    },
    ranked,
    intent,
  );
  expect(good.verdict).toBe("BUY");
  expect(good.source).toBe("llm");

  const ghost = validateLlmVerdict(
    {
      verdict: "BUY",
      productId: "ghost",
      reason: "Hallucinated pick with sufficient length here.",
      tradeoffs: [],
      uncertainties: [],
    },
    ranked,
    intent,
  );
  expect(ghost.verdict).toBe("NEEDS_MORE_INFO");

  const veto = validateLlmVerdict(
    {
      verdict: "BUY",
      productId: "b2",
      reason: "LLM missed the budget overrun in this long reason.",
      tradeoffs: [],
      uncertainties: [],
    },
    ranked,
    intent,
  );
  expect(veto.verdict).toBe("AVOID");
  expect(veto.source).toBe("rules");
});
