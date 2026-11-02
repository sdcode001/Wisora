import { describe, expect, it } from "vitest";
import type { Intent } from "../intent/types";
import type { LlmProvider, LlmRequirements } from "../llm/provider";
import {
  decideClarification,
  exclusionsFromAnswer,
  extractExclusionRules,
  extractRequirements,
} from "./extract";
import type { RequirementSet } from "./types";

function intent(overrides: Partial<Intent> = {}): Intent {
  return {
    query: "laptop",
    category: "electronics",
    categoryConfidence: "high",
    searchTerms: "laptop",
    ...overrides,
  };
}

function requirements(overrides: Partial<RequirementSet> = {}): RequirementSet {
  return {
    category: "electronics",
    must: [],
    want: [],
    exclude: [],
    unanswered: [],
    ...overrides,
  };
}

function stubProvider(available: boolean, value: LlmRequirements): LlmProvider {
  return {
    name: "stub",
    available,
    extractIntent: () => Promise.reject(new Error("unused")),
    explainVerdict: () => Promise.reject(new Error("unused")),
    extractRequirements: () => Promise.resolve(value),
    extractReviewThemes: () => Promise.reject(new Error("unused")),
    answerGrounded: () => Promise.reject(new Error("unused")),
  };
}

describe("extractExclusionRules", () => {
  it("captures no/without/avoid exclusions", () => {
    const rules = extractExclusionRules(
      "laptop with no webcam and without fingerprint reader, avoid refurbished",
    );
    expect(rules.map((r) => r.key)).toEqual([
      "webcam",
      "fingerprint-reader",
      "refurbished",
    ]);
    expect(rules[0]).toMatchObject({
      label: "webcam",
      kind: "exclude",
      importance: 1,
    });
  });

  it("keeps numbers inside exclusion labels", () => {
    const rules = extractExclusionRules("phone with no oled 120hz display");
    expect(rules.map((r) => r.label)).toEqual(["oled 120hz display"]);
  });

  it("returns nothing without exclusion markers", () => {
    expect(extractExclusionRules("good laptop with 16GB RAM")).toEqual([]);
  });
});

describe("extractRequirements", () => {
  const llmValue: LlmRequirements = {
    useContext: "gaming",
    must: [{ key: "ram-16gb", label: "16GB RAM" }],
    want: [{ key: "rgb", label: "RGB keyboard", importance: 0.7 }],
    exclude: [{ key: "webcam", label: "webcam cover" }],
    unanswered: ["What screen size do you prefer?"],
  };

  it("merges rules exclusions with LLM requirements", async () => {
    const { requirements: reqs, questions } = await extractRequirements(
      "gaming laptop with no webcam",
      intent({ query: "gaming laptop with no webcam" }),
      { provider: stubProvider(true, llmValue) },
    );
    expect(reqs.useContext).toBe("gaming");
    expect(reqs.must.map((r) => r.key)).toEqual(["ram-16gb"]);
    expect(reqs.must[0]).toMatchObject({ kind: "must", importance: 1 });
    expect(reqs.want[0]).toMatchObject({ importance: 0.7 });
    // Rules exclusion wins over the same LLM key.
    expect(reqs.exclude.map((r) => r.key)).toEqual(["webcam"]);
    expect(reqs.exclude[0]?.evidence).toContain("no webcam");
    expect(reqs.unanswered).toEqual(["What screen size do you prefer?"]);
    expect(questions.map((q) => q.id)).toEqual(["q0"]);
  });

  it("skips the LLM when the provider is unavailable", async () => {
    const { requirements: reqs, questions } = await extractRequirements(
      "laptop with no webcam",
      intent(),
      { provider: stubProvider(false, llmValue) },
    );
    expect(reqs.must).toEqual([]);
    expect(reqs.exclude.map((r) => r.key)).toEqual(["webcam"]);
    expect(questions.map((q) => q.id)).toEqual(["use", "avoid"]);
  });

  it("suppresses questions once answers arrive", async () => {
    const { questions } = await extractRequirements("laptop", intent(), {
      provider: stubProvider(true, llmValue),
      answers: [{ questionId: "q0", value: "15 inch" }],
    });
    expect(questions).toEqual([]);
  });
});

describe("decideClarification", () => {
  it("asks category when confidence is low", () => {
    const questions = decideClarification(
      intent({ categoryConfidence: "low" }),
      requirements({ unanswered: ["Size?", "Color?", "Brand?"] }),
    );
    expect(questions.map((q) => q.id)).toEqual(["category", "q0"]);
    expect(questions[0]?.options?.length).toBeGreaterThan(0);
  });

  it("asks nothing when everything is clear", () => {
    expect(decideClarification(intent(), requirements())).toEqual([]);
  });

  it("falls back to use/avoid questions without a model", () => {
    expect(
      decideClarification(intent(), requirements(), false).map((q) => q.id),
    ).toEqual(["use", "avoid"]);
  });

  it("keeps category first, then use, without a model", () => {
    expect(
      decideClarification(
        intent({ categoryConfidence: "low" }),
        requirements(),
        false,
      ).map((q) => q.id),
    ).toEqual(["category", "use"]);
  });
});

describe("rule-based mode (no provider)", () => {
  it("asks fallback questions instead of silently skipping", async () => {
    const { questions } = await extractRequirements("laptop", intent(), {
      provider: null,
    });
    expect(questions.map((q) => q.id)).toEqual(["use", "avoid"]);
  });

  it("incorporates fallback answers into requirements", async () => {
    const { requirements: reqs, questions } = await extractRequirements(
      "laptop",
      intent(),
      {
        provider: null,
        answers: [
          { questionId: "use", value: "coding and travel" },
          { questionId: "avoid", value: "Sony, refurbished" },
        ],
      },
    );
    expect(questions).toEqual([]);
    expect(reqs.useContext).toBe("coding and travel");
    expect(reqs.exclude.map((r) => r.key)).toEqual([
      "sony",
      "refurbished",
    ]);
  });

  it("treats a 'none' avoid answer as no exclusions", async () => {
    const { requirements: reqs } = await extractRequirements(
      "laptop",
      intent(),
      {
        provider: null,
        answers: [
          { questionId: "use", value: "coding" },
          { questionId: "avoid", value: "none" },
        ],
      },
    );
    expect(reqs.exclude).toEqual([]);
  });
});

describe("exclusionsFromAnswer", () => {
  it("splits comma- and and-separated labels", () => {
    expect(exclusionsFromAnswer("Sony, refurbished and open-box").map((r) => r.key)).toEqual([
      "sony",
      "refurbished",
      "open-box",
    ]);
  });

  it("drops empties, stoplist words, and bare 'none'", () => {
    expect(exclusionsFromAnswer("none")).toEqual([]);
    expect(exclusionsFromAnswer("a, the, idea")).toEqual([]);
  });
});
