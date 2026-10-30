import { NextRequest } from "next/server";
import { expect, test } from "vitest";
import { FileMemoryStore } from "../../../../lib/memory/file-store";
import { memoryRequest, setupMemoryEnv, setupTempMemoryDir } from "../test-helpers";
import { GET } from "./route";

setupMemoryEnv();

test("alerts require a signed-in user", async () => {
  await setupTempMemoryDir();
  expect(
    (await GET(new NextRequest("http://localhost/api/memory/alerts"))).status,
  ).toBe(401);
});

test("alerts list newest-first with an unread filter", async () => {
  await setupTempMemoryDir();
  const store = new FileMemoryStore();
  const first = await store.saveAlert("user-1", {
    watchId: "w1",
    productId: "p1",
    title: "A",
    merchant: "M",
    url: "https://www.amazon.in/dp/B0TEST1",
    observedPrice: 100,
    targetPrice: 200,
    observedAt: new Date().toISOString(),
  });
  await store.saveAlert("user-1", {
    watchId: "w1",
    productId: "p1",
    title: "A",
    merchant: "M",
    url: "https://www.amazon.in/dp/B0TEST1",
    observedPrice: 90,
    targetPrice: 200,
    observedAt: new Date().toISOString(),
  });
  await store.markAlertsRead("user-1", [first.id]);
  const url = "http://localhost/api/memory/alerts";
  const all = (await (await GET(memoryRequest(url))).json()) as {
    alerts: Array<{ observedPrice: number }>;
  };
  expect(all.alerts.map((a) => a.observedPrice)).toEqual([90, 100]);
  const unread = (await (
    await GET(memoryRequest(`${url}?unread=1`))
  ).json()) as { alerts: unknown[] };
  expect(unread.alerts).toHaveLength(1);
});
