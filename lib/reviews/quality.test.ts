import { describe, expect, it } from "vitest";
import {
  assessReport,
  detectContradictions,
  gradeInsight,
} from "./quality";
import type { ReviewInsight, ReviewRecord } from "./types";

const SEARCHED_AT = "2026-10-28T00:00:00.000Z";

function record(overrides: Partial<ReviewRecord> & { id: string }): ReviewRecord {
  return {
    productId: "p1",
    url: `https://example.com/${overrides.id}`,
    sourceId: "digit-in",
    sourceName: "Digit.in",
    sourceType: "editorial",
    title: "Review",
    excerpt: "Battery life impresses.",
    contentSource: "extract",
    retrievedAt: SEARCHED_AT,
    relevance: "exact",
    ...overrides,
  };
}

function insight(overrides: Partial<ReviewInsight> = {}): ReviewInsight {
  return {
    theme: "Strong battery life",
    category: "battery",
    sentiment: "positive",
    sources: ["a"],
    distinctSources: 1,
    quality: "preliminary",
    limitations: [],
    ...overrides,
  };
}

describe("gradeInsight", () => {
  it("grades multi-type corroborated insights strong", () => {
    const records = new Map([
      ["a", record({ id: "a" })],
      ["b", record({ id: "b", sourceType: "forum", sourceId: "reddit" })],
      ["c", record({ id: "c", sourceType: "retailer", sourceId: "amazon-in" })],
    ]);
    const graded = gradeInsight(
      insight({ sources: ["a", "b", "c"], distinctSources: 3 }),
      records,
    );
    expect(graded.quality).toBe("strong");
    expect(graded.limitations).toEqual([]);
  });

  it("caps two-source insights at moderate", () => {
    const records = new Map([
      ["a", record({ id: "a" })],
      ["b", record({ id: "b" })],
    ]);
    const graded = gradeInsight(
      insight({ sources: ["a", "b"], distinctSources: 2 }),
      records,
    );
    expect(graded.quality).toBe("moderate");
    expect(
      graded.limitations.some((l) => l.includes("no independent corroboration")),
    ).toBe(true);
  });

  it("labels single-source insights anecdotal", () => {
    const graded = gradeInsight(
      insight(),
      new Map([["a", record({ id: "a" })]]),
    );
    expect(graded.quality).toBe("preliminary");
    expect(graded.limitations.some((l) => l.includes("anecdotal"))).toBe(true);
  });

  it("flags weak matches and snippet-only evidence", () => {
    const graded = gradeInsight(
      insight({ sources: ["a", "b"], distinctSources: 2 }),
      new Map([
        ["a", record({ id: "a", relevance: "uncertain", contentSource: "snippet" })],
        ["b", record({ id: "b", relevance: "uncertain", contentSource: "snippet" })],
      ]),
    );
    expect(graded.quality).toBe("moderate");
    expect(
      graded.limitations.some((l) => l.includes("different variant")),
    ).toBe(true);
    expect(graded.limitations.some((l) => l.includes("snippets only"))).toBe(
      true,
    );
  });
});

describe("detectContradictions", () => {
  it("pairs opposing sentiments in the same category", () => {
    const out = detectContradictions([
      insight({ category: "battery", sentiment: "positive", sources: ["a"] }),
      insight({
        theme: "Battery drains fast",
        category: "battery",
        sentiment: "negative",
        sources: ["b"],
      }),
      insight({ category: "comfort", sentiment: "positive", sources: ["c"] }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      topic: "battery",
      positiveSources: ["a"],
      negativeSources: ["b"],
    });
  });

  it("returns nothing without opposition", () => {
    expect(
      detectContradictions([
        insight({ sentiment: "positive" }),
        insight({ theme: "Worse", sentiment: "mixed" }),
      ]),
    ).toEqual([]);
  });
});

describe("assessReport", () => {
  it("marks empty evidence insufficient", () => {
    expect(assessReport(0, 0, []).level).toBe("insufficient");
    expect(assessReport(1, 0, []).level).toBe("insufficient");
    expect(assessReport(2, 1, []).level).toBe("weak");
  });

  it("promotes strong corroborated coverage", () => {
    expect(
      assessReport(3, 2, [insight({ quality: "strong" })]).level,
    ).toBe("strong");
    expect(
      assessReport(2, 1, [insight({ quality: "strong" })]).level,
    ).toBe("moderate");
    expect(
      assessReport(2, 0, [insight({ quality: "moderate" })]).level,
    ).toBe("moderate");
    expect(assessReport(1, 0, [insight()]).level).toBe("weak");
  });
});
