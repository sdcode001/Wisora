import { afterEach, expect, test } from "vitest";
import { FileMemoryStore } from "./file-store";
import {
  getMemoryStore,
  resetMemoryStoreForTests,
} from "./get-store";
import { MongoMemoryStore } from "./mongo-store";

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

test("returns a mongo store when MONGODB_URI is set", () => {
  // Constructing the client does not connect — no server needed.
  process.env.MONGODB_URI = "mongodb://localhost:27017/test";
  resetMemoryStoreForTests();
  expect(getMemoryStore()).toBeInstanceOf(MongoMemoryStore);
});
