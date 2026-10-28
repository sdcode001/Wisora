import { expect, test } from "vitest";
import { POST } from "./route";

delete process.env.META_API_KEY;
delete process.env.TAVILY_API_KEY;

const req = (body: unknown): Request =>
  new Request("http://localhost/api/reviews", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

test("rejects invalid bodies", async () => {
  expect((await POST(req({}))).status).toBe(400);
  expect((await POST(req({ products: [] }))).status).toBe(400);
});

test("rejects more than three products", async () => {
  const response = await POST(
    req({
      products: [
        { id: "a", title: "A" },
        { id: "b", title: "B" },
        { id: "c", title: "C" },
        { id: "d", title: "D" },
      ],
    }),
  );
  expect(response.status).toBe(400);
});

test("missing search key reports honestly", async () => {
  const response = await POST(
    req({ products: [{ id: "a", title: "Sony WH-1000XM5" }] }),
  );
  expect(response.status).toBe(503);
  const body = (await response.json()) as { code: string };
  expect(body.code).toBe("missing-tavily-key");
});
