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

test("dismiss validates, 404s, and dismisses", async () => {
  await setupTempMemoryDir();
  const url = "http://localhost/api/opportunities/dismiss";
  expect((await POST(new NextRequest(url, { method: "POST" }))).status).toBe(
    401,
  );
  expect((await POST(memoryRequest(url, { body: {} }))).status).toBe(
    400,
  );
  expect(
    (await POST(memoryRequest(url, { body: { id: "missing" } }))).status,
  ).toBe(404);

  const store = new FileMemoryStore();
  const saved = await store.saveOpportunity(MEMORY_TEST_USER.sub, {
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
  const body = (await (
    await POST(memoryRequest(url, { body: { id: saved.id } }))
  ).json()) as { opportunity: { status: string } };
  expect(body.opportunity.status).toBe("dismissed");
});
