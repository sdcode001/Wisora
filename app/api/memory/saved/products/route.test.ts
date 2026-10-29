import { NextRequest } from "next/server";
import { expect, test } from "vitest";
import {
  memoryRequest,
  setupMemoryEnv,
  setupTempMemoryDir,
} from "../../test-helpers";
import { DELETE, GET, POST } from "./route";

setupMemoryEnv();

const PRODUCT = {
  productId: "p1",
  title: "Sony X",
  url: "https://www.amazon.in/dp/B0TEST1",
  merchant: "Amazon India",
  priceInr: 20000,
};

test("saved products require a signed-in user", async () => {
  await setupTempMemoryDir();
  const url = "http://localhost/api/memory/saved/products";
  expect((await GET(new NextRequest(url))).status).toBe(401);
  expect(
    (await POST(new NextRequest(url, { method: "POST" }))).status,
  ).toBe(401);
  expect(
    (await DELETE(new NextRequest(url, { method: "DELETE" }))).status,
  ).toBe(401);
});

test("saved products upsert and delete", async () => {
  await setupTempMemoryDir();
  const url = "http://localhost/api/memory/saved/products";
  await POST(memoryRequest(url, { body: PRODUCT }));
  await POST(memoryRequest(url, { body: { ...PRODUCT, note: "gift" } }));
  const listed = (await (await GET(memoryRequest(url))).json()) as {
    products: Array<{ productId: string; note?: string }>;
  };
  expect(listed.products).toHaveLength(1);
  expect(listed.products[0]?.note).toBe("gift");
  const missing = await DELETE(
    memoryRequest(`${url}?productId=nope`, { method: "DELETE" }),
  );
  expect(await missing.json()).toEqual({ deleted: false });
  const removed = await DELETE(
    memoryRequest(`${url}?productId=p1`, { method: "DELETE" }),
  );
  expect(await removed.json()).toEqual({ deleted: true });
  const empty = (await (await GET(memoryRequest(url))).json()) as {
    products: unknown[];
  };
  expect(empty.products).toEqual([]);
});

test("saved products validate input and delete params", async () => {
  await setupTempMemoryDir();
  const url = "http://localhost/api/memory/saved/products";
  const badSave = await POST(
    memoryRequest(url, { body: { ...PRODUCT, url: "nope" } }),
  );
  expect(badSave.status).toBe(400);
  expect((await badSave.json()).code).toBe("invalid-saved-product");
  const noParam = await DELETE(memoryRequest(url, { method: "DELETE" }));
  expect(noParam.status).toBe(400);
  expect((await noParam.json()).code).toBe("missing-id");
});
