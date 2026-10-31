import { NextRequest } from "next/server";
import { expect, test } from "vitest";
import {
  memoryRequest,
  setupMemoryEnv,
  setupTempMemoryDir,
} from "../memory/test-helpers";
import { POST } from "./route";

setupMemoryEnv();

const SAVED_META = process.env.META_API_KEY;

test("chat requires auth and a valid body", async () => {
  await setupTempMemoryDir();
  const url = "http://localhost/api/chat";
  expect((await POST(new NextRequest(url, { method: "POST" }))).status).toBe(
    401,
  );
  expect((await POST(memoryRequest(url, { body: {} }))).status).toBe(400);
  expect(
    (await POST(memoryRequest(url, { body: { message: "  " } }))).status,
  ).toBe(400);
});

test("chat answers deterministically when the model is unavailable", async () => {
  delete process.env.META_API_KEY;
  try {
    await setupTempMemoryDir();
    const url = "http://localhost/api/chat";
    const body = (await (
      await POST(memoryRequest(url, { body: { message: "hello" } }))
    ).json()) as {
      thread: { id: string; messages: Array<{ role: string; text: string }> };
      reply: { text: string; source: string };
    };
    expect(body.reply.source).toBe("rules");
    expect(body.reply.text).toContain("Hi!");
    expect(body.thread.messages).toHaveLength(2);

    const followUp = (await (
      await POST(
        memoryRequest(url, {
          body: { threadId: body.thread.id, message: "What am I tracking?" },
        }),
      )
    ).json()) as { reply: { text: string } };
    expect(followUp.reply.text).toContain("not tracking");

    expect(
      (
        await POST(
          memoryRequest(url, { body: { threadId: "missing", message: "hi" } }),
        )
      ).status,
    ).toBe(404);
  } finally {
    if (SAVED_META === undefined) {
      delete process.env.META_API_KEY;
    } else {
      process.env.META_API_KEY = SAVED_META;
    }
  }
});
