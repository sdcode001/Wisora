import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterEach } from "vitest";
import {
  createSession,
  SESSION_COOKIE,
} from "../../../lib/auth/session";

/**
 * Test-only helpers for the memory API routes. Not a route: the App
 * Router ignores non-reserved filenames, and vitest only picks up
 * `*.test.ts`.
 */

export const MEMORY_TEST_USER = {
  sub: "user-1",
  name: "Test User",
  email: "test@example.com",
  picture: null,
};

/** Call once per test file to isolate SESSION_SECRET/WISORA_DATA_DIR. */
export function setupMemoryEnv(): void {
  const savedSecret = process.env.SESSION_SECRET;
  const savedDataDir = process.env.WISORA_DATA_DIR;
  afterEach(() => {
    if (savedSecret === undefined) {
      delete process.env.SESSION_SECRET;
    } else {
      process.env.SESSION_SECRET = savedSecret;
    }
    if (savedDataDir === undefined) {
      delete process.env.WISORA_DATA_DIR;
    } else {
      process.env.WISORA_DATA_DIR = savedDataDir;
    }
  });
}

/** Point the file store at a fresh temp dir and enable test sessions. */
export async function setupTempMemoryDir(): Promise<string> {
  process.env.SESSION_SECRET = "test-secret";
  const dir = await mkdtemp(path.join(tmpdir(), "wisora-memory-api-"));
  process.env.WISORA_DATA_DIR = dir;
  return dir;
}

export function memoryRequest(
  url: string,
  init?: { method?: string; body?: unknown },
): NextRequest {
  const token = createSession(MEMORY_TEST_USER, "test-secret");
  return new NextRequest(url, {
    method: init?.method ?? (init?.body === undefined ? "GET" : "POST"),
    headers: {
      cookie: `${SESSION_COOKIE}=${token}`,
      ...(init?.body === undefined
        ? {}
        : { "content-type": "application/json" }),
    },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
}
