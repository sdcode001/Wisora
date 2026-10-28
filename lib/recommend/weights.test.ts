import { describe, expect, it } from "vitest";
import {
  DEFAULT_WEIGHTS,
  normalizeWeights,
  ScoreWeightsSchema,
} from "./weights";

describe("ScoreWeightsSchema", () => {
  it("accepts the defaults", () => {
    expect(ScoreWeightsSchema.safeParse(DEFAULT_WEIGHTS).success).toBe(true);
  });

  it("rejects weights that do not sum to 100", () => {
    expect(
      ScoreWeightsSchema.safeParse({
        price: 50,
        relevance: 50,
        evidence: 50,
        wants: 50,
      }).success,
    ).toBe(false);
  });

  it("rejects negative and oversized weights", () => {
    expect(
      ScoreWeightsSchema.safeParse({
        price: -10,
        relevance: 50,
        evidence: 30,
        wants: 30,
      }).success,
    ).toBe(false);
    expect(
      ScoreWeightsSchema.safeParse({
        price: 100,
        relevance: 100,
        evidence: -50,
        wants: -50,
      }).success,
    ).toBe(false);
  });
});

describe("normalizeWeights", () => {
  it("scales partial weights to 100 preserving proportions", () => {
    expect(
      normalizeWeights({ price: 1, relevance: 1, evidence: 1, wants: 1 }),
    ).toEqual({ price: 25, relevance: 25, evidence: 25, wants: 25 });
  });

  it("falls back to defaults for all-zero input", () => {
    expect(
      normalizeWeights({ price: 0, relevance: 0, evidence: 0, wants: 0 }),
    ).toEqual(DEFAULT_WEIGHTS);
  });

  it("fixes rounding drift so the total is exactly 100", () => {
    const weights = normalizeWeights({
      price: 1,
      relevance: 1,
      evidence: 1,
      wants: 0,
    });
    expect(
      weights.price + weights.relevance + weights.evidence + weights.wants,
    ).toBe(100);
    expect(weights.wants).toBe(0);
  });
});
