import { describe, expect, it } from "vitest";
import { computeReviewAdjustment } from "./adjust";
import type { RequirementSet } from "../requirements/types";
import type { ReviewInsight } from "./types";

function insight(overrides: Partial<ReviewInsight> = {}): ReviewInsight {
  return {
    theme: "Strong battery life",
    category: "battery",
    sentiment: "positive",
    sources: ["a", "b"],
    distinctSources: 2,
    quality: "moderate",
    limitations: [],
    ...overrides,
  };
}

function requirements(): RequirementSet {
  return {
    category: "footwear",
    must: [],
    want: [
      {
        key: "comfort",
        label: "comfortable fit",
        kind: "want",
        importance: 0.8,
      },
    ],
    exclude: [],
    unanswered: [],
  };
}

describe("computeReviewAdjustment", () => {
  it("returns unknown when nothing usable exists", () => {
    expect(
      computeReviewAdjustment(
        [insight({ quality: "preliminary" })],
        [],
        requirements(),
        "footwear",
      ),
    ).toEqual({ delta: 0, reasons: [], unknownDimension: true });
    expect(computeReviewAdjustment([], [], undefined, "general")).toMatchObject(
      { delta: 0, unknownDimension: true },
    );
  });

  it("scores positives up and negatives down", () => {
    const result = computeReviewAdjustment(
      [
        insight(),
        insight({
          theme: "Overheating under load",
          category: "overheating",
          sentiment: "negative",
        }),
      ],
      [],
      undefined,
      "general",
    );
    expect(result.delta).toBe(-1);
    expect(result.unknownDimension).toBe(false);
    expect(result.reasons).toHaveLength(2);
  });

  it("doubles insights matching user requirements", () => {
    const result = computeReviewAdjustment(
      [
        insight({
          theme: "Uncomfortable fit pinches toes",
          category: "comfort",
          sentiment: "negative",
        }),
      ],
      [],
      requirements(),
      "general",
    );
    expect(result.delta).toBe(-6);
    expect(result.reasons[0]).toContain("comfortable fit");
  });

  it("doubles category-sensitive insights", () => {
    const result = computeReviewAdjustment(
      [
        insight({
          theme: "Uncomfortable fit pinches toes",
          category: "comfort",
          sentiment: "negative",
        }),
      ],
      [],
      undefined,
      "footwear",
    );
    expect(result.delta).toBe(-6);
    expect(result.reasons[0]).toContain("footwear");
  });

  it("leaves contradicted categories unscored", () => {
    const result = computeReviewAdjustment(
      [insight({ sentiment: "negative", theme: "Battery drains fast" })],
      [
        {
          topic: "battery",
          positiveSources: ["x"],
          negativeSources: ["a"],
          note: "Disagree.",
        },
      ],
      undefined,
      "general",
    );
    expect(result.delta).toBe(0);
    expect(result.reasons[0]).toContain("Conflicting reports");
  });

  it("caps large swings", () => {
    const result = computeReviewAdjustment(
      [
        insight({ theme: "Bad one", sentiment: "negative" }),
        insight({ theme: "Bad two", sentiment: "negative", category: "value" }),
        insight({
          theme: "Bad three",
          sentiment: "negative",
          category: "support",
        }),
      ],
      [],
      undefined,
      "general",
    );
    expect(result.delta).toBe(-8);
    expect(result.reasons.some((r) => r.includes("Capped"))).toBe(true);
  });

  it("ignores mixed sentiment for scoring", () => {
    const result = computeReviewAdjustment(
      [insight({ sentiment: "mixed" })],
      [],
      undefined,
      "general",
    );
    expect(result.unknownDimension).toBe(true);
  });
});
