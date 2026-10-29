import { expect, test } from "vitest";
import { createSession, SESSION_COOKIE } from "./session";
import { sessionUserFromRequest } from "./require-session";

const USER = {
  sub: "user-123",
  name: "Test User",
  email: "test@example.com",
  picture: null,
};

function reqWithCookieHeader(cookieHeader: string | null): Request {
  return new Request("http://localhost/api/profile", {
    headers: cookieHeader ? { cookie: cookieHeader } : {},
  });
}

test("returns the user for a valid session cookie", () => {
  process.env.SESSION_SECRET = "test-secret";
  const request = reqWithCookieHeader(
    `other=1; ${SESSION_COOKIE}=${createSession(USER, "test-secret")}`,
  );
  expect(sessionUserFromRequest(request)).toEqual(USER);
  delete process.env.SESSION_SECRET;
});

test("returns null without a cookie header", () => {
  process.env.SESSION_SECRET = "test-secret";
  expect(sessionUserFromRequest(reqWithCookieHeader(null))).toBeNull();
  delete process.env.SESSION_SECRET;
});

test("returns null when the session cookie is absent", () => {
  process.env.SESSION_SECRET = "test-secret";
  expect(sessionUserFromRequest(reqWithCookieHeader("other=1"))).toBeNull();
  delete process.env.SESSION_SECRET;
});

test("returns null for a tampered token", () => {
  process.env.SESSION_SECRET = "test-secret";
  const token = createSession(USER, "test-secret");
  const request = reqWithCookieHeader(`${SESSION_COOKIE}=${token}tampered`);
  expect(sessionUserFromRequest(request)).toBeNull();
  delete process.env.SESSION_SECRET;
});

test("returns null when SESSION_SECRET is not configured", () => {
  delete process.env.SESSION_SECRET;
  const request = reqWithCookieHeader(`${SESSION_COOKIE}=anything`);
  expect(sessionUserFromRequest(request)).toBeNull();
});
