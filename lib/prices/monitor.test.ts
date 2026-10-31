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
    sendEmail: async () => ({ sent: false, error: "email off in tests" }),
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

test("a cycle creates opportunities and records the run", async () => {
  process.env.WISORA_DATA_DIR = await mkdtemp(
    path.join(tmpdir(), "wisora-monitor-"),
  );
  const store = new FileMemoryStore();
  const now = new Date("2026-02-10T12:00:00.000Z").getTime();
  await store.saveWatch(
    "user-1",
    watchInput(40000, "https://www.amazon.in/dp/B0OPP"),
  );
  const result = await runMonitoringCycle({
    store,
    fetchPage: async () => "Deal price ₹39,000 today only. ₹39,000!",
    notifier: silentNotifier(),
    config: { intervalMinutes: 240, maxChecksPerCycle: 10 },
    nowMs: now,
  });
  expect(result).toMatchObject({
    checked: 1,
    ok: 1,
    alerts: 1,
    opportunities: 1,
  });
  const opportunities = await store.listOpportunities("user-1");
  expect(opportunities).toHaveLength(1);
  expect(opportunities[0]).toMatchObject({
    kind: "target-reached",
    status: "active",
    currentPriceInr: 39000,
  });
  const runs = await store.listMonitorRuns();
  expect(runs).toHaveLength(1);
  expect(runs[0]).toMatchObject({
    checked: 1,
    ok: 1,
    alerts: 1,
    opportunities: 1,
  });
});

test("a cycle fires due reminders", async () => {
  process.env.WISORA_DATA_DIR = await mkdtemp(
    path.join(tmpdir(), "wisora-monitor-"),
  );
  const store = new FileMemoryStore();
  const now = new Date("2026-02-10T12:00:00.000Z").getTime();
  await store.saveReminder("user-1", {
    title: "Revisit the laptop",
    kind: "one-time",
    remindAt: new Date(now - 1000).toISOString(),
    timezone: "UTC",
    productId: "preminder",
    url: "https://www.amazon.in/dp/B0REM",
    merchant: "Amazon India",
  });
  const result = await runMonitoringCycle({
    store,
    fetchPage: async () => null,
    notifier: silentNotifier(),
    config: { intervalMinutes: 240, maxChecksPerCycle: 10 },
    nowMs: now,
  });
  expect(result).toMatchObject({
    checked: 0,
    remindersFired: 1,
    opportunities: 1,
  });
  const runs = await store.listMonitorRuns();
  expect(runs[0]).toMatchObject({ remindersFired: 1, opportunities: 1 });
});

test("cycles email fresh opportunities to the watch address", async () => {
  process.env.WISORA_DATA_DIR = await mkdtemp(
    path.join(tmpdir(), "wisora-monitor-"),
  );
  const store = new FileMemoryStore();
  const now = new Date("2026-02-10T12:00:00.000Z").getTime();
  const watch = await store.saveWatch(
    "user-1",
    watchInput(40000, "https://www.amazon.in/dp/B0EMAIL"),
  );
  await store.updateWatch("user-1", {
    id: watch.id,
    notifyEmail: "user@example.com",
  });
  const calls: string[] = [];
  const result = await runMonitoringCycle({
    store,
    fetchPage: async () => "Deal price ₹39,000 today only. ₹39,000!",
    notifier: {
      available: true,
      sendAlert: async () => ({ sent: true }),
      sendEmail: async (input) => {
        calls.push(`${input.to}|${input.subject}`);
        return { sent: true };
      },
    },
    config: { intervalMinutes: 240, maxChecksPerCycle: 10 },
    nowMs: now,
  });
  expect(result).toMatchObject({ opportunities: 1, emails: 1 });
  expect(calls).toHaveLength(1);
  expect(calls[0]).toContain("user@example.com");
  expect(calls[0]).toContain("Target reached");
  const opportunities = await store.listOpportunities("user-1");
  expect(opportunities[0]?.email).toMatchObject({
    attempted: true,
    sent: true,
  });
});

test("proactive-off users keep checks but get no opportunities", async () => {
  process.env.WISORA_DATA_DIR = await mkdtemp(
    path.join(tmpdir(), "wisora-monitor-"),
  );
  const store = new FileMemoryStore();
  const now = new Date("2026-02-10T12:00:00.000Z").getTime();
  await store.saveWatch(
    "user-1",
    watchInput(40000, "https://www.amazon.in/dp/B0QUIET"),
  );
  await store.saveReminder("user-1", {
    title: "Due reminder",
    kind: "one-time",
    remindAt: new Date(now - 1000).toISOString(),
    timezone: "UTC",
  });
  await store.saveNotificationSettings("user-1", { proactiveEnabled: false });
  const result = await runMonitoringCycle({
    store,
    fetchPage: async () => "Deal price ₹39,000 today only. ₹39,000!",
    notifier: silentNotifier(),
    config: { intervalMinutes: 240, maxChecksPerCycle: 10 },
    nowMs: now,
  });
  // The check and its target alert still run; proactive outputs pause.
  expect(result).toMatchObject({
    checked: 1,
    ok: 1,
    alerts: 1,
    opportunities: 0,
    remindersFired: 0,
    emails: 0,
  });
  expect(await store.listOpportunities("user-1")).toHaveLength(0);
  expect((await store.listReminders("user-1"))[0]?.status).toBe("active");
});

test("repeat cycles deduplicate opportunities", async () => {
  process.env.WISORA_DATA_DIR = await mkdtemp(
    path.join(tmpdir(), "wisora-monitor-"),
  );
  const store = new FileMemoryStore();
  const now = new Date("2026-02-10T12:00:00.000Z").getTime();
  const fetchPage = async () => "Deal price ₹39,000 today only. ₹39,000!";
  await store.saveWatch(
    "user-1",
    watchInput(40000, "https://www.amazon.in/dp/B0DUP"),
  );
  const config = { intervalMinutes: 240, maxChecksPerCycle: 10 };
  const first = await runMonitoringCycle({
    store,
    fetchPage,
    notifier: silentNotifier(),
    config,
    nowMs: now,
  });
  expect(first.opportunities).toBe(1);
  // Five hours later the watch is due again at the same price: the check
  // runs, but no second opportunity is created for the same state.
  const second = await runMonitoringCycle({
    store,
    fetchPage,
    notifier: silentNotifier(),
    config,
    nowMs: now + 5 * 3600000,
  });
  expect(second).toMatchObject({ checked: 1, ok: 1, opportunities: 0 });
  expect(await store.listOpportunities("user-1")).toHaveLength(1);
  expect(await store.listMonitorRuns()).toHaveLength(2);
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
