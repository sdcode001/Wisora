import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { FileMemoryStore } from "../memory/file-store";
import { decideEmail } from "./policy";

async function freshStore(): Promise<FileMemoryStore> {
  return new FileMemoryStore(await mkdtemp(path.join(tmpdir(), "wisora-pol-")));
}

async function watchWithEmail(
  store: FileMemoryStore,
  notifyEmail: string | null,
): Promise<string> {
  const watch = await store.saveWatch("user-1", {
    productId: "p1",
    url: "https://www.amazon.in/dp/B0TEST1",
    title: "Test Laptop",
    merchant: "Amazon India",
    targetPrice: 85000,
    currency: "INR",
    active: true,
    canWait: true,
  });
  if (notifyEmail) {
    await store.updateWatch("user-1", { id: watch.id, notifyEmail });
  }
  return watch.id;
}

test("disabled preferences block sending", async () => {
  const store = await freshStore();
  const watchId = await watchWithEmail(store, "user@example.com");
  await store.saveNotificationSettings("user-1", { priceEmails: false });
  const blocked = await decideEmail({
    store,
    userSub: "user-1",
    kind: "price",
    watchId,
  });
  expect(blocked).toMatchObject({ send: false });
  expect(blocked.reason).toContain("disabled");
  const allowed = await decideEmail({
    store,
    userSub: "user-1",
    kind: "availability",
    watchId,
  });
  expect(allowed).toMatchObject({ send: true, to: "user@example.com" });
});

test("missing watch addresses block sending", async () => {
  const store = await freshStore();
  const watchId = await watchWithEmail(store, null);
  expect(
    await decideEmail({
      store,
      userSub: "user-1",
      kind: "price",
      watchId,
    }),
  ).toMatchObject({ send: false });
  expect(
    await decideEmail({
      store,
      userSub: "user-1",
      kind: "reminder",
      watchId: null,
    }),
  ).toMatchObject({ send: false });
});

test("every trigger sends when preferences allow", async () => {
  const store = await freshStore();
  const watchId = await watchWithEmail(store, "user@example.com");
  for (const kind of ["price", "availability", "reminder"] as const) {
    expect(
      await decideEmail({ store, userSub: "user-1", kind, watchId }),
    ).toMatchObject({ send: true, to: "user@example.com" });
  }
});
