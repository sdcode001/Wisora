import { analyzeIntent } from "./rules";
import type { Intent } from "./types";
import { getLlmProvider } from "../llm/provider";

export interface ResolvedIntent {
  intent: Intent;
  llmUsed: boolean;
  llmAvailable: boolean;
}

export async function resolveIntent(query: string): Promise<ResolvedIntent> {
  const rules = analyzeIntent(query);
  const provider = getLlmProvider();
  if (rules.categoryConfidence === "low" && provider) {
    try {
      const llm = await provider.extractIntent(query);
      const intent: Intent = {
        query: rules.query,
        category: llm.category,
        categoryConfidence: "medium",
        budgetInr:
          rules.budgetInr ??
          (llm.budgetInrMax == null
            ? undefined
            : { max: llm.budgetInrMax }),
        searchTerms: llm.searchTerms,
      };
      return { intent, llmUsed: true, llmAvailable: true };
    } catch {
      // Fall through to the rules result; callers report rule-based mode.
    }
  }
  return { intent: rules, llmUsed: false, llmAvailable: provider !== null };
}
