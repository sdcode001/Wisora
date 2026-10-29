import { NextRequest } from "next/server";
import { expect, test } from "vitest";
import {
  memoryRequest,
  setupMemoryEnv,
  setupTempMemoryDir,
} from "../../test-helpers";
import { DELETE, GET, POST } from "./route";

setupMemoryEnv();

const COMPARISON = {
  category: "electronics",
  query: "laptop under 90000",
  products: [
    { productId: "p1", title: "A", merchant: "Amazon India", priceInr: 80000 },
    { productId: "p2", title: "B", merchant: "Flipkart", priceInr: 85000 },
  ],
};

test("saved comparisons require a signed-in user", async () => {
  await setupTempMemoryDir();
  const url = "http://localhost/api/memory/saved/comparisons";
  expect((await GET(new NextRequest(url))).status).toBe(401);
  expect(
    (await POST(new NextRequest(url, { method: "POST" }))).status,
  ).toBe(401);
  expect(
    (await DELETE(new NextRequest(url, { method: "DELETE" }))).status,
  ).toBe(401);
});

test("saved comparisons save and delete by id", async () => {
  await setupTempMemoryDir();
  const url = "http://localhost/api/memory/saved/comparisons";
  const saved = (await (
    await POST(memoryRequest(url, { body: COMPARISON }))
  ).json()) as { comparison: { id: string } };
  const listed = (await (await GET(memoryRequest(url))).json()) as {
    comparisons: unknown[];
  };
  expect(listed.comparisons).toHaveLength(1);
  const removed = await DELETE(
    memoryRequest(`${url}?id=${saved.comparison.id}`, { method: "DELETE" }),
  );
  expect(await removed.json()).toEqual({ deleted: true });
});

test("comparisons need two to six products", async () => {
  await setupTempMemoryDir();
  const url = "http://localhost/api/memory/saved/comparisons";
  const response = await POST(
    memoryRequest(url, {
      body: { ...COMPARISON, products: COMPARISON.products.slice(0, 1) },
    }),
  );
  expect(response.status).toBe(400);
  expect((await response.json()).code).toBe("invalid-comparison");
});
