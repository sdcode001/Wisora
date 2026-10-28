import { expect, test } from "vitest";
import { POST } from "./route";

delete process.env.META_API_KEY;
delete process.env.TAVILY_API_KEY;

const req = (body: unknown): Request =>
  new Request("http://localhost/api/recommend", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const ALL_DISABLED = {
  "amazon-in": true,
  flipkart: true,
  shopclues: true,
  snapdeal: true,
  myntra: true,
  ajio: true,
  "tata-cliq": true,
  "nykaa-fashion": true,
  "newme-fashion": true,
};

const FRESH = new Date().toISOString();

const INTENT = {
  query: "laptop under 50000",
  category: "electronics",
  categoryConfidence: "high",
  searchTerms: "laptop",
  budgetInr: { max: 50000 },
};

const REQUIREMENTS = {
  category: "electronics",
  must: [],
  want: [],
  exclude: [],
  unanswered: [],
};

const PRODUCT = {
  id: "p1",
  sourceId: "amazon-in",
  title: "Test Laptop 16GB",
  url: "https://www.amazon.in/dp/B0TEST1",
  merchant: "Amazon India",
  snippet: "A test laptop.",
  priceInr: 45000,
  priceEvidence: "repeated",
  rating: { value: 4.3, count: 1200, seenAt: FRESH },
  score: 40,
  retrievedAt: FRESH,
};

const STATUS = {
  sourceId: "amazon-in",
  ok: true,
  resultCount: 1,
  searchedAt: FRESH,
};

test("rejects invalid bodies", async () => {
  const response = await POST(req({}));
  expect(response.status).toBe(400);
});

test("recommends from provided products without live calls", async () => {
  const response = await POST(
    req({
      query: "laptop under 50000",
      intent: INTENT,
      requirements: REQUIREMENTS,
      products: [PRODUCT],
      statuses: [STATUS],
      searchedAt: FRESH,
    }),
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    ranked: Array<{ analysis: { checks: unknown[]; evidence: unknown } }>;
    recommendation: { verdict: string };
    reasoningUsed: string;
    requirements: { category: string };
    confidence: { level: string };
    excludedByBudget: number;
    excluded: unknown[];
    statuses: unknown[];
  };
  expect(body.recommendation.verdict).toBe("BUY");
  expect(body.reasoningUsed).toBe("rules");
  expect(body.requirements.category).toBe("electronics");
  expect(body.ranked).toHaveLength(1);
  expect(body.ranked[0]?.analysis.checks).toEqual([]);
  expect(body.ranked[0]?.analysis.evidence).not.toBeNull();
  expect(body.confidence.level).toBe("high");
  expect(body.excludedByBudget).toBe(0);
  expect(body.statuses).toHaveLength(1);
});

test("over-budget products ask for clarification", async () => {
  const response = await POST(
    req({
      query: "laptop under 50000",
      intent: INTENT,
      requirements: REQUIREMENTS,
      products: [{ ...PRODUCT, priceInr: 80000 }],
      statuses: [STATUS],
      searchedAt: FRESH,
    }),
  );
  const body = (await response.json()) as {
    recommendation: { verdict: string };
    excludedByBudget: number;
    excluded: Array<{ reasons: string[] }>;
    warnings: string[];
  };
  expect(body.recommendation.verdict).toBe("NEEDS_CLARIFICATION");
  expect(body.excludedByBudget).toBe(1);
  expect(body.excluded[0]?.reasons[0]).toContain("Over budget");
  expect(body.warnings.some((w) => w.includes("excluded"))).toBe(true);
});

test("invalid weights fall back to defaults with a warning", async () => {
  const response = await POST(
    req({
      query: "laptop under 50000",
      intent: INTENT,
      requirements: REQUIREMENTS,
      weights: { price: 50, relevance: 50, evidence: 50, wants: 50 },
      products: [PRODUCT],
      statuses: [STATUS],
      searchedAt: FRESH,
    }),
  );
  const body = (await response.json()) as {
    recommendation: { verdict: string };
    warnings: string[];
  };
  expect(response.status).toBe(200);
  expect(body.recommendation.verdict).toBe("BUY");
  expect(body.warnings.some((w) => w.includes("weights"))).toBe(true);
});

test("all sources disabled means no-sources, not a search", async () => {
  const response = await POST(
    req({ query: "laptop", disabled: ALL_DISABLED }),
  );
  expect(response.status).toBe(400);
  const body = (await response.json()) as { code: string };
  expect(body.code).toBe("no-sources");
});

test("partial disable without products needs the search key", async () => {
  const response = await POST(
    req({ query: "laptop", disabled: { "amazon-in": true } }),
  );
  expect(response.status).toBe(503);
  const body = (await response.json()) as { code: string };
  expect(body.code).toBe("missing-tavily-key");
});
