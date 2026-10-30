import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { createDefaultProfile } from "./profile";
import {
  DuplicateWatchError,
  FileMemoryStore,
  StoredDataError,
} from "./file-store";

async function freshStore(): Promise<{ store: FileMemoryStore; dir: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), "wisora-memory-"));
  return { store: new FileMemoryStore(dir), dir };
}

test("round-trips a profile", async () => {
  const { store } = await freshStore();
  const profile = createDefaultProfile("user-1");
  await store.saveProfile(profile);
  expect(await store.getProfile("user-1")).toEqual(profile);
});

test("returns null for an unknown user", async () => {
  const { store } = await freshStore();
  expect(await store.getProfile("nobody")).toBeNull();
});

test("rejects invalid profiles on save", async () => {
  const { store } = await freshStore();
  await expect(
    store.saveProfile({ version: 1 } as never),
  ).rejects.toThrow();
});

test("isolates users from each other", async () => {
  const { store } = await freshStore();
  const first = createDefaultProfile("user-1");
  first.general.value.preferredBrands.push("Sony");
  await store.saveProfile(first);
  await store.saveProfile(createDefaultProfile("user-2"));
  expect((await store.getProfile("user-1"))?.general.value.preferredBrands)
    .toEqual(["Sony"]);
  expect((await store.getProfile("user-2"))?.general.value.preferredBrands)
    .toEqual([]);
});

test("clears an existing profile and reports a missing one", async () => {
  const { store } = await freshStore();
  expect(await store.clearProfile("user-1")).toBe(false);
  await store.saveProfile(createDefaultProfile("user-1"));
  expect(await store.clearProfile("user-1")).toBe(true);
  expect(await store.getProfile("user-1")).toBeNull();
});

test("quarantines unparseable bytes and starts fresh", async () => {
  const { store, dir } = await freshStore();
  await store.saveProfile(createDefaultProfile("user-1"));
  const userDir = (await readdir(path.join(dir, "users")))[0] as string;
  const file = path.join(dir, "users", userDir, "profile.json");
  await writeFile(file, "{not json", "utf8");
  expect(await store.getProfile("user-1")).toBeNull();
  const entries = await readdir(path.join(dir, "users", userDir));
  expect(entries.some((name) => name.startsWith("profile.json.corrupt-"))).toBe(
    true,
  );
  expect(await readFile(file, "utf8").catch(() => null)).toBeNull();
});

test("quarantines schema-invalid profiles", async () => {
  const { store, dir } = await freshStore();
  await store.saveProfile(createDefaultProfile("user-1"));
  const userDir = (await readdir(path.join(dir, "users")))[0] as string;
  const file = path.join(dir, "users", userDir, "profile.json");
  await writeFile(
    file,
    JSON.stringify({ version: 1, userSub: "user-1" }),
    "utf8",
  );
  expect(await store.getProfile("user-1")).toBeNull();
});

test("decisions list newest-first with an optional limit", async () => {
  const { store } = await freshStore();
  const base = {
    category: "electronics",
    topPick: null,
    verdict: "BUY",
  } as const;
  await store.saveDecision("user-1", { ...base, query: "first" });
  await store.saveDecision("user-1", { ...base, query: "second" });
  const all = await store.listDecisions("user-1");
  expect(all.map((d) => d.query)).toEqual(["second", "first"]);
  expect(all[0]?.id).toMatch(/^[0-9a-f]{24}$/);
  expect(await store.listDecisions("user-1", 1)).toHaveLength(1);
  expect(await store.listDecisions("user-2")).toEqual([]);
});

test("saved products upsert by productId", async () => {
  const { store } = await freshStore();
  const base = {
    productId: "p1",
    title: "Sony X",
    url: "https://www.amazon.in/dp/B0TEST1",
    merchant: "Amazon India",
  };
  await store.saveSavedProduct("user-1", base);
  await store.saveSavedProduct("user-1", { ...base, note: "birthday gift" });
  const items = await store.listSavedProducts("user-1");
  expect(items).toHaveLength(1);
  expect(items[0]?.note).toBe("birthday gift");
  expect(items[0]?.savedAt).toBeDefined();
  expect(await store.deleteSavedProduct("user-1", "missing")).toBe(false);
  expect(await store.deleteSavedProduct("user-1", "p1")).toBe(true);
  expect(await store.listSavedProducts("user-1")).toEqual([]);
});

test("saved comparisons round-trip and delete by id", async () => {
  const { store } = await freshStore();
  const product = { productId: "p1", title: "A", merchant: "M" };
  const saved = await store.saveSavedComparison("user-1", {
    category: "electronics",
    products: [product, { ...product, productId: "p2" }],
  });
  expect(await store.deleteSavedComparison("user-1", "missing")).toBe(false);
  expect(await store.deleteSavedComparison("user-1", saved.id)).toBe(true);
  expect(await store.listSavedComparisons("user-1")).toEqual([]);
});

test("feedback and proposals persist with stamped identity", async () => {
  const { store } = await freshStore();
  const item = await store.saveFeedback("user-1", { helpful: true });
  expect(item.id).toMatch(/^[0-9a-f]{24}$/);
  expect(await store.listFeedback("user-1")).toHaveLength(1);
  const proposal = await store.saveProposal("user-1", {
    kind: "general",
    patch: { preferredBrands: ["Sony"] },
    reason: "test",
    evidence: [item.id],
    fingerprint: "fp",
  });
  expect(proposal.status).toBe("pending");
  expect(proposal.decidedAt).toBeUndefined();
  expect(await store.listProposals("user-1")).toHaveLength(1);
});

test("deciding a proposal is idempotent and never flips", async () => {
  const { store } = await freshStore();
  expect(await store.decideProposal("user-1", "missing", "rejected")).toBeNull();
  const proposal = await store.saveProposal("user-1", {
    kind: "general",
    patch: { preferredBrands: ["Sony"] },
    reason: "test",
    evidence: [],
    fingerprint: "fp",
  });
  const confirmed = await store.decideProposal(
    "user-1",
    proposal.id,
    "confirmed",
  );
  expect(confirmed?.status).toBe("confirmed");
  expect(confirmed?.decidedAt).toBeDefined();
  const again = await store.decideProposal("user-1", proposal.id, "rejected");
  expect(again?.status).toBe("confirmed");
});

test("clearHistory removes decisions, feedback, and proposals", async () => {
  const { store } = await freshStore();
  expect(await store.clearHistory("user-1")).toEqual({
    decisions: 0,
    feedback: 0,
    proposals: 0,
  });
  await store.saveDecision("user-1", {
    query: "laptop",
    category: "electronics",
    topPick: null,
    verdict: "BUY",
  });
  await store.saveFeedback("user-1", { helpful: true });
  await store.saveProposal("user-1", {
    kind: "general",
    patch: { preferredBrands: ["Sony"] },
    reason: "test",
    evidence: [],
    fingerprint: "fp",
  });
  await store.saveSavedProduct("user-1", {
    productId: "p1",
    title: "Sony X",
    url: "https://www.amazon.in/dp/B0TEST1",
    merchant: "Amazon India",
  });
  expect(await store.clearHistory("user-1")).toEqual({
    decisions: 1,
    feedback: 1,
    proposals: 1,
  });
  expect(await store.listDecisions("user-1")).toEqual([]);
  expect(await store.listFeedback("user-1")).toEqual([]);
  expect(await store.listProposals("user-1")).toEqual([]);
  // Explicit keepsakes survive history clearing.
  expect(await store.listSavedProducts("user-1")).toHaveLength(1);
});

test("corrupt record files quarantine to empty lists", async () => {
  const { store, dir } = await freshStore();
  await store.saveDecision("user-1", {
    query: "laptop",
    category: "electronics",
    topPick: null,
    verdict: "BUY",
  });
  const userDir = (await readdir(path.join(dir, "users")))[0] as string;
  await writeFile(
    path.join(dir, "users", userDir, "decisions.json"),
    "{not json",
    "utf8",
  );
  expect(await store.listDecisions("user-1")).toEqual([]);
  const entries = await readdir(path.join(dir, "users", userDir));
  expect(
    entries.some((name) => name.startsWith("decisions.json.corrupt-")),
  ).toBe(true);
});

test("observations dedup same-price repeats but keep changes", async () => {
  const { store } = await freshStore();
  const base = {
    productId: "abc123",
    url: "https://www.amazon.in/dp/B0TEST1",
    title: "Test Laptop",
    merchant: "Amazon India",
    sourceId: "amazon-in",
    currency: "INR",
    evidence: "repeated",
    candidates: 2,
    source: "search",
  } as const;
  const first = await store.recordObservation({
    ...base,
    priceInr: 45000,
    observedAt: "2026-02-01T00:00:00.000Z",
  });
  expect(first.recorded).toBe(true);
  const dup = await store.recordObservation({
    ...base,
    priceInr: 45000,
    observedAt: "2026-02-01T02:00:00.000Z",
  });
  expect(dup.recorded).toBe(false);
  expect(dup.observation.priceInr).toBe(45000);
  const changed = await store.recordObservation({
    ...base,
    priceInr: 43000,
    observedAt: "2026-02-01T03:00:00.000Z",
  });
  expect(changed.recorded).toBe(true);
  expect(await store.listObservations("abc123")).toHaveLength(2);
  expect(await store.listObservations("other")).toEqual([]);
});

test("observations reject unsafe product ids", async () => {
  const { store } = await freshStore();
  await expect(store.listObservations("../evil")).rejects.toBeInstanceOf(
    StoredDataError,
  );
});

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

test("watches save, update, and delete", async () => {
  const { store } = await freshStore();
  const watch = await store.saveWatch("user-1", newWatch(40000));
  expect(watch.id).toMatch(/^[0-9a-f]{24}$/);
  expect(await store.getWatch("user-1", watch.id)).not.toBeNull();
  expect(await store.getWatch("user-1", "missing")).toBeNull();
  const updated = await store.updateWatch("user-1", {
    id: watch.id,
    active: false,
  });
  expect(updated?.active).toBe(false);
  expect(await store.updateWatch("user-1", { id: "missing" })).toBeNull();
  expect(await store.deleteWatch("user-1", "missing")).toBe(false);
  expect(await store.deleteWatch("user-1", watch.id)).toBe(true);
});

test("duplicate active watches at the same target are refused", async () => {
  const { store } = await freshStore();
  await store.saveWatch("user-1", newWatch(40000));
  await expect(
    store.saveWatch("user-1", newWatch(40000)),
  ).rejects.toBeInstanceOf(DuplicateWatchError);
  // A different target on the same product is a different question.
  await store.saveWatch("user-1", newWatch(35000));
  expect(await store.listWatches("user-1")).toHaveLength(2);
});

test("retargeting a watch resets its alert state", async () => {
  const { store } = await freshStore();
  const watch = await store.saveWatch("user-1", newWatch(40000));
  await store.saveAlert("user-1", {
    watchId: watch.id,
    productId: watch.productId,
    title: watch.title,
    merchant: watch.merchant,
    url: watch.url,
    observedPrice: 39000,
    targetPrice: 40000,
    observedAt: "2026-02-01T00:00:00.000Z",
  });
  expect((await store.getWatch("user-1", watch.id))?.lastAlertedPrice).toBe(
    39000,
  );
  const retargeted = await store.updateWatch("user-1", {
    id: watch.id,
    targetPrice: 35000,
  });
  expect(retargeted?.lastAlertAt).toBeUndefined();
  expect(retargeted?.lastAlertedPrice).toBeUndefined();
});

test("alerts list, mark read, and track email outcome", async () => {
  const { store } = await freshStore();
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
  await store.updateAlertEmail("user-1", alert.id, {
    attempted: true,
    sent: true,
  });
  expect((await store.listAlerts("user-1"))[0]?.email).toEqual({
    attempted: true,
    sent: true,
  });
  expect(await store.markAlertsRead("user-1", [alert.id])).toBe(1);
  expect(await store.markAlertsRead("user-1", "all")).toBe(0);
});

test("listWatchOwners finds only dirs holding watches", async () => {
  const { store } = await freshStore();
  await store.saveProfile(createDefaultProfile("lonely"));
  await store.saveWatch("user-1", newWatch(40000));
  expect(await store.listWatchOwners()).toEqual(["user-1"]);
});

test("refuses version drift without quarantining", async () => {
  const { store, dir } = await freshStore();
  await store.saveProfile(createDefaultProfile("user-1"));
  const userDir = (await readdir(path.join(dir, "users")))[0] as string;
  const file = path.join(dir, "users", userDir, "profile.json");
  await writeFile(
    file,
    JSON.stringify({ version: 99, userSub: "user-1" }),
    "utf8",
  );
  await expect(store.getProfile("user-1")).rejects.toBeInstanceOf(
    StoredDataError,
  );
  // Original bytes preserved for a future migration.
  expect(JSON.parse(await readFile(file, "utf8")).version).toBe(99);
});
