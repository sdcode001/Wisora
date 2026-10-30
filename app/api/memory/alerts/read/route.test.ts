import { NextRequest } from "next/server";
import { expect, test } from "vitest";
import { FileMemoryStore } from "../../../../../lib/memory/file-store";
import { memoryRequest, setupMemoryEnv, setupTempMemoryDir } from "../../test-helpers";
import { POST } from "./route";

setupMemoryEnv();

const URL = "http://localhost/api/memory/alerts/read";

async function seedAlert(): Promise<string> {
  await setupTempMemoryDir();
  const store = new FileMemoryStore();
  const alert = await store.saveAlert("user-1", {
    watchId: "w1",
    productId: "p1",
    title: "A",
    merchant: "M",
    url: "https://www.amazon.in/dp/B0TEST1",
    observedPrice: 100,
    targetPrice: 200,
    observedAt: new Date().toISOString(),
  });
  return alert.id;
}

test("marking read requires a signed-in user and a valid body", async () => {
  await setupTempMemoryDir();
  expect((await POST(new NextRequest(URL, { method: "POST" }))).status).toBe(
    401,
  );
  const bad = await POST(memoryRequest(URL, { body: {} }));
  expect(bad.status).toBe(400);
});

test("alerts mark read by id or all", async () => {
  const id = await seedAlert();
  const one = await POST(memoryRequest(URL, { body: { ids: [id] } }));
  expect(await one.json()).toEqual({ marked: 1 });
  const none = await POST(memoryRequest(URL, { body: { all: true } }));
  expect(await none.json()).toEqual({ marked: 0 });
});
