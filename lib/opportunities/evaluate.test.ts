import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { FileMemoryStore } from "../memory/file-store";
import type { Watch } from "../prices/observation";
import { evaluateWatchForOpportunities } from "./evaluate";

const NOW = new Date("2026-02-10T12:00:00.000Z").getTime();
const DAY = 24 * 60 * 60 * 1000;
const at = (daysAgo: number) =>
  new Date(NOW - daysAgo * DAY).toISOString();

async function freshStore(): Promise<FileMemoryStore> {
  return new FileMemoryStore(await mkdtemp(path.join(tmpdir(), "wisora-eval-")));
}

async function saveWatch(
  store: FileMemoryStore,
  targetPrice: number,
): Promise<Watch> {
  return store.saveWatch("user-1", {
    productId: "p1",
    url: "https://www.amazon.in/dp/B0TEST1",
    title: "Test Laptop",
    merchant: "Amazon India",
    targetPrice,
    currency: "INR",
    active: true,
    canWait: true,
  });
}

async function observe(
  store: FileMemoryStore,
  priceInr: number,
  daysAgo: number,
): Promise<void> {
  await store.recordObservation({
    productId: "p1",
    url: "https://www.amazon.in/dp/B0TEST1",
    title: "Test Laptop",
    merchant: "Amazon India",
    sourceId: "amazon-in",
    priceInr,
    currency: "INR",
    evidence: "repeated",
    candidates: 2,
    observedAt: at(daysAgo),
    source: "watch-check",
  });
}

async function seedContext(store: FileMemoryStore): Promise<void> {
  await store.saveDecision("user-1", {
    query: "laptop under 90000",
    category: "electronics",
    topPick: {
      productId: "p1",
      title: "Test Laptop",
      merchant: "Amazon India",
      priceInr: 89999,
    },
    verdict: "BUY",
  });
  await store.saveSavedProduct("user-1", {
    productId: "p1",
    title: "Test Laptop",
    url: "https://www.amazon.in/dp/B0TEST1",
    merchant: "Amazon India",
    imageUrl: "https://img.example/x.jpg",
  });
}

test("creates a target opportunity enriched with category and image", async () => {
  const store = await freshStore();
  const watch = await saveWatch(store, 85000);
  await observe(store, 89999, 2);
  await observe(store, 84999, 0);
  await seedContext(store);
  const checked =
    (await store.updateWatchCheck("user-1", watch.id, {
      at: at(0),
      priceInr: 84999,
      status: "ok",
    })) ?? watch;

  const result = await evaluateWatchForOpportunities({
    store,
    userSub: "user-1",
    watch: checked,
    previousStatus: "ok",
    nowMs: NOW,
  });
  expect(result.created).toHaveLength(1);
  expect(result.created[0]).toMatchObject({
    kind: "target-reached",
    category: "electronics",
    imageUrl: "https://img.example/x.jpg",
    currentPriceInr: 84999,
    previousPriceInr: 89999,
    relevance: { score: 50, reasons: [] },
  });
  expect(result.skipped).toEqual([]);
});

test("re-running unchanged state creates nothing (idempotent)", async () => {
  const store = await freshStore();
  const watch = await saveWatch(store, 85000);
  await observe(store, 84999, 0);
  const checked =
    (await store.updateWatchCheck("user-1", watch.id, {
      at: at(0),
      priceInr: 84999,
      status: "ok",
    })) ?? watch;
  const input = {
    store,
    userSub: "user-1",
    watch: checked,
    previousStatus: "ok" as const,
    nowMs: NOW,
  };
  const first = await evaluateWatchForOpportunities(input);
  expect(first.created).toHaveLength(1);
  const second = await evaluateWatchForOpportunities(input);
  expect(second.created).toHaveLength(0);
  expect(second.skipped).toEqual([
    {
      kind: "target-reached",
      dedupeKey: "target-reached:p1:84999",
      reason: "duplicate",
    },
  ]);
});

test("dismissed opportunities still suppress re-creation", async () => {
  const store = await freshStore();
  const watch = await saveWatch(store, 85000);
  await observe(store, 84999, 0);
  const checked =
    (await store.updateWatchCheck("user-1", watch.id, {
      at: at(0),
      priceInr: 84999,
      status: "ok",
    })) ?? watch;
  const first = await evaluateWatchForOpportunities({
    store,
    userSub: "user-1",
    watch: checked,
    previousStatus: "ok",
    nowMs: NOW,
  });
  await store.updateOpportunityStatus(
    "user-1",
    first.created[0]?.id ?? "missing",
    "dismissed",
  );
  const second = await evaluateWatchForOpportunities({
    store,
    userSub: "user-1",
    watch: checked,
    previousStatus: "ok",
    nowMs: NOW,
  });
  expect(second.created).toHaveLength(0);
  expect(second.skipped[0]?.reason).toBe("duplicate");
});

test("significant rises alert while small moves stay silent", async () => {
  const store = await freshStore();
  const watch = await saveWatch(store, 20000);
  await observe(store, 25000, 2);
  await observe(store, 28000, 0);
  const checked =
    (await store.updateWatchCheck("user-1", watch.id, {
      at: at(0),
      priceInr: 28000,
      status: "ok",
    })) ?? watch;
  const risen = await evaluateWatchForOpportunities({
    store,
    userSub: "user-1",
    watch: checked,
    previousStatus: "ok",
    nowMs: NOW,
  });
  expect(risen.created[0]?.kind).toBe("price-increase");

  await store.recordObservation({
    productId: "p1",
    url: "https://www.amazon.in/dp/B0TEST1",
    title: "Test Laptop",
    merchant: "Amazon India",
    sourceId: "amazon-in",
    priceInr: 28100,
    currency: "INR",
    evidence: "single",
    candidates: 1,
    observedAt: at(0),
    source: "watch-check",
  });
  const calmChecked =
    (await store.updateWatchCheck("user-1", watch.id, {
      at: at(0),
      priceInr: 28100,
      status: "ok",
    })) ?? watch;
  const quiet = await evaluateWatchForOpportunities({
    store,
    userSub: "user-1",
    watch: calmChecked,
    previousStatus: "ok",
    nowMs: NOW,
  });
  // Latest 28100 vs previous 28000: below every floor.
  expect(quiet.created).toHaveLength(0);
});

test("availability flips alert once per state", async () => {
  const store = await freshStore();
  const watch = await saveWatch(store, 85000);
  const down =
    (await store.updateWatchCheck("user-1", watch.id, {
      at: at(0),
      status: "unavailable",
    })) ?? watch;
  const first = await evaluateWatchForOpportunities({
    store,
    userSub: "user-1",
    watch: down,
    previousStatus: "ok",
    nowMs: NOW,
  });
  expect(first.created[0]?.kind).toBe("unavailable");

  const repeat = await evaluateWatchForOpportunities({
    store,
    userSub: "user-1",
    watch: down,
    previousStatus: "unavailable",
    nowMs: NOW,
  });
  expect(repeat.created).toHaveLength(0);

  const up =
    (await store.updateWatchCheck("user-1", watch.id, {
      at: at(0),
      status: "ok",
    })) ?? watch;
  const restored = await evaluateWatchForOpportunities({
    store,
    userSub: "user-1",
    watch: up,
    previousStatus: "unavailable",
    nowMs: NOW,
  });
  expect(restored.created[0]?.kind).toBe("restored");
});

test("watches with no evidence produce nothing", async () => {
  const store = await freshStore();
  const watch = await saveWatch(store, 85000);
  const result = await evaluateWatchForOpportunities({
    store,
    userSub: "user-1",
    watch,
    nowMs: NOW,
  });
  expect(result.created).toHaveLength(0);
  expect(result.skipped).toHaveLength(0);
});

test("new opportunities carry prior-decision context", async () => {
  const store = await freshStore();
  const watch = await saveWatch(store, 85000);
  await observe(store, 89999, 2);
  await observe(store, 84999, 0);
  await store.saveDecision("user-1", {
    query: "laptop under 90000",
    category: "electronics",
    topPick: {
      productId: "p1",
      title: "Test Laptop",
      merchant: "Amazon India",
      priceInr: 89999,
    },
    verdict: "WAIT",
  });
  const checked =
    (await store.updateWatchCheck("user-1", watch.id, {
      at: at(0),
      priceInr: 84999,
      status: "ok",
    })) ?? watch;
  const result = await evaluateWatchForOpportunities({
    store,
    userSub: "user-1",
    watch: checked,
    previousStatus: "ok",
    nowMs: NOW,
  });
  expect(result.created[0]?.decisionContext).toContain("was WAIT");
});

test("flapping prices yield exactly one card per distinct state", async () => {
  const store = await freshStore();
  const watch = await saveWatch(store, 80000);
  const runAt = async (price: number, daysAgo: number) => {
    await store.recordObservation({
      productId: "p1",
      url: "https://www.amazon.in/dp/B0TEST1",
      title: "Test Laptop",
      merchant: "Amazon India",
      sourceId: "amazon-in",
      priceInr: price,
      currency: "INR",
      evidence: "repeated",
      candidates: 2,
      observedAt: at(daysAgo),
      source: "watch-check",
    });
    const checked =
      (await store.updateWatchCheck("user-1", watch.id, {
        at: at(daysAgo),
        priceInr: price,
        status: "ok",
      })) ?? watch;
    return evaluateWatchForOpportunities({
      store,
      userSub: "user-1",
      watch: checked,
      previousStatus: "ok",
      nowMs: NOW,
    });
  };
  // 83000 baseline, 90000 (small rise: silent), 85000 (drop, above the
  // old low's range), 95000 (big rise), 85000 again (duplicate), then a
  // fresh window low at 82000 (range re-entry, not a move card).
  await runAt(83000, 6);
  const quiet = await runAt(90000, 5);
  expect(quiet.created).toHaveLength(0);
  const drop = await runAt(85000, 4);
  expect(drop.created.map((entry) => entry.kind)).toEqual(["price-drop"]);
  const recovery = await runAt(95000, 3);
  expect(recovery.created.map((entry) => entry.kind)).toEqual([
    "price-increase",
  ]);
  const reflap = await runAt(85000, 2);
  expect(reflap.created).toHaveLength(0);
  expect(reflap.skipped).toEqual([
    {
      kind: "price-drop",
      dedupeKey: "price-drop:p1:85000",
      reason: "duplicate",
    },
  ]);
  const freshLow = await runAt(82000, 0);
  expect(freshLow.created.map((entry) => entry.kind)).toEqual([
    "back-in-range",
  ]);
  expect(await store.listOpportunities("user-1")).toHaveLength(3);
});

test("category falls back to saved comparisons", async () => {
  const store = await freshStore();
  const watch = await saveWatch(store, 85000);
  await observe(store, 84999, 0);
  await store.saveSavedComparison("user-1", {
    category: "electronics",
    products: [
      { productId: "p1", title: "Test Laptop", merchant: "Amazon India" },
      { productId: "p2", title: "Other Laptop", merchant: "Flipkart" },
    ],
  });
  const checked =
    (await store.updateWatchCheck("user-1", watch.id, {
      at: at(0),
      priceInr: 84999,
      status: "ok",
    })) ?? watch;
  const result = await evaluateWatchForOpportunities({
    store,
    userSub: "user-1",
    watch: checked,
    nowMs: NOW,
  });
  expect(result.created[0]?.category).toBe("electronics");
});
