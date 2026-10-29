import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { createDefaultProfile } from "./profile";
import { FileMemoryStore, StoredDataError } from "./file-store";

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
