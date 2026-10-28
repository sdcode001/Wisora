import type { ExcludedProduct } from "../eligibility/filter";
import type {
  ConfidenceAssessment,
} from "../evidence/quality";
import type { Intent } from "../intent/types";
import type { RankedProduct } from "./score";
import {
  deterministicVerdict,
  validateLlmVerdict,
  type LlmVerdictInput,
  type Recommendation,
} from "./verdict";

export const NEAR_TIE_POINTS = 5;

const WAIT_BANNED =
  /\b(sale|sales|discount|discounts|price\s*drops?|price\s*cuts?|prices?\s+(?:may|will|might|could|should)\s+(?:drop|fall)|launches|launch|festival|festivals|diwali|big\s*billion|offer\s*(soon|coming|upcoming)|deal\s*(soon|coming|upcoming))\b/i;

export function validateWaitReason(reason: string): boolean {
  return !WAIT_BANNED.test(reason);
}

export interface GroundingCorpus {
  amounts: number[];
  ratings: number[];
}

export function buildGroundingCorpus(
  ranked: RankedProduct[],
  intent: Intent,
): GroundingCorpus {
  const amounts: number[] = [];
  const ratings: number[] = [];
  for (const entry of ranked) {
    if (entry.product.priceInr != null) {
      amounts.push(entry.product.priceInr);
    }
    if (entry.product.rating != null) {
      ratings.push(entry.product.rating.value);
    }
  }
  if (intent.budgetInr?.min != null) {
    amounts.push(intent.budgetInr.min);
  }
  if (intent.budgetInr?.max != null) {
    amounts.push(intent.budgetInr.max);
  }
  // Verifiable arithmetic over evidenced numbers is allowed.
  const derived: number[] = [];
  for (const amount of amounts) {
    if (intent.budgetInr?.max != null) {
      derived.push(Math.abs(intent.budgetInr.max - amount));
    }
  }
  for (let i = 0; i < amounts.length; i += 1) {
    for (let j = i + 1; j < amounts.length; j += 1) {
      derived.push(Math.abs((amounts[i] as number) - (amounts[j] as number)));
    }
  }
  return { amounts: [...amounts, ...derived], ratings };
}

const MONEY_CLAIM_RE = /₹\s*([\d,]+(?:\.\d+)?)\s*(k|lakh|lakhs|l)?/gi;
const LAKH_CLAIM_RE = /(\d+(?:\.\d+)?)\s*lakh/gi;
const RATING_CLAIM_RE = /(\d\.\d)\s*(?:out of 5|stars?|★)/gi;

function collectClaims(
  re: RegExp,
  text: string,
  convert: (match: RegExpExecArray) => number | null,
): Array<{ raw: string; value: number }> {
  const out: Array<{ raw: string; value: number }> = [];
  re.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null && out.length < 30) {
    const value = convert(match);
    if (value != null && Number.isFinite(value)) {
      out.push({ raw: match[0], value });
    }
  }
  return out;
}

export function findUngroundedClaims(
  text: string,
  corpus: GroundingCorpus,
): string[] {
  const violations: string[] = [];
  const seen = new Set<string>();
  const check = (
    raw: string,
    value: number,
    pool: number[],
    describe: (r: string) => string,
  ): void => {
    const key = `${pool === corpus.amounts ? "inr" : "rating"}:${value}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    if (!pool.some((v) => Math.abs(v - value) < 0.001)) {
      violations.push(describe(raw));
    }
  };
  for (const claim of collectClaims(
    MONEY_CLAIM_RE,
    text,
    (m) => {
      const num = Number.parseFloat((m[1] ?? "").replace(/,/g, ""));
      if (!Number.isFinite(num)) {
        return null;
      }
      const unit = m[2]?.toLowerCase();
      if (unit === "k") {
        return num * 1000;
      }
      if (unit === "lakh" || unit === "lakhs" || unit === "l") {
        return num * 100000;
      }
      return num;
    },
  )) {
    check(claim.raw, Math.round(claim.value), corpus.amounts, (r) => `cites ${r} without evidence`);
  }
  for (const claim of collectClaims(LAKH_CLAIM_RE, text, (m) => {
    const num = Number.parseFloat(m[1] ?? "");
    return Number.isFinite(num) ? num * 100000 : null;
  })) {
    check(claim.raw, Math.round(claim.value), corpus.amounts, (r) => `cites ${r} without evidence`);
  }
  for (const claim of collectClaims(RATING_CLAIM_RE, text, (m) => {
    const num = Number.parseFloat(m[1] ?? "");
    return Number.isFinite(num) ? Math.round(num * 10) / 10 : null;
  })) {
    check(claim.raw, claim.value, corpus.ratings, (r) => `cites rating ${r} without evidence`);
  }
  return violations;
}

export interface PolicyInput {
  ranked: RankedProduct[];
  totalFound: number;
  excluded: ExcludedProduct[];
  intent: Intent;
  confidence: ConfidenceAssessment;
  llmVerdict?: LlmVerdictInput | undefined;
}

function fallbackNote(rec: Recommendation): Recommendation {
  return {
    ...rec,
    uncertainties: [
      ...rec.uncertainties,
      "AI suggestion failed validation; using rule-based outcome.",
    ],
  };
}

export function decideRecommendation(input: PolicyInput): Recommendation {
  if (input.totalFound === 0) {
    return {
      verdict: "INSUFFICIENT_EVIDENCE",
      reason:
        "No product listings were found across the searched sources, so there is nothing to recommend yet.",
      tradeoffs: [],
      uncertainties: [
        "Try broader search terms, a corrected category, or more sources.",
      ],
      source: "rules",
    };
  }
  if (input.ranked.length === 0) {
    const budgetBlocks = input.excluded.filter((entry) =>
      entry.reasons.some((reason) => reason.startsWith("Over budget")),
    ).length;
    const main =
      budgetBlocks > input.excluded.length / 2
        ? "Every option found exceeds the stated budget."
        : "Every option found fails a mandatory requirement or exclusion.";
    return {
      verdict: "NEEDS_CLARIFICATION",
      reason: `${main} ${input.excluded.length} option${input.excluded.length === 1 ? " was" : "s were"} excluded. Adjust the budget, relax a requirement, or broaden the search.`,
      tradeoffs: [],
      uncertainties: input.excluded
        .slice(0, 3)
        .flatMap((entry) => entry.reasons.slice(0, 1)),
      source: "rules",
    };
  }
  if (input.confidence.level === "low") {
    return {
      verdict: "INSUFFICIENT_EVIDENCE",
      reason: `Evidence is too thin to defend a recommendation (confidence ${input.confidence.score}/100).`,
      tradeoffs: [],
      uncertainties: input.confidence.gaps,
      source: "rules",
    };
  }

  const base = deterministicVerdict(input.ranked, input.intent);
  let rec = base;
  if (input.llmVerdict) {
    const validated = validateLlmVerdict(
      input.llmVerdict,
      input.ranked,
      input.intent,
    );
    if (validated.source === "llm") {
      const text = [
        validated.reason,
        ...validated.tradeoffs,
        ...validated.uncertainties,
      ].join("\n");
      const waitOk =
        validated.verdict !== "WAIT" ||
        validateWaitReason(validated.reason);
      const ungrounded = findUngroundedClaims(
        text,
        buildGroundingCorpus(input.ranked, input.intent),
      );
      rec = waitOk && ungrounded.length === 0 ? validated : fallbackNote(base);
    } else {
      rec = fallbackNote(validated);
    }
  }

  if (
    rec.verdict === "BUY" ||
    rec.verdict === "WAIT" ||
    rec.verdict === "AVOID"
  ) {
    if (
      input.confidence.level === "medium" &&
      input.confidence.gaps[0]
    ) {
      rec = {
        ...rec,
        uncertainties: [
          ...rec.uncertainties,
          `Evidence gap: ${input.confidence.gaps[0]}`,
        ],
      };
    }
    const [first, second] = input.ranked;
    if (
      first &&
      second &&
      first.score.total - second.score.total < NEAR_TIE_POINTS
    ) {
      rec = {
        ...rec,
        uncertainties: [
          ...rec.uncertainties,
          "Top two options scored within 5 points — compare them closely.",
        ],
      };
    }
  }
  return rec;
}
