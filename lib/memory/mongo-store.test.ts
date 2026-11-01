import type { Db } from "mongodb";
import { beforeEach, expect, test } from "vitest";
import {
  DuplicateWatchError,
  MAX_ALERTS,
  MAX_CHAT_MESSAGES,
  MAX_CHAT_THREADS,
  MAX_DECISIONS,
  MAX_MONITOR_RUNS,
  MAX_OBSERVATIONS_PER_PRODUCT,
  MAX_OPPORTUNITIES,
  MAX_REMINDERS,
  MAX_WATCHES,
  RemindersFullError,
  WatchlistFullError,
} from "./file-store";
import { MongoMemoryStore } from "./mongo-store";
import { createDefaultProfile } from "./profile";

// --- In-memory fake of the driver surface MongoMemoryStore uses. ---

type FakeDoc = { _id: number | string; [key: string]: unknown };

function matchesFilter(
  doc: FakeDoc,
  filter: Record<string, unknown>,
): boolean {
  for (const [key, cond] of Object.entries(filter)) {
    if (
      cond !== null &&
      typeof cond === "object" &&
      !Array.isArray(cond) &&
      "$in" in cond
    ) {
      const values = (cond as { $in: unknown[] }).$in;
      if (!values.includes(doc[key])) {
        return false;
      }
    } else if (doc[key] !== cond) {
      return false;
    }
  }
  return true;
}

class FakeCursor {
  private docs: FakeDoc[];

  constructor(docs: FakeDoc[]) {
    this.docs = docs;
  }

  sort(spec: Record<string, 1 | -1>): this {
    const [[key, dir]] = Object.entries(spec);
    this.docs = [...this.docs].sort((a, b) => {
      const left = a[key as string] as number | string;
      const right = b[key as string] as number | string;
      if (left === right) {
        return 0;
      }
      return (left < right ? -1 : 1) * (dir === 1 ? 1 : -1);
    });
    return this;
  }

  limit(count: number): this {
    this.docs = this.docs.slice(0, count);
    return this;
  }

  async toArray(): Promise<FakeDoc[]> {
    return this.docs.map((doc) => ({ ...doc }));
  }
}

class FakeCollection {
  docs: FakeDoc[] = [];

  constructor(private readonly nextId: () => number) {}

  find(filter: Record<string, unknown>): FakeCursor {
    return new FakeCursor(this.docs.filter((doc) => matchesFilter(doc, filter)));
  }

  async findOne(filter: Record<string, unknown>): Promise<FakeDoc | null> {
    return (
      this.docs.find((doc) => matchesFilter(doc, filter)) ?? null
    );
  }

  async insertOne(doc: Record<string, unknown>): Promise<{ insertedId: unknown }> {
    const stored = { ...doc, _id: doc._id ?? this.nextId() } as FakeDoc;
    this.docs.push(stored);
    return { insertedId: stored._id };
  }

  async updateOne(
    filter: Record<string, unknown>,
    update: { $set: Record<string, unknown> },
    opts?: { upsert?: boolean },
  ): Promise<{ matchedCount: number; modifiedCount: number }> {
    const found = this.docs.find((doc) => matchesFilter(doc, filter));
    if (!found) {
      if (opts?.upsert) {
        const created = { ...update.$set } as FakeDoc;
        if (created._id === undefined) {
          created._id = this.nextId();
        }
        this.docs.push(created);
      }
      return { matchedCount: 0, modifiedCount: 0 };
    }
    Object.assign(found, update.$set);
    return { matchedCount: 1, modifiedCount: 1 };
  }

  async updateMany(
    filter: Record<string, unknown>,
    update: { $set: Record<string, unknown> },
  ): Promise<{ modifiedCount: number }> {
    let modified = 0;
    for (const doc of this.docs) {
      if (matchesFilter(doc, filter)) {
        Object.assign(doc, update.$set);
        modified += 1;
      }
    }
    return { modifiedCount: modified };
  }

  async replaceOne(
    filter: Record<string, unknown>,
    replacement: Record<string, unknown>,
  ): Promise<{ modifiedCount: number }> {
    const index = this.docs.findIndex((doc) => matchesFilter(doc, filter));
    if (index < 0) {
      return { modifiedCount: 0 };
    }
    const current = this.docs[index] as FakeDoc;
    this.docs[index] = { ...replacement, _id: current._id } as FakeDoc;
    return { modifiedCount: 1 };
  }

  async deleteOne(
    filter: Record<string, unknown>,
  ): Promise<{ deletedCount: number }> {
    const index = this.docs.findIndex((doc) => matchesFilter(doc, filter));
    if (index < 0) {
      return { deletedCount: 0 };
    }
    this.docs.splice(index, 1);
    return { deletedCount: 1 };
  }

  async deleteMany(
    filter: Record<string, unknown>,
  ): Promise<{ deletedCount: number }> {
    const before = this.docs.length;
    this.docs = this.docs.filter((doc) => !matchesFilter(doc, filter));
    return { deletedCount: before - this.docs.length };
  }

  async countDocuments(filter: Record<string, unknown>): Promise<number> {
    return this.docs.filter((doc) => matchesFilter(doc, filter)).length;
  }

  async distinct(key: string, filter: Record<string, unknown>): Promise<unknown[]> {
    const values = new Set<unknown>();
    for (const doc of this.docs) {
      if (matchesFilter(doc, filter)) {
        values.add(doc[key]);
      }
    }
    return [...values];
  }
}

function fakeDb(): { db: Db; seed: (name: string, doc: Record<string, unknown>) => void } {
  const collections = new Map<string, FakeCollection>();
  let counter = 0;
  const collection = (name: string): FakeCollection => {
    let found = collections.get(name);
    if (!found) {
      found = new FakeCollection(() => {
        counter += 1;
        return counter;
      });
      collections.set(name, found);
    }
    return found;
  };
  return {
    db: { collection } as unknown as Db,
    seed: (name, doc) => {
      void collection(name).insertOne(doc);
    },
  };
}

let store: MongoMemoryStore;
let seed: (name: string, doc: Record<string, unknown>) => void;

beforeEach(() => {
  const fake = fakeDb();
  store = new MongoMemoryStore(fake.db);
  seed = fake.seed;
});

// --- Fixtures (same shapes as file-store.test.ts). ---

function newWatch(targetPrice: number, productId = "abc123") {
  return {
    productId,
    url: "https://www.amazon.in/dp/B0TEST1",
    title: "Test Laptop",
    merchant: "Amazon India",
    targetPrice,
    currency: "INR",
    active: true,
    canWait: true,
  } as const;
}

function newObservation(priceInr: number, observedAt: string) {
  return {
    productId: "abc123",
    url: "https://www.amazon.in/dp/B0TEST1",
    title: "Test Laptop",
    merchant: "Amazon India",
    sourceId: "amazon-in",
    priceInr,
    currency: "INR",
    evidence: "repeated",
    candidates: 2,
    observedAt,
    source: "watch-check",
  } as const;
}

function newOpportunity(dedupeKey: string) {
  return {
    kind: "price-drop",
    dedupeKey,
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
  } as const;
}

function newMonitorRun() {
  return {
    startedAt: "2026-02-10T12:00:00.000Z",
    finishedAt: "2026-02-10T12:00:05.000Z",
    intervalMinutes: 240,
    maxChecksPerCycle: 10,
    ownersScanned: 2,
    due: 2,
    checked: 2,
    ok: 2,
    failed: 0,
    alerts: 1,
    opportunities: 1,
    remindersFired: 0,
    emails: 1,
    errors: [] as string[],
  };
}

// --- Profiles, settings, isolation. ---

test("round-trips a profile and clears it", async () => {
  expect(await store.getProfile("user-1")).toBeNull();
  await store.saveProfile(createDefaultProfile("user-1"));
  expect((await store.getProfile("user-1"))?.userSub).toBe("user-1");
  expect(await store.clearProfile("user-1")).toBe(true);
  expect(await store.getProfile("user-1")).toBeNull();
  expect(await store.clearProfile("user-1")).toBe(false);
});

test("rejects version drift and identity mismatch", async () => {
  seed("profiles", { _id: "user-1", version: 99, userSub: "user-1" });
  await expect(store.getProfile("user-1")).rejects.toThrow();
});

test("isolates users from each other", async () => {
  await store.saveDecision("user-1", {
    query: "mine",
    category: "electronics",
    verdict: "BUY",
    topPick: null,
  });
  expect(await store.listDecisions("user-2")).toEqual([]);
});

test("notification settings default and merge", async () => {
  const defaults = await store.getNotificationSettings("user-1");
  expect(defaults.priceEmails).toBe(true);
  const saved = await store.saveNotificationSettings("user-1", {
    priceEmails: false,
  });
  expect(saved.priceEmails).toBe(false);
  expect(saved.availabilityEmails).toBe(true);
  expect((await store.getNotificationSettings("user-1")).priceEmails).toBe(
    false,
  );
});

// --- Decisions, feedback, proposals, saved items. ---

test("decisions list newest-first with limit and cap", async () => {
  for (let i = 0; i < MAX_DECISIONS + 2; i += 1) {
    await store.saveDecision("user-1", {
      query: `query-${i}`,
      category: "electronics",
      verdict: "BUY",
      topPick: null,
    });
  }
  const all = await store.listDecisions("user-1");
  expect(all).toHaveLength(MAX_DECISIONS);
  expect(all[0]?.query).toBe(`query-${MAX_DECISIONS + 1}`);
  expect(await store.listDecisions("user-1", 2)).toHaveLength(2);
});

test("saved products upsert by productId and delete", async () => {
  await store.saveSavedProduct("user-1", {
    productId: "p1",
    title: "Laptop",
    merchant: "Amazon India",
    url: "https://www.amazon.in/dp/B0TEST1",
  });
  await store.saveSavedProduct("user-1", {
    productId: "p1",
    title: "Laptop v2",
    merchant: "Amazon India",
    url: "https://www.amazon.in/dp/B0TEST1",
  });
  const listed = await store.listSavedProducts("user-1");
  expect(listed).toHaveLength(1);
  expect(listed[0]?.title).toBe("Laptop v2");
  expect(await store.deleteSavedProduct("user-1", "p1")).toBe(true);
  expect(await store.deleteSavedProduct("user-1", "p1")).toBe(false);
});

test("saved comparisons save and delete", async () => {
  const saved = await store.saveSavedComparison("user-1", {
    category: "electronics",
    products: [
      { productId: "p1", title: "A", merchant: "M" },
      { productId: "p2", title: "B", merchant: "M" },
    ],
  });
  expect(await store.listSavedComparisons("user-1")).toHaveLength(1);
  expect(await store.deleteSavedComparison("user-1", saved.id)).toBe(true);
  expect(await store.listSavedComparisons("user-1")).toHaveLength(0);
});

test("feedback saves and lists", async () => {
  await store.saveFeedback("user-1", { helpful: true });
  expect(await store.listFeedback("user-1")).toHaveLength(1);
  expect(await store.listFeedback("user-1", 5)).toHaveLength(1);
});

test("proposals decide once; re-decide returns current", async () => {
  const item = await store.saveFeedback("user-1", { helpful: true });
  const proposal = await store.saveProposal("user-1", {
    kind: "general",
    patch: { preferredBrands: ["Sony"] },
    reason: "test",
    evidence: [item.id],
    fingerprint: "fp",
  });
  expect(proposal.status).toBe("pending");
  const decided = await store.decideProposal("user-1", proposal.id, "confirmed");
  expect(decided?.status).toBe("confirmed");
  expect(decided?.decidedAt).toBeTruthy();
  const again = await store.decideProposal("user-1", proposal.id, "rejected");
  expect(again?.status).toBe("confirmed");
  expect(await store.decideProposal("user-1", "missing", "confirmed")).toBeNull();
});

test("clearHistory counts and clears three lists", async () => {
  await store.saveDecision("user-1", {
    query: "query-q",
    category: "electronics",
    verdict: "BUY",
    topPick: null,
  });
  await store.saveFeedback("user-1", { helpful: false });
  const counts = await store.clearHistory("user-1");
  expect(counts).toMatchObject({ decisions: 1, feedback: 1, proposals: 0 });
  expect(await store.listDecisions("user-1")).toHaveLength(0);
});

// --- Observations, watches, alerts. ---

test("observations round prices, dedupe within the window, and cap", async () => {
  const first = await store.recordObservation(
    newObservation(45000.6, "2026-02-01T00:00:00.000Z"),
  );
  expect(first.recorded).toBe(true);
  expect(first.observation.priceInr).toBe(45001);
  const dup = await store.recordObservation(
    newObservation(45001, "2026-02-01T02:00:00.000Z"),
  );
  expect(dup.recorded).toBe(false);
  const changed = await store.recordObservation(
    newObservation(43000, "2026-02-01T03:00:00.000Z"),
  );
  expect(changed.recorded).toBe(true);
  const listed = await store.listObservations("abc123");
  expect(listed.map((obs) => obs.priceInr)).toEqual([43000, 45001]);
  expect(await store.listObservations("abc123", 1)).toHaveLength(1);

  for (let i = 0; i < MAX_OBSERVATIONS_PER_PRODUCT; i += 1) {
    await store.recordObservation(
      newObservation(40000 + i, `2026-03-${String((i % 28) + 1).padStart(2, "0")}T00:00:00.000Z`),
    );
  }
  expect(await store.listObservations("abc123")).toHaveLength(
    MAX_OBSERVATIONS_PER_PRODUCT,
  );
});

test("watches save, update, retarget, and delete", async () => {
  const watch = await store.saveWatch("user-1", newWatch(40000));
  expect(await store.getWatch("user-1", watch.id)).toMatchObject({
    targetPrice: 40000,
  });
  expect(await store.getWatch("user-1", "missing")).toBeNull();
  const renamed = await store.updateWatch("user-1", {
    id: watch.id,
    variantLabel: "16GB",
  });
  expect(renamed?.variantLabel).toBe("16GB");
  const cleared = await store.updateWatch("user-1", {
    id: watch.id,
    variantLabel: null,
  });
  expect(cleared?.variantLabel).toBeUndefined();
  const retargeted = await store.updateWatch("user-1", {
    id: watch.id,
    targetPrice: 38000,
  });
  expect(retargeted?.targetPrice).toBe(38000);
  expect(retargeted?.lastAlertAt).toBeUndefined();
  expect(await store.updateWatch("user-1", { id: "missing" })).toBeNull();
  expect(await store.deleteWatch("user-1", watch.id)).toBe(true);
  expect(await store.deleteWatch("user-1", watch.id)).toBe(false);
});

test("watches reject duplicates and enforce the cap", async () => {
  await store.saveWatch("user-1", newWatch(40000));
  await expect(store.saveWatch("user-1", newWatch(40000))).rejects.toThrow(
    DuplicateWatchError,
  );
  // Same product at a different target is a different question.
  await store.saveWatch("user-1", newWatch(39000));
  for (let i = 0; i < MAX_WATCHES; i += 1) {
    await store
      .saveWatch("user-1", newWatch(1000 + i, `product-${i}`))
      .catch(() => null);
  }
  await expect(
    store.saveWatch("user-1", newWatch(999, "one-too-many")),
  ).rejects.toThrow(WatchlistFullError);
});

test("watch checks update the check stamp", async () => {
  const watch = await store.saveWatch("user-1", newWatch(40000));
  const updated = await store.updateWatchCheck("user-1", watch.id, {
    at: "2026-02-10T12:00:00.000Z",
    status: "ok",
    priceInr: 39000,
  });
  expect(updated?.lastCheck?.status).toBe("ok");
  expect(
    await store.updateWatchCheck("user-1", "missing", {
      at: "2026-02-10T12:00:00.000Z",
      status: "ok",
    }),
  ).toBeNull();
});

test("alerts stamp the watch and mark read with counts", async () => {
  const watch = await store.saveWatch("user-1", newWatch(40000));
  const alert = await store.saveAlert("user-1", {
    watchId: watch.id,
    productId: watch.productId,
    title: watch.title,
    merchant: watch.merchant,
    url: watch.url,
    observedPrice: 39000,
    targetPrice: 40000,
    observedAt: "2026-02-01T00:00:00.000Z",
  });
  expect(alert.read).toBe(false);
  expect(alert.currency).toBe("INR");
  const stamped = await store.getWatch("user-1", watch.id);
  expect(stamped?.lastAlertedPrice).toBe(39000);
  expect(stamped?.lastAlertAt).toBe(alert.createdAt);
  expect(await store.markAlertsRead("user-1", [alert.id])).toBe(1);
  expect(await store.markAlertsRead("user-1", [alert.id])).toBe(0);
  await store.saveAlert("user-1", {
    watchId: watch.id,
    productId: watch.productId,
    title: watch.title,
    merchant: watch.merchant,
    url: watch.url,
    observedPrice: 38000,
    targetPrice: 40000,
    observedAt: "2026-02-02T00:00:00.000Z",
  });
  expect(await store.markAlertsRead("user-1", "all")).toBe(1);
  await store.updateAlertEmail("user-1", alert.id, {
    attempted: true,
    sent: true,
  });
  const listed = await store.listAlerts("user-1");
  expect(
    listed.find((entry) => entry.id === alert.id)?.email,
  ).toMatchObject({ sent: true });
  expect(await store.listAlerts("user-1", 1)).toHaveLength(1);
});

test("alerts prune past the cap", async () => {
  const watch = await store.saveWatch("user-1", newWatch(40000));
  for (let i = 0; i < MAX_ALERTS + 3; i += 1) {
    await store.saveAlert("user-1", {
      watchId: watch.id,
      productId: watch.productId,
      title: watch.title,
      merchant: watch.merchant,
      url: watch.url,
      observedPrice: 39000 - i,
      targetPrice: 40000,
      observedAt: "2026-02-01T00:00:00.000Z",
    });
  }
  expect(await store.listAlerts("user-1")).toHaveLength(MAX_ALERTS);
});

// --- Opportunities, reminders, chat, runs, owners. ---

test("opportunities save active, update, and find by key", async () => {
  const saved = await store.saveOpportunity(
    "user-1",
    newOpportunity("price-drop:p1:84000"),
  );
  expect(saved.status).toBe("active");
  expect(
    await store.findOpportunityByDedupeKey("user-1", "price-drop:p1:84000"),
  ).toMatchObject({ id: saved.id });
  expect(
    await store.findOpportunityByDedupeKey("user-1", "missing"),
  ).toBeNull();
  const dismissed = await store.updateOpportunityStatus(
    "user-1",
    saved.id,
    "dismissed",
  );
  expect(dismissed?.status).toBe("dismissed");
  expect(
    await store.updateOpportunityStatus("user-1", "missing", "dismissed"),
  ).toBeNull();
  await store.updateOpportunityEmail("user-1", saved.id, {
    attempted: true,
    sent: false,
    error: "nope",
  });
  const listed = await store.listOpportunities("user-1");
  expect(listed[0]?.email).toMatchObject({ attempted: true, sent: false });
});

test("opportunities prune past the cap", async () => {
  for (let i = 0; i < MAX_OPPORTUNITIES + 2; i += 1) {
    await store.saveOpportunity("user-1", newOpportunity(`k:${i}`));
  }
  expect(await store.listOpportunities("user-1")).toHaveLength(
    MAX_OPPORTUNITIES,
  );
});

test("reminders save, merge updates, re-arm, and delete", async () => {
  const reminder = await store.saveReminder("user-1", {
    title: "Revisit the laptop",
    kind: "one-time",
    remindAt: "2026-02-17T12:00:00.000Z",
    timezone: "Asia/Kolkata",
    note: "Decide before the trip",
  });
  expect(reminder.status).toBe("active");
  const renamed = await store.updateReminder("user-1", {
    id: reminder.id,
    title: "Revisit soon",
  });
  expect(renamed?.title).toBe("Revisit soon");
  expect(renamed?.note).toBe("Decide before the trip");
  const noNote = await store.updateReminder("user-1", {
    id: reminder.id,
    note: null,
  });
  expect(noNote?.note).toBeUndefined();
  const fired = await store.updateReminder("user-1", {
    id: reminder.id,
    status: "done",
    firedAt: "2026-02-17T12:00:00.000Z",
    firedBecause: "time",
  });
  expect(fired?.firedAt).toBeTruthy();
  const rearmed = await store.updateReminder("user-1", {
    id: reminder.id,
    status: "active",
  });
  expect(rearmed?.firedAt).toBeUndefined();
  expect(rearmed?.firedBecause).toBeUndefined();
  expect(await store.updateReminder("user-1", { id: "missing" })).toBeNull();
  await store.updateReminderEmail("user-1", reminder.id, {
    attempted: true,
    sent: true,
  });
  expect(
    (await store.listReminders("user-1"))[0]?.email,
  ).toMatchObject({ sent: true });
  expect(await store.deleteReminder("user-1", reminder.id)).toBe(true);
  expect(await store.deleteReminder("user-1", reminder.id)).toBe(false);
});

test("reminders enforce the cap", async () => {
  for (let i = 0; i < MAX_REMINDERS; i += 1) {
    await store.saveReminder("user-1", {
      title: `Reminder ${i}`,
      kind: "one-time",
      remindAt: "2026-02-17T12:00:00.000Z",
      timezone: "Asia/Kolkata",
    });
  }
  await expect(
    store.saveReminder("user-1", {
      title: "One too many",
      kind: "one-time",
      remindAt: "2026-02-17T12:00:00.000Z",
      timezone: "Asia/Kolkata",
    }),
  ).rejects.toThrow(RemindersFullError);
});

test("chat threads create, append with cap, and delete", async () => {
  const thread = await store.createChatThread("user-1", {
    title: "ThinkPad deal?",
    firstMessage: { role: "user", text: "Is it a deal?" },
  });
  expect(thread.messages).toHaveLength(1);
  expect((await store.getChatThread("user-1", thread.id))?.id).toBe(thread.id);
  expect(await store.getChatThread("user-1", "missing")).toBeNull();
  const updated = await store.appendChatMessages("user-1", thread.id, [
    { role: "assistant", text: "Yes.", sources: [{ label: "listing" }] },
  ]);
  expect(updated?.messages).toHaveLength(2);
  expect(
    await store.appendChatMessages("user-1", "missing", [
      { role: "user", text: "hi" },
    ]),
  ).toBeNull();
  const many = Array.from({ length: MAX_CHAT_MESSAGES + 5 }, (_, i) => ({
    role: "user" as const,
    text: `message ${i}`,
  }));
  const capped = await store.appendChatMessages("user-1", thread.id, many);
  expect(capped?.messages).toHaveLength(MAX_CHAT_MESSAGES);
  expect(await store.deleteChatThread("user-1", thread.id)).toBe(true);
  expect(await store.deleteChatThread("user-1", thread.id)).toBe(false);
});

test("chat threads prune past the cap", async () => {
  for (let i = 0; i < MAX_CHAT_THREADS + 2; i += 1) {
    await store.createChatThread("user-1", {
      title: `Thread ${i}`,
      firstMessage: { role: "user", text: "hi" },
    });
  }
  expect(await store.listChatThreads("user-1")).toHaveLength(MAX_CHAT_THREADS);
});

test("monitor runs record newest-first with cap", async () => {
  const run = await store.recordMonitorRun(newMonitorRun());
  expect(run.id).toBeTruthy();
  expect(await store.listMonitorRuns(1)).toEqual([run]);
  for (let i = 0; i < MAX_MONITOR_RUNS + 2; i += 1) {
    await store.recordMonitorRun(newMonitorRun());
  }
  expect(await store.listMonitorRuns()).toHaveLength(MAX_MONITOR_RUNS);
});

test("owner lists find watch and active-reminder owners", async () => {
  await store.saveWatch("user-1", newWatch(40000));
  const reminder = await store.saveReminder("user-1", {
    title: "R",
    kind: "one-time",
    remindAt: "2026-02-17T12:00:00.000Z",
    timezone: "Asia/Kolkata",
  });
  await store.saveWatch("user-2", newWatch(1000, "other"));
  expect(await store.listWatchOwners()).toEqual(
    expect.arrayContaining(["user-1", "user-2"]),
  );
  expect(await store.listReminderOwners()).toEqual(["user-1"]);
  await store.updateReminder("user-1", { id: reminder.id, status: "done" });
  expect(await store.listReminderOwners()).toEqual([]);
});

test("invalid stored docs are skipped, not fatal", async () => {
  seed("decisions", { userSub: "user-1", garbage: true });
  await store.saveDecision("user-1", {
    query: "query-q",
    category: "electronics",
    verdict: "BUY",
    topPick: null,
  });
  const listed = await store.listDecisions("user-1");
  expect(listed).toHaveLength(1);
  expect(listed[0]?.query).toBe("query-q");
});
