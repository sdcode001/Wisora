import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { FileMemoryStore } from "../memory/file-store";
import { createDefaultProfile } from "../memory/profile";
import type { LlmProvider } from "../llm/provider";
import { buildChatContext } from "./context";
import { respondToChat } from "./service";

const NOW = new Date("2026-02-10T12:00:00.000Z").getTime();
const at = (daysAgo: number) =>
  new Date(NOW - daysAgo * 24 * 3600000).toISOString();

async function freshStore(): Promise<FileMemoryStore> {
  return new FileMemoryStore(await mkdtemp(path.join(tmpdir(), "wisora-chat-")));
}

async function seed(store: FileMemoryStore): Promise<void> {
  const profile = createDefaultProfile("user-1");
  profile.general.value.preferredBrands = ["Lenovo"];
  profile.categories.electronics = {
    value: { category: "electronics", budgetInr: { max: 90000 } },
    updatedAt: at(10),
    provenance: "explicit",
  };
  await store.saveProfile(profile);
  await store.saveWatch("user-1", {
    productId: "p1",
    url: "https://www.amazon.in/dp/B0TEST1",
    title: "Lenovo ThinkPad E14",
    merchant: "Amazon India",
    targetPrice: 85000,
    currency: "INR",
    active: true,
    canWait: true,
  });
  await store.recordObservation({
    productId: "p1",
    url: "https://www.amazon.in/dp/B0TEST1",
    title: "Lenovo ThinkPad E14",
    merchant: "Amazon India",
    sourceId: "amazon-in",
    priceInr: 89999,
    currency: "INR",
    evidence: "repeated",
    candidates: 2,
    observedAt: at(2),
    source: "search",
  });
  await store.recordObservation({
    productId: "p1",
    url: "https://www.amazon.in/dp/B0TEST1",
    title: "Lenovo ThinkPad E14",
    merchant: "Amazon India",
    sourceId: "amazon-in",
    priceInr: 84999,
    currency: "INR",
    evidence: "repeated",
    candidates: 2,
    observedAt: at(0),
    source: "watch-check",
  });
  await store.saveDecision("user-1", {
    query: "laptop under 90000",
    category: "electronics",
    topPick: {
      productId: "p1",
      title: "Lenovo ThinkPad E14",
      merchant: "Amazon India",
      priceInr: 89999,
    },
    verdict: "BUY",
  });
}

function stubProvider(answer: string): LlmProvider {
  return {
    name: "stub",
    available: true,
    extractIntent: () => Promise.reject(new Error("unused")),
    explainVerdict: () => Promise.reject(new Error("unused")),
    extractRequirements: () => Promise.reject(new Error("unused")),
    extractReviewThemes: () => Promise.reject(new Error("unused")),
    answerGrounded: () => Promise.resolve({ answer, usedContext: true }),
  };
}

test("context gathers watches, history, decisions, and preferences", async () => {
  const store = await freshStore();
  await seed(store);
  const context = await buildChatContext({
    store,
    userSub: "user-1",
    nowMs: NOW,
  });
  expect(context.products).toHaveLength(1);
  expect(context.products[0]).toMatchObject({
    productId: "p1",
    targetPriceInr: 85000,
    decisionVerdict: "BUY",
  });
  expect(context.products[0]?.latest?.priceInr).toBe(84999);
  expect(context.text).toContain("likes brands: Lenovo");
  expect(context.text).toContain("electronics ≤ ₹90,000");
  expect(context.text.length).toBeLessThanOrEqual(6000);
});

test("rules answer first with no model cost", async () => {
  const store = await freshStore();
  await seed(store);
  let llmCalls = 0;
  const provider = stubProvider("model answer");
  const counting: LlmProvider = {
    ...provider,
    answerGrounded: (...args) => {
      llmCalls += 1;
      return provider.answerGrounded(...args);
    },
  };
  const result = await respondToChat({
    store,
    userSub: "user-1",
    message: "Is the ThinkPad still a good deal?",
    provider: counting,
    nowMs: NOW,
  });
  expect(result.reply.source).toBe("rules");
  expect(result.reply.text).toContain("₹84,999");
  expect(llmCalls).toBe(0);
  expect(result.thread.messages).toHaveLength(2);
  expect(result.thread.messages[1]?.sources).toHaveLength(1);
});

test("unmatched questions reach the model, then persist the thread", async () => {
  const store = await freshStore();
  await seed(store);
  const first = await respondToChat({
    store,
    userSub: "user-1",
    message: "What should I know about EMI options?",
    provider: stubProvider("EMI splits cost across months."),
    nowMs: NOW,
  });
  expect(first.reply).toMatchObject({
    text: "EMI splits cost across months.",
    source: "llm",
  });
  const second = await respondToChat({
    store,
    userSub: "user-1",
    threadId: first.thread.id,
    message: "And what about warranties?",
    provider: stubProvider("Warranty answer."),
    nowMs: NOW,
  });
  expect(second.thread.id).toBe(first.thread.id);
  expect(second.thread.messages).toHaveLength(4);
});

test("model failures and missing providers degrade honestly", async () => {
  const store = await freshStore();
  await seed(store);
  const failing: LlmProvider = {
    ...stubProvider("unused"),
    answerGrounded: () => Promise.reject(new Error("boom")),
  };
  const failed = await respondToChat({
    store,
    userSub: "user-1",
    message: "What should I know about EMI options?",
    provider: failing,
    nowMs: NOW,
  });
  expect(failed.reply.source).toBe("offline");
  const missing = await respondToChat({
    store,
    userSub: "user-1",
    message: "What should I know about EMI options?",
    provider: null,
    nowMs: NOW,
  });
  expect(missing.reply.source).toBe("offline");
  expect(missing.reply.text).toContain("offline");
});

test("long listing titles persist without throwing", async () => {
  const store = await freshStore();
  const longTitle = `${"Very long product title ".repeat(12)}X`;
  await store.saveWatch("user-1", {
    productId: "px",
    url: "https://www.amazon.in/dp/B0LONG",
    title: longTitle,
    merchant: "Amazon India",
    targetPrice: 25000,
    currency: "INR",
    active: true,
    canWait: true,
  });
  await store.recordObservation({
    productId: "px",
    url: "https://www.amazon.in/dp/B0LONG",
    title: longTitle,
    merchant: "Amazon India",
    sourceId: "amazon-in",
    priceInr: 24000,
    currency: "INR",
    evidence: "single",
    candidates: 1,
    observedAt: at(0),
    source: "search",
  });
  const result = await respondToChat({
    store,
    userSub: "user-1",
    message: "What is the price?",
    productId: "px",
    provider: null,
    nowMs: NOW,
  });
  expect(result.reply.source).toBe("rules");
  expect(result.thread.messages).toHaveLength(2);
});

test("product hints resolve read-card products missing from context", async () => {
  const store = await freshStore();
  await store.recordObservation({
    productId: "px",
    url: "https://www.amazon.in/dp/B0X",
    title: "Sony Headphones ZX",
    merchant: "Amazon India",
    sourceId: "amazon-in",
    priceInr: 12000,
    currency: "INR",
    evidence: "single",
    candidates: 1,
    observedAt: at(0),
    source: "search",
  });
  const result = await respondToChat({
    store,
    userSub: "user-1",
    message: "What is the price?",
    productId: "px",
    provider: null,
    nowMs: NOW,
  });
  expect(result.reply.source).toBe("rules");
  expect(result.reply.text).toContain("₹12,000");
});
