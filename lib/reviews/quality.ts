import type {
  Contradiction,
  InsightQuality,
  ReportQuality,
  ReviewInsight,
  ReviewRecord,
} from "./types";

export function gradeInsight(
  insight: ReviewInsight,
  records: Map<string, ReviewRecord>,
): ReviewInsight {
  const cited = insight.sources
    .map((id) => records.get(id))
    .filter((r): r is ReviewRecord => r != null);
  const types = new Set(cited.map((r) => r.sourceType));
  const hasExtract = cited.some((r) => r.contentSource === "extract");
  const hasStrongMatch = cited.some(
    (r) => r.relevance === "exact" || r.relevance === "likely",
  );
  const n = insight.distinctSources;
  let quality: InsightQuality = "preliminary";
  if (n >= 3 && hasStrongMatch && types.size >= 2 && hasExtract) {
    quality = "strong";
  } else if (n >= 2) {
    quality = "moderate";
  }
  const limitations = [...insight.limitations];
  if (n < 2) {
    limitations.push(
      "Single-source observation — treat as anecdotal, not a widespread pattern.",
    );
  }
  if (!hasStrongMatch) {
    limitations.push(
      "No exact model match — sources may describe a different variant.",
    );
  }
  if (!hasExtract) {
    limitations.push(
      "Based on search snippets only; full pages could not be extracted.",
    );
  }
  if (types.size === 1 && n >= 2) {
    limitations.push(
      `All ${n} sources are ${[...types][0]} sources; no independent corroboration across source types.`,
    );
  }
  return { ...insight, quality, limitations };
}

export function detectContradictions(
  insights: ReviewInsight[],
): Contradiction[] {
  const byCategory = new Map<string, ReviewInsight[]>();
  for (const insight of insights) {
    const group = byCategory.get(insight.category) ?? [];
    group.push(insight);
    byCategory.set(insight.category, group);
  }
  const out: Contradiction[] = [];
  for (const [topic, group] of byCategory) {
    const positive = group.filter((i) => i.sentiment === "positive");
    const negative = group.filter((i) => i.sentiment === "negative");
    if (positive.length === 0 || negative.length === 0 || out.length >= 5) {
      continue;
    }
    out.push({
      topic,
      positiveSources: [...new Set(positive.flatMap((i) => i.sources))],
      negativeSources: [...new Set(negative.flatMap((i) => i.sources))],
      note: `Sources disagree on ${topic}: some praise it, others report problems. Compare the linked sources before deciding.`,
    });
  }
  return out;
}

export function assessReport(
  usableCount: number,
  exactMatches: number,
  insights: ReviewInsight[],
): ReportQuality {
  let level: ReportQuality["level"];
  if (insights.length === 0) {
    level = usableCount >= 2 ? "weak" : "insufficient";
  } else if (
    insights.some((i) => i.quality === "strong") &&
    usableCount >= 3
  ) {
    level = "strong";
  } else if (
    insights.some((i) => i.quality === "strong") ||
    insights.some((i) => i.quality === "moderate")
  ) {
    level = "moderate";
  } else {
    level = "weak";
  }
  return { level, distinctSources: usableCount, exactMatches };
}
