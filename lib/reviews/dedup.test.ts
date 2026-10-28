import { describe, expect, it } from "vitest";
import { dedupeReviewRecords, usableRecords } from "./dedup";
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
    excerpt: `Battery life impresses on this model with comfortable fit and reliable performance across daily usage scenarios for extended periods. ${overrides.id}`,
    contentSource: "extract",
    retrievedAt: SEARCHED_AT,
    relevance: "exact",
    ...overrides,
  };
}

describe("dedupeReviewRecords", () => {
  it("merges identical URLs", () => {
    const { records, merged } = dedupeReviewRecords([
      record({ id: "a", url: "https://example.com/review?utm_source=x" }),
      record({ id: "b", url: "https://example.com/review" }),
    ]);
    expect(merged).toBe(1);
    expect(records.find((r) => r.id === "b")?.duplicateOf).toBe("a");
  });

  it("merges near-duplicate syndicated text", () => {
    const base =
      "The battery life impresses on this model with comfortable fit and reliable performance across daily usage scenarios for extended periods of time";
    const { records, merged } = dedupeReviewRecords([
      record({ id: "a", excerpt: `${base} overall verdict positive.` }),
      record({ id: "b", excerpt: `${base} overall verdict favorable.` }),
    ]);
    expect(merged).toBe(1);
    expect(records.find((r) => r.id === "b")?.duplicateOf).toBe("a");
  });

  it("keeps genuinely distinct records", () => {
    const { records, merged } = dedupeReviewRecords([
      record({
        id: "a",
        excerpt:
          "Battery life impresses with comfortable fit and reliable daily performance over many weeks of testing",
      }),
      record({
        id: "b",
        excerpt:
          "Overheating complaints dominate with poor durability and difficult warranty claims reported widely",
      }),
    ]);
    expect(merged).toBe(0);
    expect(records.every((r) => !r.duplicateOf)).toBe(true);
  });

  it("requires exact match for short excerpts", () => {
    const { merged } = dedupeReviewRecords([
      record({ id: "a", excerpt: "Great battery life overall" }),
      record({ id: "b", excerpt: "Great battery life indeed" }),
    ]);
    expect(merged).toBe(0);
  });
});

describe("usableRecords", () => {
  it("excludes duplicates and irrelevant records", () => {
    const records = usableRecords([
      record({ id: "a" }),
      record({ id: "b", duplicateOf: "a" }),
      record({ id: "c", relevance: "irrelevant" }),
    ]);
    expect(records.map((r) => r.id)).toEqual(["a"]);
  });
});
