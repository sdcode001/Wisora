import type { Intent } from "../intent/types";
import { formatInr, type RankedProduct } from "./score";

export type Verdict = "BUY" | "WAIT" | "AVOID" | "NEEDS_MORE_INFO";

export interface Recommendation {
  verdict: Verdict;
  productId?: string;
  reason: string;
  tradeoffs: string[];
  uncertainties: string[];
  source: "llm" | "rules";
}

export interface LlmVerdictInput {
  verdict: "BUY" | "WAIT" | "AVOID";
  productId?: string | null;
  reason: string;
  tradeoffs: string[];
  uncertainties: string[];
}

const OVER_BUDGET_AVOID_RATIO = 1.25;

function needsMore(
  reason: string,
  uncertainties: string[],
  source: "llm" | "rules",
): Recommendation {
  return {
    verdict: "NEEDS_MORE_INFO",
    reason,
    tradeoffs: [],
    uncertainties,
    source,
  };
}

export function deterministicVerdict(
  ranked: RankedProduct[],
  intent: Intent,
): Recommendation {
  if (ranked.length === 0) {
    return needsMore(
      "No product listings were found across the searched sources, so there is nothing to recommend yet.",
      ["Try broader search terms, a corrected category, or more sources."],
      "rules",
    );
  }
  const top = ranked[0] as RankedProduct;
  const max = intent.budgetInr?.max;
  const price = top.product.priceInr;

  if (max != null && price != null && price > max * OVER_BUDGET_AVOID_RATIO) {
    return {
      verdict: "AVOID",
      productId: top.product.id,
      reason: `The best-matching option (${top.product.title} at ${formatInr(price)}) exceeds your ${formatInr(max)} budget by more than 25%. It is a poor match for your stated budget.`,
      tradeoffs: [
        "If the budget is flexible, this pick leads on relevance — confirm the price on the retailer's page.",
      ],
      uncertainties:
        top.product.priceEvidence === "single"
          ? ["Its price was seen only once — confirm on the retailer's page."]
          : [],
      source: "rules",
    };
  }

  if (price == null) {
    return needsMore(
      `The closest match is "${top.product.title}" (${top.product.merchant}), but its price could not be verified, so a recommendation cannot be defended.`,
      [
        "Open the listing to confirm the current price, then re-run the search.",
        "Other shortlisted options also lack verified prices.",
      ],
      "rules",
    );
  }

  if (max != null && price > max) {
    return needsMore(
      `The best match (${top.product.title} at ${formatInr(price)}) is ${formatInr(price - max)} over your ${formatInr(max)} budget. Confirm whether the budget is flexible or share more requirements.`,
      [],
      "rules",
    );
  }

  return {
    verdict: "BUY",
    productId: top.product.id,
    reason: `${top.product.title} (${top.product.merchant}) at ${formatInr(price)} fits your requirements${max != null ? ` and ${formatInr(max)} budget` : ""}, with the strongest evidence among ${ranked.length} option${ranked.length === 1 ? "" : "s"}.`,
    tradeoffs: [],
    uncertainties:
      top.product.priceEvidence === "single"
        ? ["Price seen once — confirm on the retailer's page before buying."]
        : ["Prices and availability change — confirm on the retailer's page before buying."],
    source: "rules",
  };
}

export function validateLlmVerdict(
  input: LlmVerdictInput,
  ranked: RankedProduct[],
  intent: Intent,
): Recommendation {
  const target =
    input.productId != null
      ? ranked.find((entry) => entry.product.id === input.productId)
      : undefined;

  if (input.productId != null && !target) {
    return needsMore(
      "The AI recommendation referenced an option outside the verified results, so it was discarded.",
      ["Re-run the search to get a fresh recommendation."],
      "rules",
    );
  }

  const max = intent.budgetInr?.max;
  const price = target?.product.priceInr;
  if (
    target &&
    max != null &&
    price != null &&
    price > max * OVER_BUDGET_AVOID_RATIO &&
    input.verdict !== "AVOID"
  ) {
    return {
      verdict: "AVOID",
      productId: target.product.id,
      reason: `Vetoed an over-budget pick: ${target.product.title} at ${formatInr(price)} exceeds the ${formatInr(max)} budget by more than 25%.`,
      tradeoffs: [],
      uncertainties: [],
      source: "rules",
    };
  }

  if (input.verdict === "BUY") {
    if (!target) {
      return needsMore(
        "The AI recommendation did not name a verifiable option, so no recommendation can stand.",
        ["Re-run the search to get a fresh recommendation."],
        "rules",
      );
    }
    if (price == null) {
      return needsMore(
        `The AI suggested "${target.product.title}", but its price is unverified, so the recommendation cannot stand.`,
        ["Open the listing to confirm the current price, then re-run the search."],
        "rules",
      );
    }
    return {
      verdict: "BUY",
      productId: target.product.id,
      reason: input.reason,
      tradeoffs: input.tradeoffs,
      uncertainties: input.uncertainties,
      source: "llm",
    };
  }

  if (input.verdict === "AVOID") {
    return {
      verdict: "AVOID",
      productId: target?.product.id,
      reason: input.reason,
      tradeoffs: input.tradeoffs,
      uncertainties: input.uncertainties,
      source: "llm",
    };
  }

  const uncertainties = [...input.uncertainties];
  if (target && price == null) {
    uncertainties.push(
      "AI-suggested wait; the underlying price evidence is thin — verify listings directly.",
    );
  }
  return {
    verdict: "WAIT",
    productId: target?.product.id,
    reason: input.reason,
    tradeoffs: input.tradeoffs,
    uncertainties,
    source: "llm",
  };
}
