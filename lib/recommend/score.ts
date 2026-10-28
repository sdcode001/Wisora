import type { Intent } from "../intent/types";
import type { Product } from "../products/schema";

export type ReasonSentiment = "pro" | "con" | "info";

export interface ScoreReason {
  text: string;
  sentiment: ReasonSentiment;
}

export interface ScoreBreakdown {
  price: number;
  relevance: number;
  evidence: number;
  total: number;
  reasons: ScoreReason[];
}

export interface RankedProduct {
  product: Product;
  score: ScoreBreakdown;
}

const STOPWORDS = new Set([
  "for", "and", "the", "with", "under", "from", "that", "this", "your",
  "you", "are", "without", "compare", "find", "suggest", "best", "good",
  "great", "excellent", "suitable", "simple", "daily", "routine",
  "comfortable", "products", "product", "options", "option", "around",
  "about", "budget", "between",
]);

export function formatInr(value: number): string {
  return `₹${value.toLocaleString("en-IN")}`;
}

function contentTokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((word) => word.length > 2 && !STOPWORDS.has(word)),
  );
}

function scorePrice(
  product: Product,
  intent: Intent,
  reasons: ScoreReason[],
): number {
  const max = intent.budgetInr?.max;
  if (product.priceInr == null) {
    reasons.push({
      text: "No verified price — confirm on the retailer's page.",
      sentiment: "info",
    });
    return 15;
  }
  if (max == null) {
    reasons.push({
      text: `Listed at ${formatInr(product.priceInr)} (no budget stated).`,
      sentiment: "info",
    });
    return 30;
  }
  if (product.priceInr <= max) {
    reasons.push({
      text: `${formatInr(product.priceInr)} fits your ${formatInr(max)} budget.`,
      sentiment: "pro",
    });
    return 40;
  }
  const overrun = (product.priceInr - max) / max;
  reasons.push({
    text: `${formatInr(product.priceInr)} exceeds your ${formatInr(max)} budget by ${formatInr(product.priceInr - max)}.`,
    sentiment: "con",
  });
  return Math.max(0, Math.round(40 * (1 - overrun)));
}

function scoreEvidence(product: Product, reasons: ScoreReason[]): number {
  if (product.priceEvidence === "repeated") {
    reasons.push({
      text: "Price corroborated across the retailer's page.",
      sentiment: "pro",
    });
    return 20;
  }
  if (product.priceEvidence === "single") {
    reasons.push({
      text: "Price seen only once — treat as unverified until confirmed.",
      sentiment: "con",
    });
    return 10;
  }
  return 0;
}

export function scoreProducts(
  products: Product[],
  intent: Intent,
): RankedProduct[] {
  const queryTokens = contentTokens(intent.searchTerms);
  const ranked: RankedProduct[] = products.map((product) => {
    const reasons: ScoreReason[] = [];
    const price = scorePrice(product, intent, reasons);
    const haystack = contentTokens(`${product.title} ${product.snippet}`);
    let hits = 0;
    for (const token of queryTokens) {
      if (haystack.has(token)) {
        hits += 1;
      }
    }
    const recall = queryTokens.size === 0 ? 0.5 : hits / queryTokens.size;
    const relevance = Math.round(recall * 40);
    const evidence = scoreEvidence(product, reasons);
    return {
      product,
      score: {
        price,
        relevance,
        evidence,
        total: price + relevance + evidence,
        reasons,
      },
    };
  });
  ranked.sort(
    (a, b) =>
      b.score.total - a.score.total ||
      Number(b.product.priceInr != null) - Number(a.product.priceInr != null) ||
      b.product.score - a.product.score,
  );
  return ranked;
}
