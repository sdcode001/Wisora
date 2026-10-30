import { beforeEach, expect, test } from "vitest";
import {
  LEGACY_WORKFLOW_KEY,
  WORKFLOW_VERSION,
  clearStoredWorkflow,
  loadStoredWorkflow,
  saveStoredWorkflow,
  workflowStorageKey,
} from "./persist";

interface TestState {
  version: 1;
  query: string;
}

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    key(index: number) {
      return [...data.keys()][index] ?? null;
    },
    getItem(key: string) {
      return data.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      data.set(key, value);
    },
    removeItem(key: string) {
      data.delete(key);
    },
    clear() {
      data.clear();
    },
  };
}

let storage: Storage;

beforeEach(() => {
  storage = memoryStorage();
});

test("keys are namespaced per user and never the legacy global key", () => {
  const a = workflowStorageKey("user-a");
  const b = workflowStorageKey("user-b");
  expect(a).not.toBe(b);
  expect(a).not.toBe(LEGACY_WORKFLOW_KEY);
  expect(b).not.toBe(LEGACY_WORKFLOW_KEY);
  expect(a).toContain("user-a");
});

test("empty owner fails loudly instead of sharing one key", () => {
  expect(() => workflowStorageKey("")).toThrow();
  expect(() => workflowStorageKey("   ")).toThrow();
});

test("one user cannot load another user's saved workflow", () => {
  saveStoredWorkflow<TestState>(storage, workflowStorageKey("user-a"), {
    version: WORKFLOW_VERSION,
    query: "user a search",
  });
  // Same user restores their own work.
  expect(
    loadStoredWorkflow<TestState>(storage, workflowStorageKey("user-a")),
  ).toEqual({ version: 1, query: "user a search" });
  // A different signed-in account sees nothing of it.
  expect(
    loadStoredWorkflow<TestState>(storage, workflowStorageKey("user-b")),
  ).toBeNull();
  // Namespaced writes never touch the legacy global key.
  expect(storage.getItem(LEGACY_WORKFLOW_KEY)).toBeNull();
});

test("corrupt or version-mismatched payloads load as null", () => {
  const key = workflowStorageKey("user-a");
  storage.setItem(key, "{not json");
  expect(loadStoredWorkflow<TestState>(storage, key)).toBeNull();
  storage.setItem(key, JSON.stringify({ version: 999, query: "x" }));
  expect(loadStoredWorkflow<TestState>(storage, key)).toBeNull();
});

test("clear removes only the given user's key", () => {
  const a = workflowStorageKey("user-a");
  const b = workflowStorageKey("user-b");
  saveStoredWorkflow<TestState>(storage, a, {
    version: WORKFLOW_VERSION,
    query: "a",
  });
  saveStoredWorkflow<TestState>(storage, b, {
    version: WORKFLOW_VERSION,
    query: "b",
  });
  clearStoredWorkflow(storage, a);
  expect(loadStoredWorkflow<TestState>(storage, a)).toBeNull();
  expect(loadStoredWorkflow<TestState>(storage, b)?.query).toBe("b");
});
