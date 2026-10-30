import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { FileMemoryStore } from "../memory/file-store";
import type { Notifier } from "./notify";
import type { NewWatch } from "./observation";
import {
  isMonitoringActive,
  monitorConfigFromEnv,
  runMonitoringCycle,
  startMonitoring,
  stopMonitoring,
} from "./monitor";

const SAVED: Record<string, string | undefined> = {};
for (const key of [
  "TAVILY_API_KEY",
  "WISORA_MONITORING",
  "WISORA_CHECK_INTERVAL_MINUTES",
  "WISORA_MAX_CHECKS_PER_CYCLE",
  "WISORA_DATA_DIR",
  "NEXT_RUNTIME",
]) {
  SAVED[key] = process.env[key];
}

afterEach(() => {
  stopMonitoring();
  vi.useRealTimers();
  for (const [key, value] of Object.entries(SAVED)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

function silentNotifier(): Notifier {
  return {
    available: false,
    sendAlert: async () => ({ sent: false, error: "email off in tests" }),
  };
}

function watchInput(targetPrice: number, url: string): NewWatch {
  return {
    productId: `p-${url.replace(/[^A-Za-z0-9]/g, "").slice(-12)}`,
    url,
    title: "Test Product",
    merchant: "Amazon India",
    targetPrice,
    currency: "INR",
    active: true,
    canWait: true,
  };
}

test("monitor config comes from minutes-based env vars", () => {
  delete process.env.WISORA_CHECK_INTERVAL_MINUTES;
  delete process.env.WISORA_MAX_CHECKS_PER_CYCLE;
  expect(monitorConfigFromEnv()).toEqual({
    intervalMinutes: 240,
    maxChecksPerCycle: 10,
  });
  process.env.WISORA_CHECK_INTERVAL_MINUTES = "30";
  process.env.WISORA_MAX_CHECKS_PER_CYCLE = "3";
  expect(monitorConfigFromEnv()).toEqual({
    intervalMinutes: 30,
    maxChecksPerCycle: 3,
  });
  process.env.WISORA_CHECK_INTERVAL_MINUTES = "2";
  expect(monitorConfigFromEnv().intervalMinutes).toBe(5);
  process.env.WISORA_CHECK_INTERVAL_MINUTES = "not-a-number";
  expect(monitorConfigFromEnv().intervalMinutes).toBe(240);
});

test("a cycle checks due watches and skips the rest", async () => {
  process.env.WISORA_DATA_DIR = await mkdtemp(
    path.join(tmpdir(), "wisora-monitor-"),
  );
  const store = new FileMemoryStore();
  const now = new Date("2026-02-10T12:00:00.000Z").getTime();
  const hoursAgo = (hours: number) =>
    new Date(now - hours * 3600000).toISOString();

  await store.saveWatch(
    "user-1",
    watchInput(40000, "https://www.amazon.in/dp/B0NEVER"),
  );
  const paused = await store.saveWatch(
    "user-1",
    watchInput(40000, "https://www.amazon.in/dp/B0PAUSED"),
  );
  await store.updateWatch("user-1", { id: paused.id, active: false });
  const fresh = await store.saveWatch(
    "user-2",
    watchInput(40000, "https://www.amazon.in/dp/B0FRESH"),
  );
  await store.updateWatchCheck("user-2", fresh.id, {
    at: hoursAgo(1),
    priceInr: 45000,
    status: "ok",
  });
  const stale = await store.saveWatch(
    "user-2",
    watchInput(40000, "https://www.amazon.in/dp/B0STALE"),
  );
  await store.updateWatchCheck("user-2", stale.id, {
    at: hoursAgo(5),
    priceInr: 45000,
    status: "ok",
  });

  const result = await runMonitoringCycle({
    store,
    fetchPage: async () => "Deal price ₹39,000 today only. ₹39,000!",
    notifier: silentNotifier(),
    config: { intervalMinutes: 240, maxChecksPerCycle: 10 },
    nowMs: now,
  });
  expect(result).toMatchObject({
    ownersScanned: 2,
    due: 2,
    checked: 2,
    ok: 2,
    failed: 0,
    alerts: 2,
  });
  // Paused and fresh watches were untouched.
  expect((await store.getWatch("user-1", paused.id))?.lastCheck).toBeUndefined();
  expect((await store.getWatch("user-2", fresh.id))?.lastCheck?.priceInr).toBe(
    45000,
  );
});

test("cycles respect the per-cycle cap and isolate failures", async () => {
  process.env.WISORA_DATA_DIR = await mkdtemp(
    path.join(tmpdir(), "wisora-monitor-"),
  );
  const store = new FileMemoryStore();
  const now = Date.now();
  const first = await store.saveWatch(
    "user-1",
    watchInput(40000, "https://www.amazon.in/dp/B0FIRST"),
  );
  await store.updateWatchCheck("user-1", first.id, {
    at: new Date(now - 10 * 3600000).toISOString(),
    priceInr: 45000,
    status: "ok",
  });
  const second = await store.saveWatch(
    "user-1",
    watchInput(40000, "https://www.amazon.in/dp/B0SECOND"),
  );
  await store.updateWatchCheck("user-1", second.id, {
    at: new Date(now - 5 * 3600000).toISOString(),
    priceInr: 45000,
    status: "ok",
  });
  const result = await runMonitoringCycle({
    store,
    fetchPage: async (url) => {
      if (url.includes("B0FIRST")) {
        throw new Error("boom");
      }
      return "Price ₹39,000. ₹39,000!";
    },
    notifier: silentNotifier(),
    config: { intervalMinutes: 240, maxChecksPerCycle: 1 },
    nowMs: Date.now(),
  });
  // Oldest first (never-checked sorts before everything), capped at one.
  // B0FIRST fails honestly; the rest waits for the next cycle.
  expect(result.checked).toBe(1);
  expect(result.failed).toBe(1);
  expect(result.due).toBe(2);
  expect(result.errors).toHaveLength(0);
  const watches = await store.listWatches("user-1");
  expect(
    watches.find((w) => w.url.includes("B0FIRST"))?.lastCheck?.status,
  ).toBe("fetch-failed");
  // The capped-out watch waits untouched for the next cycle.
  expect(
    watches.find((w) => w.url.includes("B0SECOND"))?.lastCheck,
  ).toMatchObject({ priceInr: 45000, status: "ok" });
});

test("start and stop are explicit and guarded", async () => {
  process.env.WISORA_DATA_DIR = await mkdtemp(
    path.join(tmpdir(), "wisora-monitor-"),
  );
  process.env.WISORA_MONITORING = "off";
  process.env.TAVILY_API_KEY = "test-key";
  startMonitoring();
  expect(isMonitoringActive()).toBe(false);
  delete process.env.WISORA_MONITORING;
  delete process.env.TAVILY_API_KEY;
  startMonitoring();
  expect(isMonitoringActive()).toBe(false);
  process.env.TAVILY_API_KEY = "test-key";
  startMonitoring();
  expect(isMonitoringActive()).toBe(true);
  startMonitoring();
  expect(isMonitoringActive()).toBe(true);
  await new Promise((resolve) => setTimeout(resolve, 50));
  stopMonitoring();
  expect(isMonitoringActive()).toBe(false);
});

test("instrumentation register starts monitoring on nodejs runtime", async () => {
  process.env.WISORA_DATA_DIR = await mkdtemp(
    path.join(tmpdir(), "wisora-monitor-"),
  );
  process.env.TAVILY_API_KEY = "test-key";
  process.env.NEXT_RUNTIME = "edge";
  const { register } = await import("../../instrumentation");
  await register();
  expect(isMonitoringActive()).toBe(false);
  process.env.NEXT_RUNTIME = "nodejs";
  await register();
  expect(isMonitoringActive()).toBe(true);
  await new Promise((resolve) => setTimeout(resolve, 50));
});
