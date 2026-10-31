import { NextRequest } from "next/server";
import { expect, test } from "vitest";
import { FileMemoryStore } from "../../../../lib/memory/file-store";
import {
  MEMORY_TEST_USER,
  memoryRequest,
  setupMemoryEnv,
  setupTempMemoryDir,
} from "../../memory/test-helpers";
import { POST } from "./route";

setupMemoryEnv();

async function seed(): Promise<FileMemoryStore> {
  const store = new FileMemoryStore();
  await store.saveOpportunity(MEMORY_TEST_USER.sub, {
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
  return store;
}

test("read requires a signed-in user and a valid body", async () => {
  await setupTempMemoryDir();
  const url = "http://localhost/api/opportunities/read";
  expect((await POST(new NextRequest(url, { method: "POST" }))).status).toBe(
    401,
  );
  expect(
    (await POST(memoryRequest(url, { body: { ids: [42] } }))).status,
  ).toBe(400);
});

test("read flips active cards only", async () => {
  await setupTempMemoryDir();
  const store = await seed();
  const [entry] = await store.listOpportunities(MEMORY_TEST_USER.sub);
  const body = (await (
    await POST(
      memoryRequest("http://localhost/api/opportunities/read", {
        body: { ids: [entry?.id, "missing"] },
      }),
    )
  ).json()) as { updated: number };
  expect(body.updated).toBe(1);
  const again = (await (
    await POST(
      memoryRequest("http://localhost/api/opportunities/read", {
        body: { ids: "all" },
      }),
    )
  ).json()) as { updated: number };
  expect(again.updated).toBe(0);
});
