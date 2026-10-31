import { afterEach, expect, test, vi } from "vitest";
import type {
  PriceObservation,
  Watch,
} from "../prices/observation";
import {
  DEFAULT_THRESHOLDS,
  detectAvailabilityTransition,
  detectPriceOpportunity,
  detectionThresholdsFromEnv,
  snapshotFromWatch,
  type ProductSnapshot,
} from "./detect";

const NOW = new Date("2026-02-10T12:00:00.000Z").getTime();
const DAY = 24 * 60 * 60 * 1000;

function obs(priceInr: number, daysAgo: number): PriceObservation {
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
    observedAt: new Date(NOW - daysAgo * DAY).toISOString(),
    source: "watch-check",
  };
}

function watchWith(targetPrice: number): Watch {
  return {
    id: "w1",
    createdAt: new Date(NOW - 30 * DAY).toISOString(),
    productId: "p1",
    url: "https://www.amazon.in/dp/B0TEST1",
    title: "Test Laptop",
    merchant: "Amazon India",
    targetPrice,
    currency: "INR",
    active: true,
    canWait: true,
  };
}

const SNAPSHOT: ProductSnapshot = {
  productId: "p1",
  title: "Test Laptop",
  merchant: "Amazon India",
  url: "https://www.amazon.in/dp/B0TEST1",
};

function detect(
  observations: PriceObservation[],
  targetPrice = 85000,
  snapshot: ProductSnapshot = SNAPSHOT,
) {
  const watch = watchWith(targetPrice);
  return detectPriceOpportunity({
    snapshot,
    watch,
    observations,
    nowMs: NOW,
  });
}

test("target reached fires with previous-price context", () => {
  const found = detect([obs(84999, 0), obs(89999, 1)]);
  expect(found?.kind).toBe("target-reached");
  expect(found?.currentPriceInr).toBe(84999);
  expect(found?.previousPriceInr).toBe(89999);
  expect(found?.targetPriceInr).toBe(85000);
  expect(found?.dedupeKey).toBe("target-reached:p1:84999");
  expect(found?.reason).toContain("within your");
  expect(found?.evidence.source).toBe("watch-check");
});

test("target reached fires without any previous price", () => {
  const found = detect([obs(84000, 0)]);
  expect(found?.kind).toBe("target-reached");
  expect(found?.previousPriceInr).toBeNull();
});

test("target beats a simultaneous significant drop", () => {
  // 89999 -> 80000 is both a target hit (<= 85000) and a big drop.
  const found = detect([obs(80000, 0), obs(89999, 1)]);
  expect(found?.kind).toBe("target-reached");
});

test("significant drop fires above both floors", () => {
  // 95000 -> 88000: 7.4% and ₹7000. The older 83000 low keeps the latest
  // above the window range so the move card (not back-in-range) fires.
  const found = detect(
    [obs(88000, 0), obs(95000, 1), obs(83000, 10)],
    80000,
  );
  expect(found?.kind).toBe("price-drop");
  expect(found?.dedupeKey).toBe("price-drop:p1:88000");
  expect(found?.reason).toContain("Dropped");
});

test("small drops stay silent on either floor", () => {
  // Below the percent floor: 90000 -> 87000 is 3.3%. The older 85000 low
  // keeps the latest out of range so silence is genuinely about the move.
  expect(
    detect([obs(87000, 0), obs(90000, 1), obs(85000, 10)], 80000),
  ).toBeNull();
  // Below the rupee floor: 4000 -> 3700 is 7.5% but only ₹300, and the
  // older 3500 low keeps it out of range.
  const cheap = detect([obs(3700, 0), obs(4000, 1), obs(3500, 10)], 3000);
  expect(cheap).toBeNull();
});

test("significant rise fires above both floors", () => {
  // 25000 -> 28000: 12% and ₹3000.
  const found = detect([obs(28000, 0), obs(25000, 1)], 20000);
  expect(found?.kind).toBe("price-increase");
  expect(found?.reason).toContain("Rose");
});

test("small rises stay silent", () => {
  // 25000 -> 26000: 4% and ₹1000 — below the 10% floor.
  expect(detect([obs(26000, 0), obs(25000, 1)], 20000)).toBeNull();
});

test("back in range fires on re-entry from above", () => {
  // Window low 84500; latest 84999 re-enters; previous 90000 was above.
  const found = detect(
    [obs(84999, 0), obs(90000, 1), obs(84500, 10), obs(92000, 20)],
    80000,
  );
  expect(found?.kind).toBe("back-in-range");
  expect(found?.reason).toContain("30-day low");
});

test("back in range beats a simultaneous significant drop", () => {
  // 95000 -> 84600 is a 11% drop AND a re-entry to the window low.
  const found = detect(
    [obs(84600, 0), obs(95000, 1), obs(84500, 10)],
    80000,
  );
  expect(found?.kind).toBe("back-in-range");
});

test("no re-entry card when the previous price was already in range", () => {
  // Both 84900 and 84800 sit within 2% of the 84500 low: the latest is
  // not a re-entry, and the 100-rupee move is below every floor.
  const found = detect(
    [obs(84800, 0), obs(84900, 1), obs(84500, 10)],
    80000,
  );
  expect(found).toBeNull();
});

test("thin in-window history yields no range card", () => {
  // Only the latest sits inside 30 days: no range to re-enter, and no
  // previous distinct price for a move card.
  expect(detect([obs(84000, 0), obs(84000, 40)], 80000)).toBeNull();
});

test("stale, undated, and empty histories stay silent", () => {
  expect(detect([obs(80000, 8)], 85000)).toBeNull();
  const undated = obs(80000, 0);
  undated.observedAt = "not-a-date";
  expect(detect([undated, obs(90000, 1)], 85000)).toBeNull();
  expect(detect([], 85000)).toBeNull();
});

test("identical consecutive prices compare against the older distinct one", () => {
  // Two 84000 sightings then 90000: the move is still detected against
  // the older distinct price. The 82000 low keeps it a move, not a range
  // re-entry.
  const found = detect(
    [obs(84000, 0), obs(84000, 1), obs(90000, 2), obs(82000, 10)],
    80000,
  );
  expect(found?.kind).toBe("price-drop");
  expect(found?.previousPriceInr).toBe(90000);
});

test("snapshotFromWatch carries the listing identity", () => {
  const watch = watchWith(85000);
  expect(snapshotFromWatch(watch, "https://img/x.jpg")).toEqual({
    productId: "p1",
    title: "Test Laptop",
    merchant: "Amazon India",
    url: "https://www.amazon.in/dp/B0TEST1",
    imageUrl: "https://img/x.jpg",
  });
});

test("unavailable fires on first sighting and on transitions into it", () => {
  const at = new Date(NOW).toISOString();
  const first = detectAvailabilityTransition({
    snapshot: SNAPSHOT,
    currentStatus: "unavailable",
    observedAt: at,
    nowMs: NOW,
  });
  expect(first?.kind).toBe("unavailable");
  expect(first?.currentPriceInr).toBeNull();
  expect(first?.dedupeKey).toBe("unavailable:p1");

  const transition = detectAvailabilityTransition({
    snapshot: SNAPSHOT,
    previousStatus: "ok",
    currentStatus: "unavailable",
    observedAt: at,
    nowMs: NOW,
  });
  expect(transition?.kind).toBe("unavailable");
});

test("restored fires only on unavailable -> ok", () => {
  const at = new Date(NOW).toISOString();
  const restored = detectAvailabilityTransition({
    snapshot: SNAPSHOT,
    previousStatus: "unavailable",
    currentStatus: "ok",
    observedAt: at,
    nowMs: NOW,
  });
  expect(restored?.kind).toBe("restored");
  expect(restored?.reason).toContain("Available again");
});

test("transient statuses never produce availability events", () => {
  const at = new Date(NOW).toISOString();
  const cases = [
    { previousStatus: "ok", currentStatus: "ok" },
    { previousStatus: "unavailable", currentStatus: "unavailable" },
    { previousStatus: "ok", currentStatus: "fetch-failed" },
    { previousStatus: "fetch-failed", currentStatus: "no-price" },
    { previousStatus: undefined, currentStatus: "fetch-failed" },
  ] as const;
  for (const statuses of cases) {
    expect(
      detectAvailabilityTransition({
        snapshot: SNAPSHOT,
        observedAt: at,
        nowMs: NOW,
        ...statuses,
      }),
    ).toBeNull();
  }
});

test("stale availability evidence stays silent", () => {
  expect(
    detectAvailabilityTransition({
      snapshot: SNAPSHOT,
      previousStatus: "ok",
      currentStatus: "unavailable",
      observedAt: new Date(NOW - 8 * DAY).toISOString(),
      nowMs: NOW,
    }),
  ).toBeNull();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

test("thresholds come from env with clamping and defaults", () => {
  vi.stubEnv("WISORA_OPP_MIN_DROP_PERCENT", "3");
  vi.stubEnv("WISORA_OPP_MIN_DROP_INR", "100");
  vi.stubEnv("WISORA_OPP_MIN_RISE_PERCENT", "200");
  vi.stubEnv("WISORA_OPP_RANGE_DAYS", "0");
  expect(detectionThresholdsFromEnv()).toMatchObject({
    minDropPercent: 3,
    minDropInr: 100,
    minRisePercent: 100,
    minRiseInr: 1000,
    rangeDays: 1,
    rangeTolerancePercent: 2,
    staleDays: 7,
  });
  vi.stubEnv("WISORA_OPP_MIN_DROP_PERCENT", "nonsense");
  expect(detectionThresholdsFromEnv().minDropPercent).toBe(
    DEFAULT_THRESHOLDS.minDropPercent,
  );
});
