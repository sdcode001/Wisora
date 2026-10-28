import { expect, test } from "vitest";
import { POST } from "./route";

test("clears the session cookie", async () => {
  const response = await POST();
  expect(response.status).toBe(200);
  const setCookie = response.headers.get("set-cookie") ?? "";
  expect(setCookie).toContain("wisora_session=");
  expect(setCookie).toMatch(/Max-Age=0/i);
});
