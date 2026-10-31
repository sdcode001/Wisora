import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { FileMemoryStore } from "../memory/file-store";
import type { Notifier } from "../prices/notify";
import { maybeSendReminderEmail, reminderEmail } from "./email";

async function freshStore(): Promise<FileMemoryStore> {
  return new FileMemoryStore(await mkdtemp(path.join(tmpdir(), "wisora-remail-")));
}

function capturingNotifier(): Notifier & { calls: string[] } {
  const calls: string[] = [];
  return {
    available: true,
    calls,
    sendAlert: async () => ({ sent: false, error: "unused" }),
    sendEmail: async (input) => {
      calls.push(input.to);
      return { sent: true };
    },
  };
}

test("reminder templates state the trigger without predicting", async () => {
  const store = await freshStore();
  const reminder = await store.saveReminder("user-1", {
    title: "Revisit the laptop",
    kind: "one-time",
    remindAt: "2026-02-10T12:00:00.000Z",
    timezone: "UTC",
    note: "Decide before the trip",
  });
  const fired =
    (await store.updateReminder("user-1", {
      id: reminder.id,
      status: "done",
      firedAt: "2026-02-10T12:00:00.000Z",
      firedBecause: "time",
    })) ?? reminder;
  const content = reminderEmail(fired);
  expect(content.subject).toBe("Reminder: Revisit the laptop");
  expect(content.text).toContain("Decide before the trip");
  expect(content.text).toContain("not a prediction");
});

test("watch-bound reminders email; unbound ones stay in-app", async () => {
  const store = await freshStore();
  const watch = await store.saveWatch("user-1", {
    productId: "p1",
    url: "https://www.amazon.in/dp/B0TEST1",
    title: "Test Laptop",
    merchant: "Amazon India",
    targetPrice: 85000,
    currency: "INR",
    active: true,
    canWait: true,
    notifyEmail: "user@example.com",
  });
  const bound = await store.saveReminder("user-1", {
    title: "Bound reminder",
    kind: "one-time",
    remindAt: "2026-02-10T12:00:00.000Z",
    timezone: "UTC",
    watchId: watch.id,
  });
  const firedBound =
    (await store.updateReminder("user-1", {
      id: bound.id,
      status: "done",
      firedAt: "2026-02-10T12:00:00.000Z",
      firedBecause: "time",
    })) ?? bound;
  const capture = capturingNotifier();
  expect(
    await maybeSendReminderEmail({
      store,
      notifier: capture,
      userSub: "user-1",
      reminder: firedBound,
    }),
  ).toBe(true);
  expect(capture.calls).toEqual(["user@example.com"]);
  const storedBound = (await store.listReminders("user-1")).find(
    (entry) => entry.id === bound.id,
  );
  expect(storedBound?.email).toMatchObject({ attempted: true, sent: true });

  const freeform = await store.saveReminder("user-1", {
    title: "Freeform",
    kind: "one-time",
    remindAt: "2026-02-10T12:00:00.000Z",
    timezone: "UTC",
  });
  const firedFree =
    (await store.updateReminder("user-1", {
      id: freeform.id,
      status: "done",
      firedAt: "2026-02-10T12:00:00.000Z",
      firedBecause: "time",
    })) ?? freeform;
  expect(
    await maybeSendReminderEmail({
      store,
      notifier: capture,
      userSub: "user-1",
      reminder: firedFree,
    }),
  ).toBe(false);
  expect(capture.calls).toHaveLength(1);
});
