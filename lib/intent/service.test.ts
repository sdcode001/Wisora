import { describe, expect, it } from "vitest";
import type { LlmIntent, LlmProvider } from "../llm/provider";
import { resolveIntent } from "./service";

function stubProvider(
  value: LlmIntent | null,
  calls: string[] = [],
): LlmProvider {
  return {
    name: "stub",
    available: true,
    extractIntent: (query: string) => {
      calls.push(query);
      return value
        ? Promise.resolve(value)
        : Promise.reject(new Error("model failed"));
    },
    explainVerdict: () => Promise.reject(new Error("unused")),
    extractRequirements: () => Promise.reject(new Error("unused")),
    extractReviewThemes: () => Promise.reject(new Error("unused")),
    answerGrounded: () => Promise.reject(new Error("unused")),
  };
}

describe("resolveIntent", () => {
  it("prefers validated LLM output", async () => {
    const resolved = await resolveIntent(
      "something for morning runs that is easy on knees, around 8k",
      stubProvider({
        category: "footwear",
        budgetInrMin: null,
        budgetInrMax: 8000,
        searchTerms: "cushioned running shoes",
      }),
    );
    expect(resolved.llmUsed).toBe(true);
    expect(resolved.intent.category).toBe("footwear");
    expect(resolved.intent.budgetInr).toEqual({ min: undefined, max: 8000 });
    expect(resolved.intent.searchTerms).toBe("cushioned running shoes");
  });

  it("fills missing LLM budget sides from rules", async () => {
    const resolved = await resolveIntent(
      "laptop under ₹90,000 for development",
      stubProvider({
        category: "electronics",
        budgetInrMin: null,
        budgetInrMax: null,
        searchTerms: "laptop development",
      }),
    );
    expect(resolved.intent.budgetInr).toEqual({
      min: undefined,
      max: 90000,
    });
  });

  it("falls back to rules when the model fails", async () => {
    const resolved = await resolveIntent(
      "laptop under ₹90,000",
      stubProvider(null),
    );
    expect(resolved.llmUsed).toBe(false);
    expect(resolved.intent.category).toBe("electronics");
    expect(resolved.intent.budgetInr).toEqual({ max: 90000 });
  });

  it("uses rules when no provider is available", async () => {
    const resolved = await resolveIntent("laptop under ₹90,000", null);
    expect(resolved.llmUsed).toBe(false);
    expect(resolved.llmAvailable).toBe(false);
    expect(resolved.intent.budgetInr).toEqual({ max: 90000 });
  });

  it("marks category disagreement as low confidence", async () => {
    const resolved = await resolveIntent(
      "laptop under ₹90,000",
      stubProvider({
        category: "fashion",
        budgetInrMin: null,
        budgetInrMax: 90000,
        searchTerms: "laptop",
      }),
    );
    expect(resolved.intent.category).toBe("fashion");
    expect(resolved.intent.categoryConfidence).toBe("low");
  });

  it("keeps a concrete rules category over LLM general", async () => {
    const resolved = await resolveIntent(
      "mixer grinder between 3000 and 5000",
      stubProvider({
        category: "general",
        budgetInrMin: 3000,
        budgetInrMax: 5000,
        searchTerms: "mixer grinder",
      }),
    );
    expect(resolved.intent.category).toBe("home-kitchen");
    expect(resolved.intent.categoryConfidence).toBe("medium");
    expect(resolved.intent.budgetInr).toEqual({ min: 3000, max: 5000 });
  });
});
