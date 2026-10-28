import { analyzeIntent } from "./rules";
import type { Budget, Confidence, Intent } from "./types";
import { getLlmProvider, type LlmProvider } from "../llm/provider";

export interface ResolvedIntent {
  intent: Intent;
  llmUsed: boolean;
  llmAvailable: boolean;
}

function normalizeBudget(
  min: number | null | undefined,
  max: number | null | undefined,
): Budget | undefined {
  const lo = min ?? undefined;
  const hi = max ?? undefined;
  if (lo == null && hi == null) {
    return undefined;
  }
  if (lo != null && hi != null && lo > hi) {
    return { min: hi, max: lo };
  }
  return { min: lo, max: hi };
}

/**
 * LLM-first intent resolution. The model interprets the query; validated
 * output wins, with missing budget sides filled from the rules parser.
 * Rules remain the fallback when the model is unavailable or fails, so the
 * app keeps working without an API key.
 */
export async function resolveIntent(
  query: string,
  provider?: LlmProvider | null,
): Promise<ResolvedIntent> {
  const rules = analyzeIntent(query);
  const llm = provider === undefined ? getLlmProvider() : provider;
  if (llm) {
    try {
      const extracted = await llm.extractIntent(query);
      const category =
        extracted.category === "general" && rules.category !== "general"
          ? rules.category
          : extracted.category;
      const confidence: Confidence =
        rules.category === extracted.category
          ? "high"
          : category === rules.category
            ? "medium"
            : "low";
      const intent: Intent = {
        query: rules.query,
        category,
        categoryConfidence: confidence,
        budgetInr: normalizeBudget(
          extracted.budgetInrMin ?? rules.budgetInr?.min,
          extracted.budgetInrMax ?? rules.budgetInr?.max,
        ),
        searchTerms: extracted.searchTerms,
      };
      return { intent, llmUsed: true, llmAvailable: true };
    } catch {
      // Fall through to the rules result; callers report rule-based mode.
    }
  }
  return { intent: rules, llmUsed: false, llmAvailable: llm !== null };
}
