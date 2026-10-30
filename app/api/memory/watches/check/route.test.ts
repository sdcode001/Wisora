import { NextRequest } from "next/server";
import { afterEach, expect, test, vi } from "vitest";
import { FileMemoryStore } from "../../../../../lib/memory/file-store";
import { tavilyExtract } from "../../../../../lib/tavily/client";
import { memoryRequest, setupMemoryEnv, setupTempMemoryDir } from "../../test-helpers";
import { POST } from "./route";

vi.mock("../../../../../lib/tavily/client", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../../../../../lib/tavily/client")>();
  return { ...original, tavilyExtract: vi.fn() };
});

const mockExtract = vi.mocked(tavilyExtract);

setupMemoryEnv();

const SAVED_TAVILY = process.env.TAVILY_API_KEY;
const SAVED_RESEND = process.env.RESEND_API_KEY;
const SAVED_RESEND_FROM = process.env.RESEND_FROM;

afterEach(() => {
  vi.clearAllMocks();
  if (SAVED_TAVILY === undefined) delete process.env.TAVILY_API_KEY;
  else process.env.TAVILY_API_KEY = SAVED_TAVILY;
  if (SAVED_RESEND === undefined) delete process.env.RESEND_API_KEY;
  else process.env.RESEND_API_KEY = SAVED_RESEND;
  if (SAVED_RESEND_FROM === undefined) delete process.env.RESEND_FROM;
  else process.env.RESEND_FROM = SAVED_RESEND_FROM;
});

const URL = "http://localhost/api/memory/watches/check";

async function seedWatch(targetPrice: number): Promise<string> {
  await setupTempMemoryDir();
  process.env.TAVILY_API_KEY = "test-key";
  delete process.env.RESEND_API_KEY;
  delete process.env.RESEND_FROM;
  const store = new FileMemoryStore();
  const watch = await store.saveWatch("user-1", {
    productId: "abc123",
    url: "https://www.amazon.in/dp/B0TEST1",
    title: "Test Laptop",
    merchant: "Amazon India",
    targetPrice,
    currency: "INR",
    active: true,
    canWait: true,
  });
  return watch.id;
}

test("manual checks require auth, a key, and a known watch", async () => {
  await setupTempMemoryDir();
  expect((await POST(new NextRequest(URL, { method: "POST" }))).status).toBe(
    401,
  );
  process.env.TAVILY_API_KEY = "test-key";
  const badBody = await POST(memoryRequest(URL, { body: {} }));
  expect(badBody.status).toBe(400);
  const unknown = await POST(memoryRequest(URL, { body: { id: "nope" } }));
  expect(unknown.status).toBe(404);
  delete process.env.TAVILY_API_KEY;
  await setupTempMemoryDir();
  const id = await seedWatch(40000);
  delete process.env.TAVILY_API_KEY;
  const noKey = await POST(memoryRequest(URL, { body: { id } }));
  expect(noKey.status).toBe(503);
  expect((await noKey.json()).code).toBe("missing-tavily-key");
});

test("a manual check records, updates, and alerts", async () => {
  const id = await seedWatch(40000);
  mockExtract.mockResolvedValue([
    {
      url: "https://www.amazon.in/dp/B0TEST1",
      text: "Test Laptop deal ₹39,000 only today. Price ₹39,000.",
      images: [],
    },
  ]);
  const response = await POST(memoryRequest(URL, { body: { id } }));
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    status: string;
    observation: { priceInr: number };
    recorded: boolean;
    alert: { observedPrice: number } | null;
    watch: { lastCheck: { status: string } };
  };
  expect(body.status).toBe("ok");
  expect(body.observation.priceInr).toBe(39000);
  expect(body.recorded).toBe(true);
  expect(body.alert?.observedPrice).toBe(39000);
  expect(body.watch.lastCheck.status).toBe("ok");
  expect(mockExtract).toHaveBeenCalledTimes(1);
});

test("check failures return honest statuses, not HTTP errors", async () => {
  const id = await seedWatch(40000);
  mockExtract.mockResolvedValue([]);
  const failed = await POST(memoryRequest(URL, { body: { id } }));
  expect(failed.status).toBe(200);
  expect((await failed.json()).status).toBe("fetch-failed");
  mockExtract.mockResolvedValue([
    {
      url: "https://www.amazon.in/dp/B0TEST1",
      text: "Sorry, this item is currently unavailable.",
      images: [],
    },
  ]);
  const gone = await POST(memoryRequest(URL, { body: { id } }));
  expect((await gone.json()).status).toBe("unavailable");
});
