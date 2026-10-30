import { expect, test } from "vitest";
import { POST } from "./route";

test("clears the session cookie", async () => {
  const response = await POST();
  expect(response.status).toBe(200);
  const setCookie = response.headers.get("set-cookie") ?? "";
  expect(setCookie).toContain("wisora_session=");
  expect(setCookie).toMatch(/Max-Age=0/i);
});

test("clearing attributes match the login cookie so browsers drop it", async () => {
  const response = await POST();
  const setCookie = response.headers.get("set-cookie") ?? "";
  // Deletion only works when name, path, and domain match the cookie
  // set at login; flags should match too.
  expect(setCookie).toMatch(/Path=\//i);
  expect(setCookie).toMatch(/SameSite=Lax/i);
  expect(setCookie).toMatch(/HttpOnly/i);
  const secureExpected = process.env.NODE_ENV === "production";
  expect(/;\s*Secure/i.test(setCookie)).toBe(secureExpected);
});
