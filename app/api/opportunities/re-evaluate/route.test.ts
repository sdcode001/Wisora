import { NextRequest } from "next/server";
import { afterEach, expect, test } from "vitest";
import { FileMemoryStore } from "../../../../lib/memory/file-store";
import {
  MEMORY_TEST_USER,
  memoryRequest,
  setupMemoryEnv,
  setupTempMemoryDir,
} from "../../memory/test-helpers";
import { POST } from "./route";

setupMemoryEnv();

const SAVED_TAVILY = process.env.TAVILY_API_KEY;

afterEach(() => {
  if (SAVED_TAVILY === undefined) {
    delete process.env.TAVILY_API_KEY;
  } else {
    process.env.TAVILY_API_KEY = SAVED_TAVILY;
  }
});

test("re-evaluate guards auth, body, key, and unknown cards", async () => {
  await setupTempMemoryDir();
  const url = "http://localhost/api/opportunities/re-evaluate";
  expect((await POST(new NextRequest(url, { method: "POST" }))).status).toBe(
    401,
  );
  expect((await POST(memoryRequest(url, { body: {} }))).status).toBe(400);
  delete process.env.TAVILY_API_KEY;
  expect(
    (await POST(memoryRequest(url, { body: { id: "x" } }))).status,
  ).toBe(503);

  process.env.TAVILY_API_KEY = "test-key";
  expect(
    (await POST(memoryRequest(url, { body: { id: "missing" } }))).status,
  ).toBe(404);

  const store = new FileMemoryStore();
  const watchless = await store.saveOpportunity(MEMORY_TEST_USER.sub, {
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
      source: "search",
      observedAt: "2026-02-10T12:00:00.000Z",
    },
  });
  const response = await POST(
    memoryRequest(url, { body: { id: watchless.id } }),
  );
  expect(response.status).toBe(400);
  expect(((await response.json()) as { code: string }).code).toBe("no-watch");
});
