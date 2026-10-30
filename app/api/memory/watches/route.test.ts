import { NextRequest } from "next/server";
import { afterEach, expect, test } from "vitest";
import { FileMemoryStore } from "../../../../lib/memory/file-store";
import {
  MEMORY_TEST_USER,
  memoryRequest,
  setupMemoryEnv,
  setupTempMemoryDir,
} from "../test-helpers";
import { DELETE, GET, POST, PUT } from "./route";

setupMemoryEnv();

const SAVED_TAVILY = process.env.TAVILY_API_KEY;
const SAVED_RESEND = process.env.RESEND_API_KEY;
const SAVED_RESEND_FROM = process.env.RESEND_FROM;

afterEach(() => {
  if (SAVED_TAVILY === undefined) delete process.env.TAVILY_API_KEY;
  else process.env.TAVILY_API_KEY = SAVED_TAVILY;
  if (SAVED_RESEND === undefined) delete process.env.RESEND_API_KEY;
  else process.env.RESEND_API_KEY = SAVED_RESEND;
  if (SAVED_RESEND_FROM === undefined) delete process.env.RESEND_FROM;
  else process.env.RESEND_FROM = SAVED_RESEND_FROM;
});

const WATCH = {
  productId: "abc123",
  url: "https://www.amazon.in/dp/B0TEST1",
  title: "Test Laptop",
  merchant: "Amazon India",
  targetPrice: 40000,
};

test("watches require a signed-in user", async () => {
  await setupTempMemoryDir();
  const url = "http://localhost/api/memory/watches";
  expect((await GET(new NextRequest(url))).status).toBe(401);
  expect((await POST(new NextRequest(url, { method: "POST" }))).status).toBe(
    401,
  );
  expect((await PUT(new NextRequest(url, { method: "PUT" }))).status).toBe(
    401,
  );
  expect(
    (await DELETE(new NextRequest(url, { method: "DELETE" }))).status,
  ).toBe(401);
});

test("creating a watch snapshots the session email and evaluates at once", async () => {
  await setupTempMemoryDir();
  delete process.env.RESEND_API_KEY;
  delete process.env.RESEND_FROM;
  const store = new FileMemoryStore();
  await store.recordObservation({
    productId: "abc123",
    url: WATCH.url,
    title: WATCH.title,
    merchant: WATCH.merchant,
    sourceId: "amazon-in",
    priceInr: 39000,
    currency: "INR",
    evidence: "repeated",
    candidates: 2,
    observedAt: new Date().toISOString(),
    source: "search",
  });
  const url = "http://localhost/api/memory/watches";
  const response = await POST(memoryRequest(url, { body: WATCH }));
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    watch: { id: string; notifyEmail: string };
    alert: { observedPrice: number; email: object } | null;
    realismWarning: string | null;
  };
  expect(body.watch.notifyEmail).toBe(MEMORY_TEST_USER.email);
  expect(body.alert?.observedPrice).toBe(39000);
  expect(body.alert?.email).toMatchObject({
    attempted: true,
    sent: false,
  });
  expect(body.realismWarning).toBeNull();
});

test("unrealistic targets get a warning, never an adjustment", async () => {
  await setupTempMemoryDir();
  delete process.env.RESEND_API_KEY;
  const store = new FileMemoryStore();
  const now = Date.now();
  for (const [price, daysAgo] of [
    [45000, 1],
    [50000, 10],
  ] as const) {
    await store.recordObservation({
      productId: "abc123",
      url: WATCH.url,
      title: WATCH.title,
      merchant: WATCH.merchant,
      sourceId: "amazon-in",
      priceInr: price,
      currency: "INR",
      evidence: "repeated",
      candidates: 2,
      observedAt: new Date(now - daysAgo * 86400000).toISOString(),
      source: "search",
    });
  }
  const response = await POST(
    memoryRequest("http://localhost/api/memory/watches", {
      body: { ...WATCH, targetPrice: 30000 },
    }),
  );
  const body = (await response.json()) as {
    watch: { targetPrice: number };
    alert: null;
    realismWarning: string;
  };
  expect(body.watch.targetPrice).toBe(30000);
  expect(body.alert).toBeNull();
  expect(body.realismWarning).toContain("never observed below");
});

test("invalid and duplicate watches fail cleanly", async () => {
  await setupTempMemoryDir();
  const url = "http://localhost/api/memory/watches";
  const bad = await POST(memoryRequest(url, { body: { title: "x" } }));
  expect(bad.status).toBe(400);
  expect((await bad.json()).code).toBe("invalid-watch");
  expect((await POST(memoryRequest(url, { body: WATCH }))).status).toBe(200);
  const dup = await POST(memoryRequest(url, { body: WATCH }));
  expect(dup.status).toBe(409);
  expect((await dup.json()).code).toBe("duplicate-watch");
});

test("watches update, enrich on list, and delete", async () => {
  await setupTempMemoryDir();
  const url = "http://localhost/api/memory/watches";
  const created = (await (
    await POST(memoryRequest(url, { body: WATCH }))
  ).json()) as { watch: { id: string } };
  const updated = await PUT(
    memoryRequest(url, {
      body: { id: created.watch.id, active: false, targetPrice: 35000 },
    }),
  );
  expect(updated.status).toBe(200);
  expect((await updated.json()).watch).toMatchObject({
    active: false,
    targetPrice: 35000,
  });
  const unknown = await PUT(
    memoryRequest(url, { body: { id: "missing", active: true } }),
  );
  expect(unknown.status).toBe(404);
  const listed = (await (await GET(memoryRequest(url))).json()) as {
    watches: Array<{
      watch: { id: string };
      latest: unknown;
      stats: { count: number };
      recent: unknown[];
      unreadAlerts: number;
    }>;
  };
  expect(listed.watches).toHaveLength(1);
  expect(listed.watches[0]?.stats.count).toBe(0);
  const removed = await DELETE(
    memoryRequest(`${url}?id=${created.watch.id}`, { method: "DELETE" }),
  );
  expect(await removed.json()).toEqual({ deleted: true });
});
