import { beforeEach, expect, test } from "vitest";
import {
  HISTORY_LIMIT,
  clearHistory,
  historyStorageKey,
  loadHistory,
  removeHistoryEntry,
  saveHistoryEntry,
} from "./history";

interface TestSnapshot {
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

function quotaStorage(failures: number): Storage {
  const inner = memoryStorage();
  let remaining = failures;
  return {
    ...inner,
    setItem(key: string, value: string) {
      if (remaining > 0) {
        remaining -= 1;
        throw new Error("QuotaExceededError");
      }
      inner.setItem(key, value);
    },
  };
}

let storage: Storage;
const KEY = historyStorageKey("user-a");

beforeEach(() => {
  storage = memoryStorage();
});

function entry(
  query: string,
  verdict: string | null = "BUY",
): {
  query: string;
  verdict: string | null;
  topPick: string | null;
  snapshot: TestSnapshot;
} {
  return {
    query,
    verdict,
    topPick: `${query} pick`,
    snapshot: { version: 1, query },
  };
}

test("keys are namespaced per user", () => {
  expect(historyStorageKey("user-a")).not.toBe(historyStorageKey("user-b"));
  expect(() => historyStorageKey("")).toThrow();
  expect(() => historyStorageKey("   ")).toThrow();
});

test("one user cannot load another user's history", () => {
  saveHistoryEntry(storage, KEY, entry("laptop"), "2026-02-10T10:00:00.000Z");
  expect(loadHistory(storage, historyStorageKey("user-b"))).toEqual([]);
  expect(loadHistory(storage, KEY)).toHaveLength(1);
});

test("entries return newest first", () => {
  saveHistoryEntry(storage, KEY, entry("first"), "2026-02-10T10:00:00.000Z");
  saveHistoryEntry(storage, KEY, entry("second"), "2026-02-10T11:00:00.000Z");
  const loaded = loadHistory<TestSnapshot>(storage, KEY);
  expect(loaded.map((item) => item.query)).toEqual(["second", "first"]);
});

test("same query refreshes in place instead of duplicating", () => {
  saveHistoryEntry(storage, KEY, entry("laptop", "WAIT"), "2026-02-10T10:00:00Z");
  const next = saveHistoryEntry(
    storage,
    KEY,
    entry("laptop", "BUY"),
    "2026-02-10T11:00:00Z",
  );
  expect(next).toHaveLength(1);
  expect(next[0]).toMatchObject({ query: "laptop", verdict: "BUY" });
});

test("blank queries are ignored", () => {
  expect(
    saveHistoryEntry(storage, KEY, entry("   "), "2026-02-10T10:00:00Z"),
  ).toEqual([]);
});

test("list is capped at the limit, oldest dropped", () => {
  for (let index = 0; index < HISTORY_LIMIT + 5; index += 1) {
    saveHistoryEntry(
      storage,
      KEY,
      entry(`query-${index}`),
      `2026-02-10T10:${String(index).padStart(2, "0")}:00Z`,
    );
  }
  const loaded = loadHistory<TestSnapshot>(storage, KEY);
  expect(loaded).toHaveLength(HISTORY_LIMIT);
  expect(loaded[0].query).toBe(`query-${HISTORY_LIMIT + 4}`);
});

test("corrupt or foreign data loads as empty", () => {
  storage.setItem(KEY, "not-json{{{");
  expect(loadHistory(storage, KEY)).toEqual([]);
  storage.setItem(KEY, JSON.stringify({ version: 1 }));
  expect(loadHistory(storage, KEY)).toEqual([]);
  storage.setItem(
    KEY,
    JSON.stringify([{ version: 99, id: "x", query: "x", snapshot: {} }]),
  );
  expect(loadHistory(storage, KEY)).toEqual([]);
});

test("remove deletes one entry; clear empties the list", () => {
  saveHistoryEntry(storage, KEY, entry("first"), "2026-02-10T10:00:00Z");
  saveHistoryEntry(storage, KEY, entry("second"), "2026-02-10T11:00:00Z");
  const loaded = loadHistory<TestSnapshot>(storage, KEY);
  const remaining = removeHistoryEntry<TestSnapshot>(
    storage,
    KEY,
    loaded[0].id,
  );
  expect(remaining.map((item) => item.query)).toEqual(["first"]);
  clearHistory(storage, KEY);
  expect(loadHistory(storage, KEY)).toEqual([]);
});

test("quota failure shrinks the list and retries once", () => {
  const failing = quotaStorage(1);
  const stored = saveHistoryEntry(
    failing,
    KEY,
    entry("laptop"),
    "2026-02-10T10:00:00Z",
  );
  expect(stored.map((item) => item.query)).toEqual(["laptop"]);
  const alwaysFailing = quotaStorage(99);
  expect(
    saveHistoryEntry(
      alwaysFailing,
      KEY,
      entry("laptop"),
      "2026-02-10T10:00:00Z",
    ),
  ).toEqual([]);
});
