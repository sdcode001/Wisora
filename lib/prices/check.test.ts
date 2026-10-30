import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { FileMemoryStore } from "../memory/file-store";
import type { NewWatch } from "./observation";
import {
  evaluateObservationsForUser,
  recordProductPrices,
  runWatchCheck,
  type PageFetcher,
} from "./check";
import type { Notifier } from "./notify";

async function freshStore(): Promise<FileMemoryStore> {
  return new FileMemoryStore(await mkdtemp(path.join(tmpdir(), "wisora-check-")));
}

function watchInput(targetPrice: number): NewWatch {
  return {
    productId: "abc123",
    url: "https://www.amazon.in/dp/B0TEST1",
    title: "Test Laptop",
    merchant: "Amazon India",
    targetPrice,
    currency: "INR",
    active: true,
    canWait: true,
    notifyEmail: "user@example.com",
  };
}

function notifier(): Notifier & { calls: string[] } {
  const calls: string[] = [];
  return {
    available: true,
    calls,
    async sendAlert(input) {
      calls.push(input.to);
      return { sent: true };
    },
  };
}

const PAGE_AT_39000 = "Test Laptop deal price ₹39,000 only, was higher. ₹39,000 today.";

test("a check records the observation and updates the watch", async () => {
  const store = await freshStore();
  const watch = await store.saveWatch("user-1", watchInput(35000));
  const fetchPage: PageFetcher = async () => PAGE_AT_39000;
  const outcome = await runWatchCheck({
    store,
    userSub: "user-1",
    watch,
    fetchPage,
    notifier: notifier(),
    now: "2026-02-01T00:00:00.000Z",
  });
  expect(outcome.status).toBe("ok");
  expect(outcome.observation?.priceInr).toBe(39000);
  expect(outcome.recorded).toBe(true);
  expect(outcome.alert).toBeNull();
  expect(outcome.alertSkipped).toBe("target-not-met");
  expect(outcome.watch.lastCheck).toMatchObject({
    priceInr: 39000,
    status: "ok",
  });
  expect(await store.listObservations("abc123")).toHaveLength(1);
});

test("a met target alerts once and emails the address on file", async () => {
  const store = await freshStore();
  const watch = await store.saveWatch("user-1", watchInput(40000));
  const fetchPage: PageFetcher = async () => PAGE_AT_39000;
  const mailer = notifier();
  const first = await runWatchCheck({
    store,
    userSub: "user-1",
    watch,
    fetchPage,
    notifier: mailer,
    now: "2026-02-01T00:00:00.000Z",
  });
  expect(first.alert?.observedPrice).toBe(39000);
  expect(first.alert?.email).toMatchObject({ attempted: true, sent: true });
  expect(mailer.calls).toHaveLength(1);
  // Same price re-checked: observation deduped, alert not duplicated.
  const second = await runWatchCheck({
    store,
    userSub: "user-1",
    watch: first.watch,
    fetchPage,
    notifier: mailer,
    now: "2026-02-01T01:00:00.000Z",
  });
  expect(second.alert).toBeNull();
  expect(second.alertSkipped).toBe("duplicate");
  expect(mailer.calls).toHaveLength(1);
  expect(await store.listAlerts("user-1")).toHaveLength(1);
});

test("paused watches check without alerting", async () => {
  const store = await freshStore();
  const watch = await store.saveWatch("user-1", {
    ...watchInput(40000),
    active: false,
  });
  const outcome = await runWatchCheck({
    store,
    userSub: "user-1",
    watch,
    fetchPage: async () => PAGE_AT_39000,
    notifier: notifier(),
  });
  expect(outcome.status).toBe("ok");
  expect(outcome.alertSkipped).toBe("watch-paused");
  expect(await store.listAlerts("user-1")).toHaveLength(0);
});

test("missing prices and outages record honest failures", async () => {
  const store = await freshStore();
  const watch = await store.saveWatch("user-1", watchInput(40000));
  const args = {
    store,
    userSub: "user-1",
    watch,
    notifier: notifier(),
  };
  const noPrice = await runWatchCheck({
    ...args,
    fetchPage: async () => "A lovely page with no prices at all.",
  });
  expect(noPrice.status).toBe("no-price");
  expect(noPrice.watch.lastCheck?.status).toBe("no-price");
  const gone = await runWatchCheck({
    ...args,
    fetchPage: async () => "Sorry, this item is currently unavailable.",
  });
  expect(gone.status).toBe("unavailable");
  const down = await runWatchCheck({
    ...args,
    fetchPage: async () => {
      throw new Error("timeout");
    },
  });
  expect(down.status).toBe("fetch-failed");
  expect(down.error).toContain("timeout");
  expect(await store.listObservations("abc123")).toHaveLength(0);
});

test("alerts without an address stay in-app with honest state", async () => {
  const store = await freshStore();
  const watch = await store.saveWatch("user-1", {
    ...watchInput(40000),
    notifyEmail: null,
  });
  const sendAlert = vi.fn();
  const outcome = await runWatchCheck({
    store,
    userSub: "user-1",
    watch,
    fetchPage: async () => PAGE_AT_39000,
    notifier: { available: false, sendAlert },
  });
  expect(outcome.alert?.email).toEqual({ attempted: false, sent: false });
  expect(sendAlert).not.toHaveBeenCalled();
});

test("email failures never fail the check", async () => {
  const store = await freshStore();
  const watch = await store.saveWatch("user-1", watchInput(40000));
  const outcome = await runWatchCheck({
    store,
    userSub: "user-1",
    watch,
    fetchPage: async () => PAGE_AT_39000,
    notifier: {
      available: true,
      sendAlert: async () => ({ sent: false, error: "quota exceeded" }),
    },
  });
  expect(outcome.status).toBe("ok");
  expect(outcome.alert?.email).toMatchObject({
    attempted: true,
    sent: false,
    error: "quota exceeded",
  });
});

test("opportunistic evaluation alerts matching watches only", async () => {
  const store = await freshStore();
  await store.saveWatch("user-1", watchInput(40000));
  await store.saveWatch("user-2", watchInput(30000));
  const observations = await recordProductPrices(
    store,
    [
      {
        id: "abc123",
        title: "Test Laptop",
        url: "https://www.amazon.in/dp/B0TEST1",
        sourceId: "amazon-in",
        merchant: "Amazon India",
        snippet: "",
        score: 1,
        priceInr: 39000,
        priceEvidence: "repeated",
        priceSeenAt: "2026-02-01T00:00:00.000Z",
        retrievedAt: "2026-02-01T00:00:00.000Z",
      },
    ],
    "search",
  );
  const mailer = notifier();
  const created = await evaluateObservationsForUser({
    store,
    userSub: "user-1",
    observations,
    notifier: mailer,
  });
  expect(created).toHaveLength(1);
  expect(mailer.calls).toHaveLength(1);
  // Other users and unmatched targets are untouched.
  expect(await store.listAlerts("user-2")).toHaveLength(0);
  const again = await evaluateObservationsForUser({
    store,
    userSub: "user-1",
    observations,
    notifier: mailer,
  });
  expect(again).toHaveLength(0);
  expect(mailer.calls).toHaveLength(1);
});
