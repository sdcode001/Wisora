import { describe, expect, it } from "vitest";
import { extractIdentity, gradeRelevance } from "./identity";

describe("extractIdentity", () => {
  it("pulls model codes and drops spec-like tokens", () => {
    const identity = extractIdentity(
      "Sony WH-1000XM5 Wireless Headphones 30h Battery",
    );
    expect(identity.modelTokens).toEqual(["1000xm5"]);
    expect(identity.nameTokens).toContain("headphones");
    expect(identity.nameTokens).toContain("wireless");
  });

  it("returns no model tokens for plain names", () => {
    const identity = extractIdentity("Comfortable Running Shoes");
    expect(identity.modelTokens).toEqual([]);
    expect(identity.nameTokens).toContain("running");
  });

  it("drops years and connectivity generations", () => {
    const identity = extractIdentity("Phone 5G 2025 Model 12R Dual SIM");
    expect(identity.modelTokens).toEqual(["12r"]);
  });
});

describe("gradeRelevance", () => {
  const identity = extractIdentity("Sony WH-1000XM5 Wireless Headphones");

  it("grades model-in-title as exact", () => {
    expect(
      gradeRelevance(identity, [], {
        title: "Sony WH-1000XM5 review: the best yet",
        url: "https://example.com/review",
        text: "We tested the headphones for a month.",
      }),
    ).toBe("exact");
  });

  it("grades model-in-URL-slug as exact", () => {
    expect(
      gradeRelevance(identity, [], {
        title: "Flagship headphone review",
        url: "https://example.com/sony-wh-1000xm5-review",
        text: "Sound quality impresses.",
      }),
    ).toBe("exact");
  });

  it("grades model-in-body as likely", () => {
    expect(
      gradeRelevance(identity, [], {
        title: "Best wireless headphones of the year",
        url: "https://example.com/best-headphones",
        text: "The WH-1000XM5 leads with comfort and ANC.",
      }),
    ).toBe("likely");
  });

  it("grades comparison pieces as likely, not exact", () => {
    const rival = extractIdentity("Bose QC45 Headphones").modelTokens;
    expect(
      gradeRelevance(identity, rival, {
        title: "WH-1000XM5 vs QC45 compared",
        url: "https://example.com/vs",
        text: "Two flagships compared.",
      }),
    ).toBe("likely");
  });

  it("rejects rival-model pages as irrelevant", () => {
    const rival = extractIdentity("Bose QC45 Headphones").modelTokens;
    expect(
      gradeRelevance(identity, rival, {
        title: "Bose QC45 review",
        url: "https://example.com/qc45",
        text: "A solid alternative.",
      }),
    ).toBe("irrelevant");
  });

  it("rejects long texts with no overlap as irrelevant", () => {
    expect(
      gradeRelevance(identity, [], {
        title: "Stand mixer buying guide",
        url: "https://example.com/mixers",
        text: `Kitchen appliances compared. ${"Flour dough baking knead ".repeat(40)}`,
      }),
    ).toBe("irrelevant");
  });

  it("keeps short weak matches uncertain instead of rejecting", () => {
    expect(
      gradeRelevance(identity, [], {
        title: "Headphone deals this week",
        url: "https://example.com/deals",
        text: "Short snippet.",
      }),
    ).toBe("uncertain");
  });

  it("falls back to name overlap without model codes", () => {
    const shoes = extractIdentity("Comfortable Running Shoes");
    expect(
      gradeRelevance(shoes, [], {
        title: "Comfortable running shoes roundup",
        url: "https://example.com/shoes",
        text: "We ran 200km in comfortable running shoes.",
      }),
    ).toBe("likely");
    expect(
      gradeRelevance(shoes, [], {
        title: "Winter jacket guide",
        url: "https://example.com/jackets",
        text: "Stay warm.",
      }),
    ).toBe("uncertain");
  });
});
