import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { FileMemoryStore } from "../memory/file-store";
import type { NewReminder } from "../memory/records";
import { fireDueReminders } from "./fire";

const NOW = new Date("2026-02-10T12:00:00.000Z").getTime();
const at = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

async function freshStore(): Promise<FileMemoryStore> {
  return new FileMemoryStore(await mkdtemp(path.join(tmpdir(), "wisora-fire-")));
}

function reminderInput(overrides: Partial<NewReminder> = {}): NewReminder {
  return {
    title: "Revisit the laptop",
    kind: "one-time",
    remindAt: at(-1000),
    timezone: "UTC",
    ...overrides,
  };
}

test("time-due product reminders fire once with a feed card", async () => {
  const store = await freshStore();
  await store.saveReminder(
    "user-1",
    reminderInput({
      productId: "p1",
      url: "https://www.amazon.in/dp/B0TEST1",
      merchant: "Amazon India",
      note: "Decide before the trip",
    }),
  );
  const first = await fireDueReminders({ store, userSub: "user-1", nowMs: NOW });
  expect(first.fired).toHaveLength(1);
  expect(first.fired[0]).toMatchObject({
    status: "done",
    firedBecause: "time",
  });
  expect(first.opportunities).toHaveLength(1);
  expect(first.opportunities[0]).toMatchObject({
    kind: "reminder-due",
    status: "active",
    productId: "p1",
    evidence: { source: "reminder", observedAt: at(0) },
  });
  expect(first.opportunities[0]?.reason).toContain("Decide before the trip");

  const second = await fireDueReminders({ store, userSub: "user-1", nowMs: NOW });
  expect(second.fired).toHaveLength(0);
  expect(second.opportunities).toHaveLength(0);
});

test("freeform reminders fire without a feed card", async () => {
  const store = await freshStore();
  await store.saveReminder("user-1", reminderInput());
  const result = await fireDueReminders({ store, userSub: "user-1", nowMs: NOW });
  expect(result.fired).toHaveLength(1);
  expect(result.opportunities).toHaveLength(0);
});

test("future and disabled reminders stay untouched", async () => {
  const store = await freshStore();
  await store.saveReminder("user-1", reminderInput({ remindAt: at(3600000) }));
  const paused = await store.saveReminder("user-1", reminderInput());
  await store.updateReminder("user-1", { id: paused.id, status: "disabled" });
  const result = await fireDueReminders({ store, userSub: "user-1", nowMs: NOW });
  expect(result.fired).toHaveLength(0);
  expect((await store.listReminders("user-1")).every((r) => r.status !== "done")).toBe(true);
});

test("fresh target hits fire even before the reminder time", async () => {
  const store = await freshStore();
  await store.recordObservation({
    productId: "p1",
    url: "https://www.amazon.in/dp/B0TEST1",
    title: "Test Laptop",
    merchant: "Amazon India",
    sourceId: "amazon-in",
    priceInr: 64000,
    currency: "INR",
    evidence: "repeated",
    candidates: 2,
    observedAt: at(-1000),
    source: "watch-check",
  });
  await store.saveReminder(
    "user-1",
    reminderInput({
      remindAt: at(7 * 24 * 3600000),
      productId: "p1",
      url: "https://www.amazon.in/dp/B0TEST1",
      merchant: "Amazon India",
      targetPriceInr: 65000,
    }),
  );
  const result = await fireDueReminders({ store, userSub: "user-1", nowMs: NOW });
  expect(result.fired[0]).toMatchObject({ firedBecause: "target" });
  expect(result.opportunities[0]?.currentPriceInr).toBe(64000);
  expect(result.opportunities[0]?.reason).toContain("target was met");
});

test("stale observations never trigger target firing", async () => {
  const store = await freshStore();
  await store.recordObservation({
    productId: "p1",
    url: "https://www.amazon.in/dp/B0TEST1",
    title: "Test Laptop",
    merchant: "Amazon India",
    sourceId: "amazon-in",
    priceInr: 64000,
    currency: "INR",
    evidence: "single",
    candidates: 1,
    observedAt: at(-8 * 24 * 3600000),
    source: "search",
  });
  await store.saveReminder(
    "user-1",
    reminderInput({
      remindAt: at(7 * 24 * 3600000),
      productId: "p1",
      targetPriceInr: 65000,
    }),
  );
  const result = await fireDueReminders({ store, userSub: "user-1", nowMs: NOW });
  expect(result.fired).toHaveLength(0);
});
