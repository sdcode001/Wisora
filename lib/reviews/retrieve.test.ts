import { describe, expect, it } from "vitest";
import { REVIEW_SOURCES } from "../../config/review-sources";
import { buildRecords, buildReviewQuery } from "./retrieve";

const SEARCHED_AT = "2026-10-28T00:00:00.000Z";

describe("buildReviewQuery", () => {
  it("appends review to the product terms", () => {
    expect(buildReviewQuery("Sony WH-1000XM5 Wireless Headphones")).toContain(
      "review",
    );
    expect(buildReviewQuery("Sony WH-1000XM5 Wireless Headphones")).toContain(
      "1000xm5",
    );
  });
});

describe("buildRecords", () => {
  const sources = REVIEW_SOURCES;

  it("attributes results to review sources and grades relevance", () => {
    const records = buildRecords({
      product: { id: "p1", title: "Sony WH-1000XM5 Wireless Headphones" },
      results: [
        {
          title: "Sony WH-1000XM5 review",
          url: "https://www.digit.in/reviews/sony-wh-1000xm5",
          content: "Great sound.",
          score: 90,
        },
        {
          title: "Unrelated shopping page",
          url: "https://www.amazon.in/dp/B0X",
          content: "Buy now.",
          score: 80,
        },
      ],
      pages: new Map([
        [
          "https://www.digit.in/reviews/sony-wh-1000xm5",
          {
            url: "https://www.digit.in/reviews/sony-wh-1000xm5",
            text: "Full review text with battery praise.",
            images: [],
          },
        ],
      ]),
      sources,
      competingModels: [],
      searchedAt: SEARCHED_AT,
    });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      productId: "p1",
      sourceId: "digit-in",
      sourceType: "editorial",
      contentSource: "extract",
      relevance: "exact",
    });
    expect(records[0]?.id.startsWith("rev-")).toBe(true);
  });

  it("falls back to snippets when extraction missed a page", () => {
    const records = buildRecords({
      product: { id: "p1", title: "Sony WH-1000XM5 Wireless Headphones" },
      results: [
        {
          title: "WH-1000XM5 discussion",
          url: "https://www.reddit.com/r/headphones/comments/x",
          content: "Snippet about comfort.",
          score: 70,
        },
      ],
      pages: new Map(),
      sources,
      competingModels: [],
      searchedAt: SEARCHED_AT,
    });
    expect(records[0]).toMatchObject({
      sourceId: "reddit",
      contentSource: "snippet",
      excerpt: "Snippet about comfort.",
    });
  });

  it("marks rival-model pages irrelevant in batch context", () => {
    const records = buildRecords({
      product: { id: "p1", title: "Sony WH-1000XM5 Wireless Headphones" },
      results: [
        {
          title: "Bose QC45 review",
          url: "https://www.digit.in/reviews/bose-qc45",
          content: "A solid alternative.",
          score: 70,
        },
      ],
      pages: new Map(),
      sources,
      competingModels: ["qc45"],
      searchedAt: SEARCHED_AT,
    });
    expect(records[0]?.relevance).toBe("irrelevant");
  });

  it("skips results with invalid URLs", () => {
    const records = buildRecords({
      product: { id: "p1", title: "Sony WH-1000XM5" },
      results: [
        { title: "Broken", url: "not-a-url", content: "x", score: 10 },
      ],
      pages: new Map(),
      sources,
      competingModels: [],
      searchedAt: SEARCHED_AT,
    });
    expect(records).toEqual([]);
  });
});
