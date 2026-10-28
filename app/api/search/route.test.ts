import { expect, test } from "vitest";
import { POST } from "./route";

delete process.env.META_API_KEY;
delete process.env.TAVILY_API_KEY;

const req = (body: unknown): Request =>
  new Request("http://localhost/api/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const ALL_DISABLED = {
  "amazon-in": true,
  flipkart: true,
  shopclues: true,
  snapdeal: true,
  myntra: true,
  ajio: true,
  "tata-cliq": true,
  "nykaa-fashion": true,
};

test("rejects invalid bodies", async () => {
  const response = await POST(req({}));
  expect(response.status).toBe(400);
});

test("all sources disabled means no-sources, not a search", async () => {
  const response = await POST(req({ query: "laptop", disabled: ALL_DISABLED }));
  expect(response.status).toBe(400);
  const body = (await response.json()) as { code: string };
  expect(body.code).toBe("no-sources");
});

test("partial disable keeps other sources enabled", async () => {
  const response = await POST(
    req({ query: "laptop", disabled: { "amazon-in": true } }),
  );
  expect(response.status).toBe(503);
  const body = (await response.json()) as { code: string };
  expect(body.code).toBe("missing-tavily-key");
});
