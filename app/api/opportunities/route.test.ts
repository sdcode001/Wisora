import { NextRequest } from "next/server";
import { expect, test } from "vitest";
import { FileMemoryStore } from "../../../lib/memory/file-store";
import type { NewOpportunity } from "../../../lib/opportunities/schema";
import {
  MEMORY_TEST_USER,
  memoryRequest,
  setupMemoryEnv,
  setupTempMemoryDir,
} from "../memory/test-helpers";
import { GET } from "./route";

setupMemoryEnv();

let dedupeCounter = 0;

function candidate(overrides: Partial<NewOpportunity> = {}): NewOpportunity {
  dedupeCounter += 1;
  return {
    kind: "price-drop",
    dedupeKey: `price-drop:p1:${dedupeCounter}`,
    productId: "p1",
    title: "Test Laptop",
    merchant: "Amazon India",
    url: "https://www.amazon.in/dp/B0TEST1",
    currentPriceInr: 84000,
    previousPriceInr: 90000,
    targetPriceInr: 85000,
    reason: "Dropped.",
    relevance: { score: 60, reasons: [] },
    evidence: {
      source: "watch-check",
      observedAt: "2026-02-10T12:00:00.000Z",
    },
    ...overrides,
  };
}

test("opportunities require a signed-in user", async () => {
  await setupTempMemoryDir();
  expect(
    (await GET(new NextRequest("http://localhost/api/opportunities"))).status,
  ).toBe(401);
});

test("feed filters by status, kind, and category", async () => {
  await setupTempMemoryDir();
  const store = new FileMemoryStore();
  const first = await store.saveOpportunity(
    MEMORY_TEST_USER.sub,
    candidate({ category: "electronics" }),
  );
  await store.saveOpportunity(
    MEMORY_TEST_USER.sub,
    candidate({
      kind: "price-increase",
      dedupeKey: "price-increase:p1:95000",
      category: "fashion",
    }),
  );
  await store.updateOpportunityStatus(
    MEMORY_TEST_USER.sub,
    first.id,
    "dismissed",
  );

  const active = (await (
    await GET(memoryRequest("http://localhost/api/opportunities"))
  ).json()) as { opportunities: Array<{ id: string }> };
  expect(active.opportunities).toHaveLength(1);

  const dismissed = (await (
    await GET(
      memoryRequest("http://localhost/api/opportunities?status=dismissed"),
    )
  ).json()) as { opportunities: Array<{ id: string }> };
  expect(dismissed.opportunities.map((o) => o.id)).toEqual([first.id]);

  const fashion = (await (
    await GET(
      memoryRequest(
        "http://localhost/api/opportunities?status=all&category=fashion",
      ),
    )
  ).json()) as { opportunities: Array<{ id: string }> };
  expect(fashion.opportunities).toHaveLength(1);

  const bad = await GET(
    memoryRequest("http://localhost/api/opportunities?status=nope"),
  );
  expect(bad.status).toBe(400);
});

test("feed sorts by relevance score, then recency", async () => {
  await setupTempMemoryDir();
  const store = new FileMemoryStore();
  await store.saveOpportunity(
    MEMORY_TEST_USER.sub,
    candidate({
      dedupeKey: "price-drop:p1:1",
      relevance: { score: 10, reasons: [] },
    }),
  );
  const top = await store.saveOpportunity(
    MEMORY_TEST_USER.sub,
    candidate({
      dedupeKey: "price-drop:p1:2",
      relevance: { score: 90, reasons: [] },
    }),
  );
  const body = (await (
    await GET(memoryRequest("http://localhost/api/opportunities"))
  ).json()) as { opportunities: Array<{ id: string }> };
  expect(body.opportunities.map((o) => o.id)[0]).toBe(top.id);
});

test("users only see their own opportunities", async () => {
  await setupTempMemoryDir();
  const store = new FileMemoryStore();
  await store.saveOpportunity("someone-else", candidate());
  const body = (await (
    await GET(memoryRequest("http://localhost/api/opportunities"))
  ).json()) as { opportunities: unknown[] };
  expect(body.opportunities).toEqual([]);
});
