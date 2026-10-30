import { NextRequest } from "next/server";
import { afterEach, expect, test } from "vitest";
import {
  createSession,
  SESSION_COOKIE,
} from "../../../../lib/auth/session";
import { GET } from "./route";

const SAVED_SECRET = process.env.SESSION_SECRET;

afterEach(() => {
  if (SAVED_SECRET === undefined) {
    delete process.env.SESSION_SECRET;
  } else {
    process.env.SESSION_SECRET = SAVED_SECRET;
  }
});

const USER = {
  sub: "user-123",
  name: "Test User",
  email: "test@example.com",
  picture: null,
};

function reqWithCookie(cookie: string | null): NextRequest {
  return new NextRequest("http://localhost/api/auth/me", {
    headers: cookie ? { cookie: `${SESSION_COOKIE}=${cookie}` } : {},
  });
}

test("returns a null user without a session", async () => {
  process.env.SESSION_SECRET = "test-secret";
  const response = await GET(reqWithCookie(null));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ user: null });
});

test("returns the user for a valid session", async () => {
  process.env.SESSION_SECRET = "test-secret";
  const response = await GET(
    reqWithCookie(createSession(USER, "test-secret")),
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ user: USER });
});

test("returns a null user for tampered sessions", async () => {
  process.env.SESSION_SECRET = "test-secret";
  const token = createSession(USER, "test-secret");
  const response = await GET(reqWithCookie(`${token}tampered`));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ user: null });
});

test("session answers are never cached", async () => {
  process.env.SESSION_SECRET = "test-secret";
  const anon = await GET(reqWithCookie(null));
  expect(anon.headers.get("Cache-Control")).toContain("no-store");
  const authed = await GET(
    reqWithCookie(createSession(USER, "test-secret")),
  );
  expect(authed.headers.get("Cache-Control")).toContain("no-store");
});
