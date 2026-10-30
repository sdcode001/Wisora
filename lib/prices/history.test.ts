import { expect, test } from "vitest";
import { summarizeHistory, targetRealismNote } from "./history";
import type { PriceObservation } from "./observation";

function obs(priceInr: number, observedAt: string): PriceObservation {
  return {
    productId: "p1",
    url: "https://www.amazon.in/dp/B0TEST1",
    title: "Test Laptop",
    merchant: "Amazon India",
    sourceId: "amazon-in",
    priceInr,
    currency: "INR",
    evidence: "repeated",
    candidates: 2,
    observedAt,
    source: "search",
  };
}

const NOW = new Date("2026-02-10T00:00:00.000Z").getTime();

test("empty history yields explicit nulls", () => {
  const stats = summarizeHistory([], 30, NOW);
  expect(stats).toMatchObject({
    count: 0,
    latest: null,
    min: null,
    max: null,
    averageInr: null,
    changeVsPrevious: null,
  });
  expect(targetRealismNote(100, stats)).toBeNull();
});

test("windowed stats label their coverage", () => {
  const stats = summarizeHistory(
    [
      obs(45000, "2026-02-09T00:00:00.000Z"),
      obs(50000, "2026-02-01T00:00:00.000Z"),
      obs(40000, "2025-12-01T00:00:00.000Z"),
    ],
    30,
    NOW,
  );
  expect(stats.count).toBe(2);
  expect(stats.windowDays).toBe(30);
  expect(stats.latest?.priceInr).toBe(45000);
  expect(stats.stale).toBe(false);
  expect(stats.min?.priceInr).toBe(45000);
  expect(stats.max?.priceInr).toBe(50000);
  expect(stats.averageInr).toBe(47500);
  expect(stats.changeVsPrevious).toEqual({
    absoluteInr: -5000,
    percent: -10,
  });
});

test("single observations have no average or change", () => {
  const stats = summarizeHistory(
    [obs(45000, "2026-02-09T00:00:00.000Z")],
    30,
    NOW,
  );
  expect(stats.count).toBe(1);
  expect(stats.averageInr).toBeNull();
  expect(stats.changeVsPrevious).toBeNull();
});

test("old latest observations read as stale", () => {
  const stats = summarizeHistory(
    [obs(45000, "2026-01-20T00:00:00.000Z")],
    30,
    NOW,
  );
  expect(stats.stale).toBe(true);
});

test("unrealistic targets get an honest note", () => {
  const stats = summarizeHistory(
    [
      obs(45000, "2026-02-09T00:00:00.000Z"),
      obs(50000, "2026-02-01T00:00:00.000Z"),
    ],
    30,
    NOW,
  );
  expect(targetRealismNote(46000, stats)).toBeNull();
  expect(targetRealismNote(30000, stats)).toContain("never observed below");
});
