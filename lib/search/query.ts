import { OVER_BUDGET_TOLERANCE } from "../eligibility/filter";
import type { Budget } from "../intent/types";

/**
 * The budget ceiling a search (or filter) should honor. Strict mode keeps
 * the user's stated max; flexible mode allows the same 25% tolerance the
 * recommender uses, so search and scoring agree on what "near budget" is.
 */
export function effectiveBudgetMax(
  budget: Budget | undefined,
  allowOverBudget: boolean,
): number | null {
  const max = budget?.max;
  if (max == null) {
    return null;
  }
  if (!allowOverBudget) {
    return max;
  }
  return Math.round(max * OVER_BUDGET_TOLERANCE);
}

const PRICE_HINT_RE = /₹|\brs\.?\b|\binr\b|\blakhs?\b|\bthousands?\b/i;

/**
 * Append an expanded-ceiling hint to Tavily query terms when (and only
 * when) flexible mode actually raises a stated max. Terms that already
 * carry a price hint are left alone — never duplicated.
 */
export function searchTermsWithBudget(
  searchTerms: string,
  effectiveMax: number | null,
  allowOverBudget: boolean,
): string {
  if (!allowOverBudget || effectiveMax == null) {
    return searchTerms;
  }
  if (PRICE_HINT_RE.test(searchTerms)) {
    return searchTerms;
  }
  return `${searchTerms} under ₹${effectiveMax}`;
}
