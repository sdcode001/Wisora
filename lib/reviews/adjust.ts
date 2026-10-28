import type { Category } from "../../config/sources";
import type { RequirementSet } from "../requirements/types";
import { contentTokens } from "../text/tokens";
import type {
  Contradiction,
  ReviewAdjustment,
  ReviewInsight,
} from "./types";

export const REVIEW_DELTA_MIN = -8;
export const REVIEW_DELTA_MAX = 5;

const CATEGORY_SENSITIVITY: Record<Category, string[]> = {
  electronics: ["battery", "overheating", "durability", "software", "performance"],
  fashion: ["sizing", "fabric", "quality", "fit"],
  footwear: ["comfort", "sizing", "fit", "durability"],
  beauty: ["irritation", "sensitivity", "allergy"],
  "home-kitchen": ["durability", "safety", "performance"],
  general: [],
};

function overlapsRequirement(
  insight: ReviewInsight,
  requirements: RequirementSet,
): string | null {
  const tokens = contentTokens(`${insight.category} ${insight.theme}`);
  for (const req of [...requirements.must, ...requirements.want]) {
    const reqTokens = contentTokens(req.label);
    if ([...reqTokens].some((t) => tokens.has(t))) {
      return req.label;
    }
  }
  return null;
}

export function computeReviewAdjustment(
  insights: ReviewInsight[],
  contradictions: Contradiction[],
  requirements: RequirementSet | undefined,
  category: Category,
): ReviewAdjustment {
  const usable = insights.filter(
    (i) => i.quality !== "preliminary" && i.sentiment !== "mixed",
  );
  if (usable.length === 0) {
    return { delta: 0, reasons: [], unknownDimension: true };
  }
  const contradicted = new Set(contradictions.map((c) => c.topic));
  const noted = new Set<string>();
  let delta = 0;
  const reasons: string[] = [];
  for (const insight of usable) {
    if (contradicted.has(insight.category)) {
      if (!noted.has(insight.category)) {
        noted.add(insight.category);
        reasons.push(
          `Conflicting reports on ${insight.category} — left unscored.`,
        );
      }
      continue;
    }
    let points = insight.sentiment === "negative" ? -3 : 2;
    const notes: string[] = [];
    const reqLabel = requirements
      ? overlapsRequirement(insight, requirements)
      : null;
    const text = `${insight.category} ${insight.theme}`.toLowerCase();
    const sensitive = (CATEGORY_SENSITIVITY[category] ?? []).some((k) =>
      text.includes(k),
    );
    if (reqLabel ?? sensitive) {
      points *= 2;
      notes.push(
        reqLabel
          ? `matches your requirement "${reqLabel}"`
          : `matters for ${category}`,
      );
    }
    delta += points;
    reasons.push(
      `${points > 0 ? "+" : ""}${points}: ${insight.theme} (${insight.distinctSources} sources${notes.length > 0 ? `; ${notes.join(", ")}` : ""}).`,
    );
  }
  const clamped = Math.max(
    REVIEW_DELTA_MIN,
    Math.min(REVIEW_DELTA_MAX, delta),
  );
  if (clamped !== delta) {
    reasons.push(
      `Capped at ${clamped > 0 ? "+" : ""}${clamped} to avoid overweighting review signals.`,
    );
  }
  return {
    delta: clamped,
    reasons: reasons.slice(0, 5),
    unknownDimension: false,
  };
}
