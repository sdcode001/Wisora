import type { LlmReviewThemes } from "../llm/provider";
import {
  ReviewInsightSchema,
  type ReviewInsight,
  type ReviewRecord,
} from "./types";

const MAX_THEMES = 8;

function normalizeQuote(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 400);
}

/**
 * Validate LLM-extracted themes against the retrieved records. Drops themes
 * with no usable cited source, remaps duplicate records to their canonical
 * id, and strips excerpts that are not verbatim-grounded in a cited record.
 * Never throws on malformed model output — it filters.
 */
export function validateThemes(
  llm: LlmReviewThemes,
  records: ReviewRecord[],
): ReviewInsight[] {
  const byId = new Map(records.map((r) => [r.id, r]));
  const insights: ReviewInsight[] = [];
  for (const theme of (llm.themes ?? []).slice(0, MAX_THEMES)) {
    const canonical = new Set<string>();
    for (const sourceId of theme.sources ?? []) {
      const record = byId.get(sourceId);
      if (!record || record.relevance === "irrelevant") {
        continue;
      }
      canonical.add(record.duplicateOf ?? record.id);
    }
    if (canonical.size === 0) {
      continue;
    }
    const sources = [...canonical];
    let excerpt: string | undefined;
    if (theme.excerpt) {
      const quote = normalizeQuote(theme.excerpt);
      const grounded =
        quote.length >= 20 &&
        sources.some((id) => {
          const text = byId.get(id)?.excerpt ?? "";
          return normalizeQuote(text).includes(quote);
        });
      if (grounded) {
        excerpt = theme.excerpt.slice(0, 500);
      }
    }
    const parsed = ReviewInsightSchema.safeParse({
      theme: theme.theme.trim(),
      category: theme.category.trim().toLowerCase(),
      sentiment: theme.sentiment,
      sources,
      distinctSources: sources.length,
      ...(excerpt ? { excerpt } : {}),
      quality: "preliminary",
      limitations: [],
    });
    if (parsed.success) {
      insights.push(parsed.data);
    }
  }
  return insights;
}
