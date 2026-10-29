import { NextRequest } from "next/server";
import { expect, test } from "vitest";
import { memoryRequest, setupMemoryEnv, setupTempMemoryDir } from "../test-helpers";
import { GET, POST } from "./route";

setupMemoryEnv();

const DECISION = {
  query: "laptop for coding",
  category: "electronics",
  budgetInr: { max: 90000 },
  topPick: {
    productId: "p1",
    title: "Test Laptop",
    merchant: "Amazon India",
    priceInr: 85000,
  },
  verdict: "BUY",
};

test("decisions require a signed-in user", async () => {
  await setupTempMemoryDir();
  const url = "http://localhost/api/memory/decisions";
  expect((await GET(new NextRequest(url))).status).toBe(401);
  expect(
    (await POST(new NextRequest(url, { method: "POST" }))).status,
  ).toBe(401);
});

test("decisions save and list newest-first", async () => {
  await setupTempMemoryDir();
  const url = "http://localhost/api/memory/decisions";
  const empty = await GET(memoryRequest(url));
  expect(await empty.json()).toEqual({ decisions: [] });
  const first = await POST(memoryRequest(url, { body: DECISION }));
  expect(first.status).toBe(200);
  expect((await first.json()).decision.query).toBe("laptop for coding");
  await POST(
    memoryRequest(url, { body: { ...DECISION, query: "second query" } }),
  );
  const listed = (await (await GET(memoryRequest(url))).json()) as {
    decisions: Array<{ query: string }>;
  };
  expect(listed.decisions.map((d) => d.query)).toEqual([
    "second query",
    "laptop for coding",
  ]);
  const limited = (await (
    await GET(memoryRequest(`${url}?limit=1`))
  ).json()) as { decisions: unknown[] };
  expect(limited.decisions).toHaveLength(1);
});

test("invalid decisions are rejected", async () => {
  await setupTempMemoryDir();
  const url = "http://localhost/api/memory/decisions";
  const response = await POST(memoryRequest(url, { body: { query: "x" } }));
  expect(response.status).toBe(400);
  expect((await response.json()).code).toBe("invalid-decision");
});
