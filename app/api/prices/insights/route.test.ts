import { NextRequest } from "next/server";
import { expect, test } from "vitest";
import { FileMemoryStore } from "../../../../lib/memory/file-store";
import { memoryRequest, setupMemoryEnv, setupTempMemoryDir } from "../../memory/test-helpers";
import { GET } from "./route";

setupMemoryEnv();

test("insights require a signed-in user and valid ids", async () => {
  await setupTempMemoryDir();
  const url = "http://localhost/api/prices/insights";
  expect((await GET(new NextRequest(`${url}?ids=abc`))).status).toBe(401);
  const empty = await GET(memoryRequest(url));
  expect(empty.status).toBe(400);
  const evil = await GET(memoryRequest(`${url}?ids=../x`));
  expect(evil.status).toBe(400);
});

test("insights return latest, stats, and recent per product", async () => {
  await setupTempMemoryDir();
  const store = new FileMemoryStore();
  const at = (daysAgo: number) =>
    new Date(Date.now() - daysAgo * 86400000).toISOString();
  await store.recordObservation({
    productId: "abc123",
    url: "https://www.amazon.in/dp/B0TEST1",
    title: "T",
    merchant: "M",
    sourceId: "amazon-in",
    priceInr: 45000,
    currency: "INR",
    evidence: "repeated",
    candidates: 2,
    observedAt: at(1),
    source: "search",
  });
  await store.recordObservation({
    productId: "abc123",
    url: "https://www.amazon.in/dp/B0TEST1",
    title: "T",
    merchant: "M",
    sourceId: "amazon-in",
    priceInr: 43000,
    currency: "INR",
    evidence: "repeated",
    candidates: 2,
    observedAt: at(0),
    source: "watch-check",
  });
  const response = await GET(
    memoryRequest("http://localhost/api/prices/insights?ids=abc123,missing"),
  );
  const body = (await response.json()) as {
    insights: Record<
      string,
      {
        latest: { priceInr: number } | null;
        stats: { count: number; averageInr: number | null };
        recent: unknown[];
      }
    >;
  };
  expect(body.insights["abc123"]?.latest?.priceInr).toBe(43000);
  expect(body.insights["abc123"]?.stats.count).toBe(2);
  expect(body.insights["abc123"]?.recent).toHaveLength(2);
  expect(body.insights["missing"]?.latest).toBeNull();
  expect(body.insights["missing"]?.stats.count).toBe(0);
});
