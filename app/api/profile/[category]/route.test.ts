import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterEach, expect, test } from "vitest";
import {
  createSession,
  SESSION_COOKIE,
} from "../../../../lib/auth/session";
import { GET as getProfile } from "../route";
import { GET, PUT } from "./route";

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
    path.join(tmpdir(), "wisora-profile-cat-"),
  );
}

function contextFor(category: string) {
  return { params: Promise.resolve({ category }) };
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

test("category endpoints require a signed-in user", async () => {
  await useTempDataDir();
  const url = "http://localhost/api/profile/fashion";
  const getResponse = await GET(
    new NextRequest(url),
    contextFor("fashion"),
  );
  expect(getResponse.status).toBe(401);
  const putResponse = await PUT(
    new NextRequest(url, { method: "PUT" }),
    contextFor("fashion"),
  );
  expect(putResponse.status).toBe(401);
});

test("unknown categories are rejected", async () => {
  await useTempDataDir();
  const url = "http://localhost/api/profile/phones";
  const getResponse = await GET(authedRequest(url), contextFor("phones"));
  expect(getResponse.status).toBe(400);
  expect((await getResponse.json()).code).toBe("unknown-category");
  const putResponse = await PUT(
    authedRequest(url, { preferences: {} }),
    contextFor("phones"),
  );
  expect(putResponse.status).toBe(400);
});

test("GET returns null preferences before anything is saved", async () => {
  await useTempDataDir();
  const response = await GET(
    authedRequest("http://localhost/api/profile/fashion"),
    contextFor("fashion"),
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    category: "fashion",
    preferences: null,
  });
});

test("PUT creates and merges a category section", async () => {
  await useTempDataDir();
  const url = "http://localhost/api/profile/electronics";
  const created = await PUT(
    authedRequest(url, {
      preferences: { budgetInr: { max: 90000 }, minRamGb: 16 },
    }),
    contextFor("electronics"),
  );
  expect(created.status).toBe(200);
  expect((await created.json()).preferences.value).toMatchObject({
    category: "electronics",
    budgetInr: { max: 90000 },
    minRamGb: 16,
  });
  const merged = await PUT(
    authedRequest(url, {
      preferences: { minRamGb: null, useCase: "coding" },
    }),
    contextFor("electronics"),
  );
  const body = await merged.json();
  expect(body.preferences.value).toMatchObject({
    category: "electronics",
    budgetInr: { max: 90000 },
    useCase: "coding",
  });
  expect("minRamGb" in body.preferences.value).toBe(false);
});

test("PUT rejects invalid category preferences", async () => {
  await useTempDataDir();
  const url = "http://localhost/api/profile/electronics";
  const badBudget = await PUT(
    authedRequest(url, {
      preferences: { budgetInr: { min: 90000, max: 50000 } },
    }),
    contextFor("electronics"),
  );
  expect(badBudget.status).toBe(400);
  const badEnvelope = await PUT(
    authedRequest(url, { preferences: null }),
    contextFor("electronics"),
  );
  expect(badEnvelope.status).toBe(400);
});

test("PUT strips fields belonging to other categories", async () => {
  await useTempDataDir();
  const response = await PUT(
    authedRequest("http://localhost/api/profile/fashion", {
      preferences: { sizes: ["M"], minRamGb: 16 },
    }),
    contextFor("fashion"),
  );
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.preferences.value).toEqual({
    category: "fashion",
    sizes: ["M"],
  });
});

test("categories stay independent within one profile", async () => {
  await useTempDataDir();
  await PUT(
    authedRequest("http://localhost/api/profile/fashion", {
      preferences: { sizes: ["M"] },
    }),
    contextFor("fashion"),
  );
  await PUT(
    authedRequest("http://localhost/api/profile/electronics", {
      preferences: { minRamGb: 16 },
    }),
    contextFor("electronics"),
  );
  const response = await getProfile(
    authedRequest("http://localhost/api/profile"),
  );
  const body = await response.json();
  expect(body.profile.categories.fashion.value).toMatchObject({
    sizes: ["M"],
  });
  expect(body.profile.categories.electronics.value).toMatchObject({
    minRamGb: 16,
  });
  expect("sizes" in body.profile.categories.electronics.value).toBe(false);
});
