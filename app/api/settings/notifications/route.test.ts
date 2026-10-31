import { NextRequest } from "next/server";
import { expect, test } from "vitest";
import {
  memoryRequest,
  setupMemoryEnv,
  setupTempMemoryDir,
} from "../../memory/test-helpers";
import { GET, PUT } from "./route";

setupMemoryEnv();

const URL = "http://localhost/api/settings/notifications";

test("settings require a signed-in user", async () => {
  await setupTempMemoryDir();
  expect((await GET(new NextRequest(URL))).status).toBe(401);
  expect((await PUT(new NextRequest(URL, { method: "PUT" }))).status).toBe(
    401,
  );
});

test("settings default and merge on save", async () => {
  await setupTempMemoryDir();
  const initial = (await (
    await GET(memoryRequest(URL))
  ).json()) as {
    settings: { proactiveEnabled: boolean; priceEmails: boolean };
  };
  expect(initial.settings).toMatchObject({
    proactiveEnabled: true,
    priceEmails: true,
  });

  expect(
    (await PUT(memoryRequest(URL, { body: { priceEmails: "yes" } }))).status,
  ).toBe(400);

  const saved = (await (
    await PUT(
      memoryRequest(URL, {
        body: { proactiveEnabled: false, priceEmails: false },
      }),
    )
  ).json()) as {
    settings: {
      proactiveEnabled: boolean;
      priceEmails: boolean;
      availabilityEmails: boolean;
      updatedAt: string;
    };
  };
  expect(saved.settings).toMatchObject({
    proactiveEnabled: false,
    priceEmails: false,
    availabilityEmails: true,
  });
  expect(saved.settings.updatedAt).toBeTruthy();
});
