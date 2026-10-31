import type { MemoryStore } from "../memory/store";
import { formatInr } from "../text/format";
import type { NewOpportunity, OpportunityRelevance } from "./schema";

export interface RelevanceInput {
  store: MemoryStore;
  userSub: string;
  opportunity: NewOpportunity;
}

export interface RelevanceVerdict {
  relevant: boolean;
  relevance: OpportunityRelevance;
  /** Set when relevant is false: the human-readable suppression reason. */
  suppressedReason?: string;
}

const KIND_WEIGHTS: Record<NewOpportunity["kind"], number> = {
  "target-reached": 30,
  "back-in-range": 20,
  "price-drop": 15,
  restored: 15,
  "reminder-due": 15,
  "price-increase": 10,
  unavailable: 10,
};

const BASE_SCORE = 50;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** True when the brand appears as a whole word in the title or merchant. */
function matchesBrand(title: string, merchant: string, brand: string): boolean {
  const needle = brand.trim().toLowerCase();
  if (!needle) {
    return false;
  }
  const pattern = new RegExp(`\\b${escapeRegExp(needle)}\\b`, "i");
  return pattern.test(title) || pattern.test(merchant);
}

/**
 * Score a candidate opportunity against the user's saved profile and
 * feedback. Hard suppression is reserved for explicit "no" signals —
 * avoided brands, rejected or already-purchased products. Everything else
 * scores: watches are explicit tracking intent, so even over-budget or
 * off-category items stay visible, just ranked lower. No profile (signed
 * out or never saved) means neutral acceptance.
 */
export async function evaluateRelevance(
  input: RelevanceInput,
): Promise<RelevanceVerdict> {
  const { store, userSub, opportunity } = input;
  const neutral = (): RelevanceVerdict => ({
    relevant: true,
    relevance: { score: BASE_SCORE, reasons: [] },
  });
  const profile = await store.getProfile(userSub).catch(() => null);
  if (!profile) {
    return neutral();
  }

  const general = profile.general.value;
  for (const brand of general.avoidedBrands) {
    if (matchesBrand(opportunity.title, opportunity.merchant, brand)) {
      return {
        relevant: false,
        relevance: { score: 0, reasons: [] },
        suppressedReason: `"${brand.trim()}" is on your avoided-brands list.`,
      };
    }
  }

  const feedback = await store.listFeedback(userSub).catch(() => []);
  for (const entry of feedback) {
    if (entry.rejected?.productId === opportunity.productId) {
      return {
        relevant: false,
        relevance: { score: 0, reasons: [] },
        suppressedReason: "You previously rejected this product.",
      };
    }
    if (entry.purchased?.productId === opportunity.productId) {
      return {
        relevant: false,
        relevance: { score: 0, reasons: [] },
        suppressedReason: "You already purchased this product.",
      };
    }
  }

  let score = BASE_SCORE + KIND_WEIGHTS[opportunity.kind];
  const reasons: string[] = [];

  const preferredBrand = general.preferredBrands.find((brand) =>
    matchesBrand(opportunity.title, opportunity.merchant, brand),
  );
  if (preferredBrand) {
    score += 10;
    reasons.push(`Matches your preferred brand "${preferredBrand.trim()}".`);
  }
  if (
    general.preferredMerchants.some(
      (merchant) =>
        merchant.trim().toLowerCase() ===
        opportunity.merchant.trim().toLowerCase(),
    )
  ) {
    score += 5;
    reasons.push(`Sold by preferred merchant ${opportunity.merchant}.`);
  }

  const category = opportunity.category;
  if (category) {
    if (
      general.categories.length > 0 &&
      !general.categories.includes(category)
    ) {
      score -= 5;
      reasons.push("Outside your selected categories.");
    }
    const budget = profile.categories[category]?.value.budgetInr;
    const price = opportunity.currentPriceInr;
    if (budget?.max != null && price != null) {
      if (price <= budget.max) {
        score += 5;
        reasons.push(`Within your ${category} budget.`);
      } else {
        score -= 10;
        reasons.push(
          `${formatInr(price - budget.max)} above your ${category} budget.`,
        );
      }
    }
  }

  return {
    relevant: true,
    relevance: {
      score: Math.min(100, Math.max(0, Math.round(score))),
      reasons: reasons.slice(0, 10),
    },
  };
}
