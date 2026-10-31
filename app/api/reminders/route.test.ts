import { NextRequest } from "next/server";
import { expect, test } from "vitest";
import { FileMemoryStore } from "../../../lib/memory/file-store";
import type { Reminder } from "../../../lib/memory/records";
import {
  memoryRequest,
  setupMemoryEnv,
  setupTempMemoryDir,
} from "../memory/test-helpers";
import { DELETE, GET, POST, PUT } from "./route";

setupMemoryEnv();

const URL = "http://localhost/api/reminders";

const INPUT = {
  title: "Revisit the laptop",
  remindAt: "2026-03-01T12:00:00.000Z",
  timezone: "Asia/Kolkata",
  productId: "p1",
  url: "https://www.amazon.in/dp/B0TEST1",
  merchant: "Amazon India",
};

test("reminders require a signed-in user", async () => {
  await setupTempMemoryDir();
  expect((await GET(new NextRequest(URL))).status).toBe(401);
  expect((await POST(new NextRequest(URL, { method: "POST" }))).status).toBe(
    401,
  );
});

test("reminders CRUD with validation", async () => {
  await setupTempMemoryDir();
  expect((await POST(memoryRequest(URL, { body: { title: "x" } }))).status).toBe(
    400,
  );
  expect(
    (
      await POST(
        memoryRequest(URL, { body: { ...INPUT, timezone: "Mars/Olympus" } }),
      )
    ).status,
  ).toBe(400);

  const created = (await (
    await POST(memoryRequest(URL, { body: INPUT }))
  ).json()) as { reminder: Reminder };
  expect(created.reminder.status).toBe("active");

  const listed = (await (
    await GET(memoryRequest(`${URL}?status=active`))
  ).json()) as { reminders: Reminder[] };
  expect(listed.reminders).toHaveLength(1);

  const updated = (await (
    await PUT(
      memoryRequest(URL, {
        body: { id: created.reminder.id, note: "Decide soon" },
      }),
    )
  ).json()) as { reminder: Reminder };
  expect(updated.reminder.note).toBe("Decide soon");

  // Users cannot mark done directly — only the scheduler fires.
  expect(
    (
      await PUT(
        memoryRequest(URL, {
          body: { id: created.reminder.id, status: "done" },
        }),
      )
    ).status,
  ).toBe(400);
  expect(
    (await PUT(memoryRequest(URL, { body: { id: "missing" } }))).status,
  ).toBe(404);
  expect(
    (await DELETE(memoryRequest(URL, { method: "DELETE" }))).status,
  ).toBe(400);

  const deleted = (await (
    await DELETE(
      memoryRequest(`${URL}?id=${created.reminder.id}`, { method: "DELETE" }),
    )
  ).json()) as { deleted: boolean };
  expect(deleted.deleted).toBe(true);
});

test("reminder titles accept full-length listing titles", async () => {
  await setupTempMemoryDir();
  const maxed = "T".repeat(500);
  const created = await POST(memoryRequest(URL, { body: { ...INPUT, title: maxed } }));
  expect(created.status).toBe(200);
  const over = await POST(
    memoryRequest(URL, { body: { ...INPUT, title: `${maxed}X` } }),
  );
  expect(over.status).toBe(400);
});

test("users only see their own reminders", async () => {
  await setupTempMemoryDir();
  const store = new FileMemoryStore();
  await store.saveReminder("someone-else", {
    title: "Another user's reminder",
    kind: "one-time",
    remindAt: "2026-03-01T12:00:00.000Z",
    timezone: "UTC",
  });
  const body = (await (
    await GET(memoryRequest(URL))
  ).json()) as { reminders: unknown[] };
  expect(body.reminders).toEqual([]);
});
