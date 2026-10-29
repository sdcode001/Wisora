import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterEach, expect, test } from "vitest";
import {
  createSession,
  SESSION_COOKIE,
} from "../../../lib/auth/session";
import { DELETE, GET, PUT } from "./route";

const SAVED_SECRET = process.env.SESSION_SECRET;
const SAVED_DATA_DIR = process.env.WISORA_DATA_DIR;

afterEach(() => {
  if (SAVED_SECRET === undefined) {
    delete process.env.SESSION_SECRET;
  } else {
    process.env.SESSION_SECRET = SAVED_SECRET;
  }
  if (SAVED_DATA_DIR === undefined) {
    delete process.env.WISORA_DATA_DIR;
  } else {
    process.env.WISORA_DATA_DIR = SAVED_DATA_DIR;
  }
});

const USER = {
  sub: "user-1",
  name: "Test User",
  email: "test@example.com",
  picture: null,
};

async function useTempDataDir(): Promise<void> {
  process.env.SESSION_SECRET = "test-secret";
  process.env.WISORA_DATA_DIR = await mkdtemp(
    path.join(tmpdir(), "wisora-profile-"),
  );
}

function authedRequest(url: string, body?: unknown): NextRequest {
  const token = createSession(USER, "test-secret");
  return new NextRequest(url, {
    method: body === undefined ? "GET" : "PUT",
    headers: {
      cookie: `${SESSION_COOKIE}=${token}`,
      ...(body === undefined
        ? {}
        : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test("GET requires a signed-in user", async () => {
  await useTempDataDir();
  const response = await GET(
    new NextRequest("http://localhost/api/profile"),
  );
  expect(response.status).toBe(401);
  expect((await response.json()).code).toBe("unauthorized");
});

test("GET reports misconfigured auth as 503, not 401", async () => {
  process.env.WISORA_DATA_DIR = await mkdtemp(
    path.join(tmpdir(), "wisora-profile-"),
  );
  delete process.env.SESSION_SECRET;
  const response = await GET(
    new NextRequest("http://localhost/api/profile"),
  );
  expect(response.status).toBe(503);
  expect((await response.json()).code).toBe("auth-not-configured");
});

test("GET returns a null profile before anything is saved", async () => {
  await useTempDataDir();
  const response = await GET(
    authedRequest("http://localhost/api/profile"),
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ profile: null });
});

test("PUT creates a profile with stamped metadata", async () => {
  await useTempDataDir();
  const response = await PUT(
    authedRequest("http://localhost/api/profile", {
      general: { preferredBrands: ["Sony"], decisionPriority: "durability" },
    }),
  );
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.profile.userSub).toBe("user-1");
  expect(body.profile.general.value).toMatchObject({
    currency: "INR",
    preferredBrands: ["Sony"],
    decisionPriority: "durability",
  });
  expect(body.profile.general.provenance).toBe("explicit");
  expect(typeof body.profile.general.updatedAt).toBe("string");
});

test("PUT merges with previously saved preferences", async () => {
  await useTempDataDir();
  const url = "http://localhost/api/profile";
  await PUT(authedRequest(url, { general: { preferredBrands: ["Sony"] } }));
  const response = await PUT(
    authedRequest(url, { general: { avoidedBrands: ["Acme"] } }),
  );
  const body = await response.json();
  expect(body.profile.general.value).toMatchObject({
    preferredBrands: ["Sony"],
    avoidedBrands: ["Acme"],
  });
});

test("PUT rejects invalid preference bodies", async () => {
  await useTempDataDir();
  const url = "http://localhost/api/profile";
  for (const body of [
    {},
    { general: { currency: "xx" } },
    { general: null },
  ]) {
    const response = await PUT(authedRequest(url, body));
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe("invalid-preferences");
  }
});

test("DELETE clears the profile and reports repeat clears", async () => {
  await useTempDataDir();
  const url = "http://localhost/api/profile";
  const unauth = await DELETE(new NextRequest(url, { method: "DELETE" }));
  expect(unauth.status).toBe(401);
  const token = createSession(USER, "test-secret");
  const authedDelete = () =>
    DELETE(
      new NextRequest(url, {
        method: "DELETE",
        headers: { cookie: `${SESSION_COOKIE}=${token}` },
      }),
    );
  expect(await (await authedDelete()).json()).toEqual({ cleared: false });
  await PUT(authedRequest(url, { general: { preferredBrands: ["Sony"] } }));
  expect(await (await authedDelete()).json()).toEqual({ cleared: true });
  expect(await (await GET(authedRequest(url))).json()).toEqual({
    profile: null,
  });
});
