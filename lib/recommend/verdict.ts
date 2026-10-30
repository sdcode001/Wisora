import type { Intent } from "../intent/types";
import type { RankedProduct } from "./score";
import { formatInr } from "../text/format";

export type Verdict =
  | "BUY"
  | "WAIT"
  | "AVOID"
  | "INSUFFICIENT_EVIDENCE"
  | "NEEDS_CLARIFICATION";

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

const FILLER_WORDS = new Set([
  "with",
  "from",
  "and",
  "for",
  "the",
  "this",
  "that",
  "pack",
  "combo",
]);

function distinctiveTokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9\u0900-\u097F]+/)
    .filter(
      (token) =>
        (token.length >= 4 || (token.length >= 3 && /\d/.test(token))) &&
        !FILLER_WORDS.has(token),
    );
}

function countNameMatches(reason: string, title: string, merchant: string): number {
  const haystack = reason.toLowerCase();
  let matches = 0;
  for (const token of [
    ...distinctiveTokens(title),
    ...distinctiveTokens(merchant),
  ]) {
    if (haystack.includes(token)) {
      matches += 1;
    }
  }
  return matches;
}

/**
 * The product the reason text best describes. Re-points only on unique,
 * strictly-best evidence of a different product — ties and nameless
 * reasons keep the claimed id, so generic LLM prose never breaks.
 */
export function resolveDescribedProduct(
  reason: string,
  ranked: RankedProduct[],
  claimedId: string,
): string {
  let bestId = claimedId;
  let bestMatches = -1;
  let tied = false;
  for (const entry of ranked) {
    const matches = countNameMatches(
      reason,
      entry.product.title,
      entry.product.merchant,
    );
    if (matches > bestMatches) {
      bestMatches = matches;
      bestId = entry.product.id;
      tied = false;
    } else if (matches === bestMatches) {
      tied = true;
    }
  }
  if (tied || bestMatches <= 0) {
    return claimedId;
  }
  return bestId;
}

function needsMore(
  verdict: "INSUFFICIENT_EVIDENCE" | "NEEDS_CLARIFICATION",
  reason: string,
  uncertainties: string[],
  source: "llm" | "rules",
): Recommendation {
  return {
    verdict,
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
      "INSUFFICIENT_EVIDENCE",
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
      "INSUFFICIENT_EVIDENCE",
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
      "NEEDS_CLARIFICATION",
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
  let target =
    input.productId != null
      ? ranked.find((entry) => entry.product.id === input.productId)
      : undefined;

  if (input.productId != null && !target) {
    return needsMore(
      "INSUFFICIENT_EVIDENCE",
      "The AI recommendation referenced an option outside the verified results, so it was discarded.",
      ["Re-run the search to get a fresh recommendation."],
      "rules",
    );
  }

  // The link must follow the description: when the reason text clearly
  // names a different verified option than the claimed id, re-point to
  // the described one before any price or budget check runs.
  if (target) {
    const resolvedId = resolveDescribedProduct(
      input.reason,
      ranked,
      target.product.id,
    );
    target =
      ranked.find((entry) => entry.product.id === resolvedId) ?? target;
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
        "INSUFFICIENT_EVIDENCE",
        "The AI recommendation did not name a verifiable option, so no recommendation can stand.",
        ["Re-run the search to get a fresh recommendation."],
        "rules",
      );
    }
    if (price == null) {
      return needsMore(
        "INSUFFICIENT_EVIDENCE",
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
