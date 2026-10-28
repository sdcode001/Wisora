import { afterEach, expect, test } from "vitest";
import { POST } from "./route";

const SAVED_CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID;
const SAVED_SECRET = process.env.SESSION_SECRET;

afterEach(() => {
  if (SAVED_CLIENT_ID === undefined) {
    delete process.env.GOOGLE_OAUTH_CLIENT_ID;
  } else {
    process.env.GOOGLE_OAUTH_CLIENT_ID = SAVED_CLIENT_ID;
  }
  if (SAVED_SECRET === undefined) {
    delete process.env.SESSION_SECRET;
  } else {
    process.env.SESSION_SECRET = SAVED_SECRET;
  }
});

const req = (body: unknown): Request =>
  new Request("http://localhost/api/auth/google", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

test("rejects invalid bodies", async () => {
  const response = await POST(req({}));
  expect(response.status).toBe(400);
});

test("reports missing configuration honestly", async () => {
  delete process.env.GOOGLE_OAUTH_CLIENT_ID;
  delete process.env.SESSION_SECRET;
  const response = await POST(req({ idToken: "x" }));
  expect(response.status).toBe(503);
  const body = (await response.json()) as { code: string };
  expect(body.code).toBe("auth-not-configured");
});

test("rejects malformed tokens without network", async () => {
  process.env.GOOGLE_OAUTH_CLIENT_ID = "test-id";
  process.env.SESSION_SECRET = "test-secret";
  const response = await POST(req({ idToken: "not-a-token" }));
  expect(response.status).toBe(401);
  const body = (await response.json()) as { code: string };
  expect(body.code).toBe("invalid-id-token");
});

test("rejects bogus well-formed tokens", async () => {
  process.env.GOOGLE_OAUTH_CLIENT_ID = "test-id";
  process.env.SESSION_SECRET = "test-secret";
  // Well-formed JWT shape with an unknown key id: fails whether the cert
  // fetch runs (unknown kid) or the network is down (fetch throws).
  const bogus = [
    Buffer.from(JSON.stringify({ alg: "RS256", kid: "nope" })).toString(
      "base64url",
    ),
    Buffer.from(
      JSON.stringify({
        iss: "https://accounts.google.com",
        aud: "test-id",
        sub: "x",
        exp: 9999999999,
      }),
    ).toString("base64url"),
    "bogus",
  ].join(".");
  const response = await POST(req({ idToken: bogus }));
  expect(response.status).toBe(401);
});
