import { afterEach, expect, test, vi } from "vitest";
import { FileMemoryStore } from "./file-store";
import {
  getMemoryStore,
  resetMemoryStoreForTests,
  withTopologyRetry,
} from "./get-store";
import type { MemoryStore } from "./store";

afterEach(() => {
  delete process.env.MONGODB_URI;
  resetMemoryStoreForTests();
});

test("returns a file store when MONGODB_URI is unset", () => {
  delete process.env.MONGODB_URI;
  expect(getMemoryStore()).toBeInstanceOf(FileMemoryStore);
});

test("returns a fresh file store per call (test dirs stay isolated)", () => {
  delete process.env.MONGODB_URI;
  expect(getMemoryStore()).not.toBe(getMemoryStore());
});

test("returns a mongo-backed store when MONGODB_URI is set", () => {
  // Constructing the client does not connect — no server needed.
  process.env.MONGODB_URI = "mongodb://localhost:27017/test";
  resetMemoryStoreForTests();
  const store = getMemoryStore();
  expect(store).not.toBeInstanceOf(FileMemoryStore);
  expect(typeof store.getProfile).toBe("function");
});

function staleTopologyError(): Error {
  const error = new Error("Topology is closed");
  error.name = "MongoTopologyClosedError";
  return error;
}

test("a stale topology drops the client and retries once", async () => {
  const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const getProfile = vi
      .fn()
      .mockRejectedValueOnce(staleTopologyError())
      .mockResolvedValueOnce(null);
    const onStale = vi.fn();
    const store = withTopologyRetry(
      () => ({ getProfile }) as unknown as MemoryStore,
      onStale,
    );
    await expect(store.getProfile("user-1")).resolves.toBeNull();
    expect(getProfile).toHaveBeenCalledTimes(2);
    expect(onStale).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalled();
  } finally {
    warnSpy.mockRestore();
  }
});

test("ordinary errors propagate without a retry", async () => {
  const failure = new Error("boom");
  const getProfile = vi.fn().mockRejectedValue(failure);
  const onStale = vi.fn();
  const store = withTopologyRetry(
    () => ({ getProfile }) as unknown as MemoryStore,
    onStale,
  );
  await expect(store.getProfile("user-1")).rejects.toBe(failure);
  expect(getProfile).toHaveBeenCalledTimes(1);
  expect(onStale).not.toHaveBeenCalled();
});

test("a twice-dead topology propagates the second failure", async () => {
  const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const getProfile = vi.fn().mockRejectedValue(staleTopologyError());
    const onStale = vi.fn();
    const store = withTopologyRetry(
      () => ({ getProfile }) as unknown as MemoryStore,
      onStale,
    );
    await expect(store.getProfile("user-1")).rejects.toThrow(
      "Topology is closed",
    );
    expect(getProfile).toHaveBeenCalledTimes(2);
    expect(onStale).toHaveBeenCalledTimes(1);
  } finally {
    warnSpy.mockRestore();
  }
});
