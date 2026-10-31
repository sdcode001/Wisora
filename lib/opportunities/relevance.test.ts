import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { FileMemoryStore } from "../memory/file-store";
import { createDefaultProfile } from "../memory/profile";
import { evaluateRelevance } from "./relevance";
import type { NewOpportunity } from "./schema";

async function freshStore(): Promise<FileMemoryStore> {
  return new FileMemoryStore(await mkdtemp(path.join(tmpdir(), "wisora-rel-")));
}

function candidate(overrides: Partial<NewOpportunity> = {}): NewOpportunity {
  return {
    kind: "price-drop",
    dedupeKey: "price-drop:p1:84000",
    productId: "p1",
    title: "Lenovo Laptop XYZ",
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
    ...overrides,
  };
}

test("no profile means neutral acceptance", async () => {
  const store = await freshStore();
  const verdict = await evaluateRelevance({
    store,
    userSub: "ghost",
    opportunity: candidate(),
  });
  expect(verdict).toEqual({
    relevant: true,
    relevance: { score: 50, reasons: [] },
  });
});

test("avoided brands suppress on whole-word matches only", async () => {
  const store = await freshStore();
  const profile = createDefaultProfile("user-1");
  profile.general.value.avoidedBrands = ["Lenovo"];
  await store.saveProfile(profile);
  const suppressed = await evaluateRelevance({
    store,
    userSub: "user-1",
    opportunity: candidate(),
  });
  expect(suppressed.relevant).toBe(false);
  expect(suppressed.suppressedReason).toContain("avoided-brands");

  // "One" must not match inside "Someone".
  profile.general.value.avoidedBrands = ["One"];
  await store.saveProfile(profile);
  const kept = await evaluateRelevance({
    store,
    userSub: "user-1",
    opportunity: candidate({ title: "Someone Phone 15" }),
  });
  expect(kept.relevant).toBe(true);
});

test("rejected or purchased products suppress", async () => {
  const store = await freshStore();
  await store.saveProfile(createDefaultProfile("user-1"));
  await store.saveFeedback("user-1", {
    rejected: { productId: "p1", title: "Lenovo Laptop XYZ" },
  });
  const rejected = await evaluateRelevance({
    store,
    userSub: "user-1",
    opportunity: candidate(),
  });
  expect(rejected.relevant).toBe(false);
  expect(rejected.suppressedReason).toContain("rejected");
});

test("preferred brands and merchants boost the score", async () => {
  const store = await freshStore();
  const profile = createDefaultProfile("user-1");
  profile.general.value.preferredBrands = ["Lenovo"];
  profile.general.value.preferredMerchants = ["Amazon India"];
  await store.saveProfile(profile);
  const verdict = await evaluateRelevance({
    store,
    userSub: "user-1",
    opportunity: candidate(),
  });
  expect(verdict.relevant).toBe(true);
  // 50 base + 15 drop + 10 brand + 5 merchant.
  expect(verdict.relevance.score).toBe(80);
  expect(verdict.relevance.reasons).toHaveLength(2);
});

test("budgets reward fit and demote overruns without suppressing", async () => {
  const store = await freshStore();
  const profile = createDefaultProfile("user-1");
  profile.categories.electronics = {
    value: { category: "electronics", budgetInr: { max: 90000 } },
    updatedAt: "2026-02-01T00:00:00.000Z",
    provenance: "explicit",
  };
  await store.saveProfile(profile);
  const fit = await evaluateRelevance({
    store,
    userSub: "user-1",
    opportunity: candidate({ category: "electronics" }),
  });
  expect(fit.relevance.score).toBe(50 + 15 + 5);
  expect(fit.relevance.reasons.join(" ")).toContain("Within");

  const over = await evaluateRelevance({
    store,
    userSub: "user-1",
    opportunity: candidate({
      category: "electronics",
      currentPriceInr: 95000,
    }),
  });
  expect(over.relevant).toBe(true);
  expect(over.relevance.score).toBe(50 + 15 - 10);
  expect(over.relevance.reasons.join(" ")).toContain("above your");
});

test("off-category watches stay visible but rank lower", async () => {
  const store = await freshStore();
  const profile = createDefaultProfile("user-1");
  profile.general.value.categories = ["fashion"];
  await store.saveProfile(profile);
  const verdict = await evaluateRelevance({
    store,
    userSub: "user-1",
    opportunity: candidate({ category: "electronics" }),
  });
  expect(verdict.relevant).toBe(true);
  expect(verdict.relevance.score).toBe(50 + 15 - 5);
});

test("kinds order by importance", async () => {
  const store = await freshStore();
  await store.saveProfile(createDefaultProfile("user-1"));
  const scoreFor = async (kind: NewOpportunity["kind"]) =>
    (
      await evaluateRelevance({
        store,
        userSub: "user-1",
        opportunity: candidate({ kind }),
      })
    ).relevance.score;
  const target = await scoreFor("target-reached");
  const drop = await scoreFor("price-drop");
  const rise = await scoreFor("price-increase");
  expect(target).toBeGreaterThan(drop);
  expect(drop).toBeGreaterThan(rise);
});

test("a fully matching target caps at 100", async () => {
  const store = await freshStore();
  const profile = createDefaultProfile("user-1");
  profile.general.value.preferredBrands = ["Lenovo"];
  profile.general.value.preferredMerchants = ["Amazon India"];
  profile.categories.electronics = {
    value: { category: "electronics", budgetInr: { max: 90000 } },
    updatedAt: "2026-02-01T00:00:00.000Z",
    provenance: "explicit",
  };
  await store.saveProfile(profile);
  const verdict = await evaluateRelevance({
    store,
    userSub: "user-1",
    opportunity: candidate({
      kind: "target-reached",
      category: "electronics",
    }),
  });
  // 50 + 30 + 10 + 5 + 5 = 100.
  expect(verdict.relevance.score).toBe(100);
});
