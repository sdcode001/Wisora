import { expect, test } from "vitest";
import { answerQuestion, resolveProduct } from "./answer";
import type { ChatContext, KnownProduct } from "./context";

const NOW = new Date("2026-02-10T12:00:00.000Z").getTime();
const DAY = 24 * 60 * 60 * 1000;
const at = (daysAgo: number) =>
  new Date(NOW - daysAgo * DAY).toISOString();

function product(overrides: Partial<KnownProduct> = {}): KnownProduct {
  return {
    productId: "p1",
    title: "Lenovo ThinkPad E14",
    merchant: "Amazon India",
    url: "https://www.amazon.in/dp/B0TEST1",
    targetPriceInr: 85000,
    latest: {
      productId: "p1",
      url: "https://www.amazon.in/dp/B0TEST1",
      title: "Lenovo ThinkPad E14",
      merchant: "Amazon India",
      sourceId: "amazon-in",
      priceInr: 84999,
      currency: "INR",
      evidence: "repeated",
      candidates: 2,
      observedAt: at(0),
      source: "watch-check",
    },
    history: [],
    decisionVerdict: "BUY",
    saved: true,
    activeOpportunityKinds: ["target-reached"],
    ...overrides,
  };
}

function contextWith(products: KnownProduct[]): ChatContext {
  return { text: "ctx", products, generatedAt: at(0) };
}

test("hint wins; token match needs a clear winner", () => {
  const products = [
    product({ productId: "p1", title: "Lenovo ThinkPad E14" }),
    product({
      productId: "p2",
      title: "HP Pavilion 15",
      merchant: "Flipkart",
      url: "https://www.flipkart.com/hp",
    }),
  ];
  expect(
    resolveProduct("anything at all", products, "p2")?.productId,
  ).toBe("p2");
  expect(
    resolveProduct("is the ThinkPad still a good deal?", products)?.productId,
  ).toBe("p1");
  // "laptop" is filler and matches neither title distinctively.
  expect(resolveProduct("laptop price?", products)).toBeNull();
});

test("price questions answer from the latest observation", () => {
  const answer = answerQuestion(
    "What is the ThinkPad price now?",
    contextWith([product()]),
    { nowMs: NOW },
  );
  expect(answer?.text).toContain("₹84,999");
  expect(answer?.text).toContain("Amazon India");
  expect(answer?.sources).toHaveLength(1);
});

test("missing prices say so instead of guessing", () => {
  const answer = answerQuestion(
    "ThinkPad price?",
    contextWith([product({ latest: null, history: [] })]),
    { nowMs: NOW },
  );
  expect(answer?.text).toContain("No price recorded");
});

test("changes report direction with both dates", () => {
  const latest = product().latest;
  const previous = latest ? { ...latest, priceInr: 89999, observedAt: at(3) } : null;
  const answer = answerQuestion(
    "Has the ThinkPad price changed?",
    contextWith([product({ history: latest && previous ? [latest, previous] : [] })]),
    { nowMs: NOW },
  );
  expect(answer?.text).toContain("down ₹5,000");
  expect(answer?.text).toContain("2026-02-07");
  expect(answer?.text).toContain("2026-02-10");
});

test("deal questions weigh target, history, and decisions", () => {
  const answer = answerQuestion(
    "Is the ThinkPad still a good deal?",
    contextWith([product()]),
    { nowMs: NOW },
  );
  expect(answer?.text).toContain("meets your ₹85,000 target");
  expect(answer?.text).toContain("BUY");
});

test("why questions cite the saved decision", () => {
  const answer = answerQuestion(
    "Why are you recommending the ThinkPad?",
    contextWith([product()]),
    { nowMs: NOW },
  );
  expect(answer?.text).toContain("BUY");
  expect(answer?.text).toContain("target-reached");
});

test("comparisons rank priced products cheapest-first", () => {
  const answer = answerQuestion(
    "Compare my shortlist",
    contextWith([
      product({}),
      product({
        productId: "p2",
        title: "HP Pavilion 15",
        latest: {
          ...(product().latest as NonNullable<ReturnType<typeof product>["latest"]>),
          priceInr: 79999,
        },
      }),
    ]),
    { nowMs: NOW },
  );
  expect(answer?.text).toContain("1. HP Pavilion 15");
  expect(answer?.text).toContain("2. Lenovo ThinkPad E14");
});

test("stale sightings carry a re-check caveat", () => {
  const latest = product().latest;
  const stale = latest ? { ...latest, observedAt: at(10) } : null;
  const answer = answerQuestion(
    "ThinkPad price?",
    contextWith([product({ latest: stale })]),
    { nowMs: NOW },
  );
  expect(answer?.text).toContain("10 days old");
});

test("greetings and inventory questions answer directly", () => {
  expect(
    answerQuestion("hello", contextWith([product()]), { nowMs: NOW })?.text,
  ).toContain("Hi!");
  const tracked = answerQuestion(
    "What am I tracking?",
    contextWith([product()]),
    { nowMs: NOW },
  );
  expect(tracked?.text).toContain("Tracked (1)");
  expect(tracked?.text).toContain("ThinkPad");
});

test("source labels clamp to the 200-char schema cap", () => {
  const longTitle = `${"Very long product title ".repeat(12)}X`;
  expect(longTitle.length).toBeGreaterThan(200);
  const answer = answerQuestion(
    "What is the price?",
    contextWith([
      product({ title: longTitle, productId: "px" }),
    ]),
    { nowMs: NOW, productId: "px" },
  );
  expect(answer?.sources).toHaveLength(1);
  expect(answer?.sources[0]?.label.length).toBeLessThanOrEqual(200);
});

test("unmatched questions fall through to the model", () => {
  expect(
    answerQuestion(
      "What is the meaning of life?",
      contextWith([product()]),
      { nowMs: NOW },
    ),
  ).toBeNull();
});
