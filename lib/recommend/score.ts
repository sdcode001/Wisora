import { matchRequirement } from "../eligibility/filter";
import type { Intent } from "../intent/types";
import { PROFILE_KEY_PREFIX } from "../memory/profile";
import type { Product } from "../products/schema";
import type { RequirementSet } from "../requirements/types";
import { contentTokens } from "../text/tokens";
import { formatInr } from "../text/format";
import { DEFAULT_WEIGHTS, type ScoreWeights } from "./weights";

export type ReasonSentiment = "pro" | "con" | "info";

export interface ScoreReason {
  text: string;
  sentiment: ReasonSentiment;
  /**
   * Marks preference matches driven by saved profile preferences.
   * Absent for current-request reasons; older clients ignore it.
   */
  source?: "query" | "profile";
}

export interface ScoreBreakdown {
  price: number;
  relevance: number;
  evidence: number;
  wants: number;
  total: number;
  reasons: ScoreReason[];
}

export interface RankedProduct {
  product: Product;
  score: ScoreBreakdown;
}

function scorePriceFraction(
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
    return 0.375;
  }
  if (max == null) {
    reasons.push({
      text: `Listed at ${formatInr(product.priceInr)} (no budget stated).`,
      sentiment: "info",
    });
    return 0.75;
  }
  if (product.priceInr <= max) {
    reasons.push({
      text: `${formatInr(product.priceInr)} fits your ${formatInr(max)} budget.`,
      sentiment: "pro",
    });
    return 1;
  }
  const overrun = (product.priceInr - max) / max;
  reasons.push({
    text: `${formatInr(product.priceInr)} exceeds your ${formatInr(max)} budget by ${formatInr(product.priceInr - max)}.`,
    sentiment: "con",
  });
  return Math.max(0, 1 - overrun);
}

function scoreEvidenceFraction(
  product: Product,
  reasons: ScoreReason[],
): number {
  if (product.priceEvidence === "repeated") {
    reasons.push({
      text: "Price corroborated across the retailer's page.",
      sentiment: "pro",
    });
    return 1;
  }
  if (product.priceEvidence === "single") {
    reasons.push({
      text: "Price seen only once — treat as unverified until confirmed.",
      sentiment: "con",
    });
    return 0.5;
  }
  return 0;
}

function scoreWantsFraction(
  product: Product,
  requirements: RequirementSet | undefined,
  reasons: ScoreReason[],
): number {
  const wants = requirements?.want ?? [];
  if (wants.length === 0) {
    reasons.push({
      text: "No optional preferences stated.",
      sentiment: "info",
    });
    return 1;
  }
  const text = `${product.title} ${product.snippet}`;
  let matched = 0;
  let total = 0;
  const matchedLabels: Array<{ label: string; source?: "profile" }> = [];
  let firstMissed: { label: string; source?: "profile" } | null = null;
  for (const want of wants) {
    total += want.importance;
    const source = want.key.startsWith(PROFILE_KEY_PREFIX)
      ? ("profile" as const)
      : undefined;
    if (matchRequirement(want, text) === "met") {
      matched += want.importance;
      if (matchedLabels.length < 2) {
        matchedLabels.push({ label: want.label, source });
      }
    } else if (!firstMissed) {
      firstMissed = { label: want.label, source };
    }
  }
  for (const { label, source } of matchedLabels) {
    reasons.push({
      text: `Matches preference: ${label}.`,
      sentiment: "pro",
      ...(source ? { source } : {}),
    });
  }
  if (firstMissed) {
    reasons.push({
      text: `Missing preference: ${firstMissed.label}.`,
      sentiment: "info",
      ...(firstMissed.source ? { source: firstMissed.source } : {}),
    });
  }
  return total > 0 ? matched / total : 1;
}

export function scoreProducts(
  products: Product[],
  intent: Intent,
  requirements?: RequirementSet,
  weights: ScoreWeights = DEFAULT_WEIGHTS,
): RankedProduct[] {
  const requirementTokens = new Set<string>();
  if (requirements) {
    for (const req of [
      ...requirements.must,
      ...requirements.want,
      ...requirements.exclude,
    ]) {
      for (const token of contentTokens(req.label)) {
        requirementTokens.add(token);
      }
    }
  }
  const queryTokens = new Set(
    [...contentTokens(intent.searchTerms)].filter(
      (token) => !requirementTokens.has(token),
    ),
  );
  const ranked: RankedProduct[] = products.map((product) => {
    const reasons: ScoreReason[] = [];
    const price = Math.round(
      scorePriceFraction(product, intent, reasons) * weights.price,
    );
    const haystack = contentTokens(`${product.title} ${product.snippet}`);
    let hits = 0;
    for (const token of queryTokens) {
      if (haystack.has(token)) {
        hits += 1;
      }
    }
    const recall = queryTokens.size === 0 ? 0.5 : hits / queryTokens.size;
    const relevance = Math.round(recall * weights.relevance);
    const evidence = Math.round(
      scoreEvidenceFraction(product, reasons) * weights.evidence,
    );
    const wants = Math.round(
      scoreWantsFraction(product, requirements, reasons) * weights.wants,
    );
    return {
      product,
      score: {
        price,
        relevance,
        evidence,
        wants,
        total: price + relevance + evidence + wants,
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

export function describeRankingGap(
  first: RankedProduct,
  second: RankedProduct,
): string[] {
  const deltas = (
    [
      ["Price fit", first.score.price - second.score.price],
      ["Relevance", first.score.relevance - second.score.relevance],
      ["Evidence", first.score.evidence - second.score.evidence],
      ["Preferences", first.score.wants - second.score.wants],
    ] as Array<[string, number]>
  )
    .filter(([, delta]) => delta > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2);
  if (deltas.length === 0) {
    return ["Options scored nearly identically — compare details below."];
  }
  return deltas.map(([label, delta]) => `${label} +${delta} for the top pick.`);
}
