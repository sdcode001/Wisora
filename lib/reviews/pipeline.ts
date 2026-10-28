import type { Category } from "../../config/sources";
import type { LlmReviewThemes } from "../llm/provider";
import type { RequirementSet } from "../requirements/types";
import { computeReviewAdjustment } from "./adjust";
import { dedupeReviewRecords, usableRecords } from "./dedup";
import {
  assessReport,
  detectContradictions,
  gradeInsight,
} from "./quality";
import { validateThemes } from "./themes";
import type { ProductReviewReport, ReviewRecord } from "./types";

export interface BuildReportInput {
  productId: string;
  records: ReviewRecord[];
  llmThemes: LlmReviewThemes | null;
  failureNotes: string[];
  requirements?: RequirementSet;
  category: Category;
  currentTotal?: number;
  searchedAt: string;
}

/**
 * Deterministic report assembly: dedup → validate → grade → contradictions
 * → quality → adjustment. The only non-deterministic input is the already-
 * retrieved records and the validated LLM themes object.
 */
export function buildProductReport(
  input: BuildReportInput,
): ProductReviewReport {
  const { records } = dedupeReviewRecords(input.records);
  const usable = usableRecords(records);
  const byId = new Map(records.map((r) => [r.id, r]));
  const insights = validateThemes(
    input.llmThemes ?? { themes: [] },
    records,
  ).map((insight) => gradeInsight(insight, byId));
  const contradictions = detectContradictions(insights);
  const quality = assessReport(
    usable.length,
    usable.filter((r) => r.relevance === "exact").length,
    insights,
  );
  const adjustment = computeReviewAdjustment(
    insights,
    contradictions,
    input.requirements,
    input.category,
  );
  const adjustedTotal =
    input.currentTotal == null
      ? null
      : Math.max(0, Math.min(100, input.currentTotal + adjustment.delta));

  const limitations = [...input.failureNotes];
  if (usable.length === 0) {
    limitations.push(
      "No usable review evidence found for this product — scores are unchanged.",
    );
  } else if (insights.length === 0) {
    limitations.push(
      "Review pages were found but no recurring themes could be confirmed — scores are unchanged.",
    );
  }
  if (input.llmThemes == null && usable.length > 0) {
    limitations.push(
      "AI theme extraction was unavailable — showing sources without grouped insights.",
    );
  }
  return {
    productId: input.productId,
    records,
    insights,
    contradictions,
    quality,
    adjustment,
    adjustedTotal,
    limitations: limitations.slice(0, 5),
    searchedAt: input.searchedAt,
  };
}

export function describeRankImpact(
  totals: Array<{ id: string; total: number }>,
  adjusted: Map<string, number>,
): { notes: string[]; wouldChangeTopPick: boolean } {
  if (totals.length < 2) {
    return { notes: [], wouldChangeTopPick: false };
  }
  const before = [...totals].sort((a, b) => b.total - a.total);
  const after = [...totals]
    .map((t) => ({ id: t.id, total: adjusted.get(t.id) ?? t.total }))
    .sort((a, b) => b.total - a.total);
  const rankBefore = new Map(before.map((t, i) => [t.id, i + 1]));
  const notes: string[] = [];
  for (const [index, entry] of after.entries()) {
    const rank = index + 1;
    const previous = rankBefore.get(entry.id) ?? rank;
    if (previous !== rank && notes.length < 3) {
      const direction = rank < previous ? "rise" : "fall";
      notes.push(
        `On review evidence, option ${entry.id} would ${direction} from #${previous} to #${rank}.`,
      );
    }
  }
  return {
    notes,
    wouldChangeTopPick: (after[0]?.id ?? null) !== (before[0]?.id ?? null),
  };
}
