import { NextRequest } from "next/server";
import { expect, test } from "vitest";
import { memoryRequest, setupMemoryEnv, setupTempMemoryDir } from "../test-helpers";
import { GET, POST } from "./route";

setupMemoryEnv();

test("feedback requires a signed-in user", async () => {
  await setupTempMemoryDir();
  const url = "http://localhost/api/memory/feedback";
  expect((await GET(new NextRequest(url))).status).toBe(401);
  expect(
    (await POST(new NextRequest(url, { method: "POST" }))).status,
  ).toBe(401);
});

test("feedback saves and lists", async () => {
  await setupTempMemoryDir();
  const url = "http://localhost/api/memory/feedback";
  const saved = await POST(
    memoryRequest(url, {
      body: {
        decisionId: "d1",
        helpful: true,
        preferred: { productId: "p1", title: "Sony X" },
      },
    }),
  );
  expect(saved.status).toBe(200);
  const body = (await saved.json()) as {
    feedback: { id: string; helpful: boolean };
  };
  expect(body.feedback.helpful).toBe(true);
  expect(body.feedback.id).toMatch(/^[0-9a-f]{24}$/);
  const listed = (await (await GET(memoryRequest(url))).json()) as {
    feedback: unknown[];
  };
  expect(listed.feedback).toHaveLength(1);
});

test("signal-less feedback is rejected", async () => {
  await setupTempMemoryDir();
  const url = "http://localhost/api/memory/feedback";
  const response = await POST(
    memoryRequest(url, { body: { decisionId: "d1" } }),
  );
  expect(response.status).toBe(400);
  expect((await response.json()).code).toBe("invalid-feedback");
});
