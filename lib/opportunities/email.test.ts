import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { FileMemoryStore } from "../memory/file-store";
import type { Notifier } from "../prices/notify";
import { maybeSendOpportunityEmail, opportunityEmail } from "./email";
import type { Opportunity } from "./schema";

async function freshStore(): Promise<FileMemoryStore> {
  return new FileMemoryStore(await mkdtemp(path.join(tmpdir(), "wisora-oemail-")));
}

function capturingNotifier(sent = true): Notifier & { calls: string[] } {
  const calls: string[] = [];
  return {
    available: true,
    calls,
    sendAlert: async () => ({ sent: false, error: "unused" }),
    sendEmail: async (input) => {
      calls.push(`${input.to}|${input.subject}`);
      return sent ? { sent: true } : { sent: false, error: "boom" };
    },
  };
}

function stored(input: Partial<Opportunity> & { id: string }): Opportunity {
  return {
    createdAt: "2026-02-10T12:00:00.000Z",
    kind: "price-drop",
    status: "active",
    dedupeKey: "price-drop:p1:84000",
    productId: "p1",
    title: "Test Laptop",
    merchant: "Amazon India",
    url: "https://www.amazon.in/dp/B0TEST1",
    currentPriceInr: 84000,
    previousPriceInr: 90000,
    targetPriceInr: 85000,
    reason: "Dropped.",
    evidence: {
      source: "watch-check",
      observedAt: "2026-02-10T12:00:00.000Z",
    },
    ...input,
  };
}

test("templates carry kind, prices, reason, and a disclaimer", () => {
  const drop = opportunityEmail(stored({ id: "o1" }));
  expect(drop.subject).toContain("Price drop");
  expect(drop.subject).toContain("₹84,000");
  expect(drop.text).toContain("Dropped.");
  expect(drop.text).toContain("single verified observation");

  const restored = opportunityEmail(
    stored({
      id: "o2",
      kind: "restored",
      currentPriceInr: null,
      previousPriceInr: null,
    }),
  );
  expect(restored.subject).toContain("Back available");
  expect(restored.text).not.toContain("Current price");
});

test("unconfigured email and missing addresses skip honestly", async () => {
  const store = await freshStore();
  const saved = await store.saveOpportunity("user-1", {
    kind: "price-drop",
    dedupeKey: "price-drop:p1:84000",
    productId: "p1",
    title: "Test Laptop",
    merchant: "Amazon India",
    url: "https://www.amazon.in/dp/B0TEST1",
    currentPriceInr: 84000,
    previousPriceInr: 90000,
    targetPriceInr: null,
    reason: "Dropped.",
    evidence: {
      source: "watch-check",
      observedAt: "2026-02-10T12:00:00.000Z",
    },
  });
  const offline: Notifier = {
    available: false,
    sendAlert: async () => ({ sent: false }),
    sendEmail: async () => ({ sent: false }),
  };
  expect(
    await maybeSendOpportunityEmail({
      store,
      notifier: offline,
      userSub: "user-1",
      opportunity: saved,
    }),
  ).toBe(false);
  const noAddress = await store.listOpportunities("user-1");
  expect(noAddress[0]?.email).toMatchObject({
    attempted: false,
    sent: false,
  });

  // Configured notifier, but the opportunity has no watch address.
  const capture = capturingNotifier();
  expect(
    await maybeSendOpportunityEmail({
      store,
      notifier: capture,
      userSub: "user-1",
      opportunity: saved,
    }),
  ).toBe(false);
  expect(capture.calls).toHaveLength(0);
});

test("every trigger sends; provider errors record", async () => {
  const store = await freshStore();
  const watch = await store.saveWatch("user-1", {
    productId: "p1",
    url: "https://www.amazon.in/dp/B0TEST1",
    title: "Test Laptop",
    merchant: "Amazon India",
    targetPrice: 85000,
    currency: "INR",
    active: true,
    canWait: true,
    notifyEmail: "user@example.com",
  });
  const save = (key: string) =>
    store.saveOpportunity("user-1", {
      kind: "price-drop",
      dedupeKey: key,
      watchId: watch.id,
      productId: "p1",
      title: "Test Laptop",
      merchant: "Amazon India",
      url: "https://www.amazon.in/dp/B0TEST1",
      currentPriceInr: 84000,
      previousPriceInr: 90000,
      targetPriceInr: null,
      reason: "Dropped.",
      evidence: {
        source: "watch-check",
        observedAt: "2026-02-10T12:00:00.000Z",
      },
    });
  const capture = capturingNotifier();
  const first = await save("price-drop:p1:84000");
  expect(
    await maybeSendOpportunityEmail({
      store,
      notifier: capture,
      userSub: "user-1",
      opportunity: first,
    }),
  ).toBe(true);
  expect(capture.calls).toHaveLength(1);
  expect(capture.calls[0]).toContain("user@example.com");

  // No cap: the second trigger sends too.
  const second = await save("price-drop:p1:83000");
  expect(
    await maybeSendOpportunityEmail({
      store,
      notifier: capture,
      userSub: "user-1",
      opportunity: second,
    }),
  ).toBe(true);
  expect(capture.calls).toHaveLength(2);
  const storedSecond = await store.findOpportunityByDedupeKey(
    "user-1",
    "price-drop:p1:83000",
  );
  expect(storedSecond?.email).toMatchObject({
    attempted: true,
    sent: true,
  });

  // Provider failures record attempted-but-unsent.
  const failing = capturingNotifier(false);
  const third = await save("price-drop:p1:82000");
  expect(
    await maybeSendOpportunityEmail({
      store,
      notifier: failing,
      userSub: "user-1",
      opportunity: third,
    }),
  ).toBe(false);
  const storedThird = await store.findOpportunityByDedupeKey(
    "user-1",
    "price-drop:p1:82000",
  );
  expect(storedThird?.email).toMatchObject({ attempted: true, sent: false });
});
