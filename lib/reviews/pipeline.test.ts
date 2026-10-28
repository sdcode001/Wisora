import { describe, expect, it } from "vitest";
import {
  buildProductReport,
  describeRankImpact,
} from "./pipeline";
import type { ReviewRecord } from "./types";

const SEARCHED_AT = "2026-10-28T00:00:00.000Z";

function record(overrides: Partial<ReviewRecord> & { id: string }): ReviewRecord {
  return {
    productId: "p1",
    url: `https://example.com/${overrides.id}`,
    sourceId: "digit-in",
    sourceName: "Digit.in",
    sourceType: "editorial",
    title: "Review",
    excerpt: "Battery life impresses on this model with comfortable fit",
    contentSource: "extract",
    retrievedAt: SEARCHED_AT,
    relevance: "exact",
    ...overrides,
  };
}

describe("buildProductReport", () => {
  it("assembles insights, quality, and adjustments end to end", () => {
    const report = buildProductReport({
      productId: "p1",
      records: [
        record({ id: "a" }),
        record({
          id: "b",
          url: "https://forum.example.com/b",
          sourceType: "forum",
          sourceId: "reddit",
          excerpt:
            "Owners praise the comfortable fit and reliable performance in daily use",
        }),
        record({
          id: "c",
          url: "https://retail.example.com/c",
          sourceType: "retailer",
          sourceId: "amazon-in",
          excerpt:
            "Buyers report impressive battery endurance and solid build quality",
        }),
      ],
      llmThemes: {
        themes: [
          {
            theme: "Strong battery life",
            category: "battery",
            sentiment: "positive",
            sources: ["a", "b", "c"],
            excerpt: "Battery life impresses on this model",
          },
        ],
      },
      failureNotes: [],
      category: "electronics",
      currentTotal: 80,
      searchedAt: SEARCHED_AT,
    });
    expect(report.insights).toHaveLength(1);
    expect(report.insights[0]?.quality).toBe("strong");
    expect(report.quality.level).toBe("strong");
    // +2 base, doubled for electronics battery sensitivity, capped at +5.
    expect(report.adjustment.delta).toBe(4);
    expect(report.adjustedTotal).toBe(84);
    expect(report.contradictions).toEqual([]);
  });

  it("reports limitations when evidence is thin", () => {
    const report = buildProductReport({
      productId: "p1",
      records: [record({ id: "a", relevance: "uncertain" })],
      llmThemes: { themes: [] },
      failureNotes: ["Page extraction failed for one source."],
      category: "general",
      searchedAt: SEARCHED_AT,
    });
    expect(report.insights).toEqual([]);
    expect(report.quality.level).toBe("insufficient");
    expect(report.adjustment.unknownDimension).toBe(true);
    expect(report.adjustedTotal).toBeNull();
    expect(report.limitations.length).toBeGreaterThanOrEqual(2);
  });

  it("handles unavailable theme extraction honestly", () => {
    const report = buildProductReport({
      productId: "p1",
      records: [record({ id: "a" }), record({ id: "b" })],
      llmThemes: null,
      failureNotes: [],
      category: "general",
      searchedAt: SEARCHED_AT,
    });
    expect(report.records).toHaveLength(2);
    expect(report.insights).toEqual([]);
    expect(
      report.limitations.some((l) => l.includes("theme extraction")),
    ).toBe(true);
  });

  it("surfaces contradictions without scoring them", () => {
    const report = buildProductReport({
      productId: "p1",
      records: [
        record({ id: "a" }),
        record({ id: "b", excerpt: "Battery drains fast under load daily" }),
      ],
      llmThemes: {
        themes: [
          {
            theme: "Strong battery life",
            category: "battery",
            sentiment: "positive",
            sources: ["a", "b"],
          },
          {
            theme: "Battery drains fast",
            category: "battery",
            sentiment: "negative",
            sources: ["a", "b"],
          },
        ],
      },
      failureNotes: [],
      category: "general",
      currentTotal: 70,
      searchedAt: SEARCHED_AT,
    });
    expect(report.contradictions).toHaveLength(1);
    expect(report.adjustment.delta).toBe(0);
    expect(report.adjustedTotal).toBe(70);
  });
});

describe("describeRankImpact", () => {
  it("detects rank changes from adjusted totals", () => {
    const result = describeRankImpact(
      [
        { id: "a", total: 90 },
        { id: "b", total: 88 },
      ],
      new Map([
        ["a", 82],
        ["b", 89],
      ]),
    );
    expect(result.wouldChangeTopPick).toBe(true);
    expect(result.notes).toHaveLength(2);
    expect(result.notes[0]).toContain("rise from #2 to #1");
  });

  it("stays quiet without changes", () => {
    const result = describeRankImpact(
      [
        { id: "a", total: 90 },
        { id: "b", total: 80 },
      ],
      new Map([
        ["a", 92],
        ["b", 81],
      ]),
    );
    expect(result.wouldChangeTopPick).toBe(false);
    expect(result.notes).toEqual([]);
  });
});
