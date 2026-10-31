import { NextRequest } from "next/server";
import { expect, test } from "vitest";
import { FileMemoryStore } from "../../../../lib/memory/file-store";
import {
  MEMORY_TEST_USER,
  memoryRequest,
  setupMemoryEnv,
  setupTempMemoryDir,
} from "../../memory/test-helpers";
import { DELETE, GET } from "./route";

setupMemoryEnv();

const URL = "http://localhost/api/chat/threads";

test("threads require a signed-in user", async () => {
  await setupTempMemoryDir();
  expect((await GET(new NextRequest(URL))).status).toBe(401);
  expect((await DELETE(new NextRequest(URL, { method: "DELETE" }))).status).toBe(
    401,
  );
});

test("threads list, isolate, and delete", async () => {
  await setupTempMemoryDir();
  const store = new FileMemoryStore();
  const mine = await store.createChatThread(MEMORY_TEST_USER.sub, {
    title: "Mine",
    firstMessage: { role: "user", text: "hi" },
  });
  await store.createChatThread("someone-else", {
    title: "Theirs",
    firstMessage: { role: "user", text: "hi" },
  });
  const listed = (await (
    await GET(memoryRequest(URL))
  ).json()) as { threads: Array<{ id: string }> };
  expect(listed.threads.map((t) => t.id)).toEqual([mine.id]);

  expect(
    (await DELETE(memoryRequest(URL, { method: "DELETE" }))).status,
  ).toBe(400);
  const deleted = (await (
    await DELETE(memoryRequest(`${URL}?id=${mine.id}`, { method: "DELETE" }))
  ).json()) as { deleted: boolean };
  expect(deleted.deleted).toBe(true);
});
