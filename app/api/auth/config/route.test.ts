import { afterEach, expect, test } from "vitest";
import { GET } from "./route";

const SAVED = process.env.GOOGLE_OAUTH_CLIENT_ID;

afterEach(() => {
  if (SAVED === undefined) {
    delete process.env.GOOGLE_OAUTH_CLIENT_ID;
  } else {
    process.env.GOOGLE_OAUTH_CLIENT_ID = SAVED;
  }
});

test("returns null when unconfigured", async () => {
  delete process.env.GOOGLE_OAUTH_CLIENT_ID;
  const response = await GET();
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ clientId: null });
});

test("returns the client id when configured", async () => {
  process.env.GOOGLE_OAUTH_CLIENT_ID = "test-id.apps.googleusercontent.com";
  const response = await GET();
  expect(await response.json()).toEqual({
    clientId: "test-id.apps.googleusercontent.com",
  });
});
