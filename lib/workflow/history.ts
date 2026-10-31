/**
 * Per-user localStorage history of completed searches and their results.
 *
 * Same ownership rule as the workflow draft: the key MUST be namespaced by
 * the signed-in user's `sub` so accounts sharing a browser never see each
 * other's history. Entries are matched by query — re-running or restoring a
 * search refreshes its entry in place instead of adding duplicates.
 */
export const HISTORY_VERSION = 1 as const;

/** Maximum entries kept per user; oldest beyond this are dropped. */
export const HISTORY_LIMIT = 15;

const HISTORY_PREFIX = "wisora:history:v1";

export function historyStorageKey(ownerSub: string): string {
  if (!ownerSub || ownerSub.trim() === "") {
    throw new Error("historyStorageKey requires a non-empty owner sub.");
  }
  return `${HISTORY_PREFIX}:user:${ownerSub}`;
}

export interface HistoryEntry<TSnapshot = unknown> {
  version: typeof HISTORY_VERSION;
  id: string;
  savedAt: string;
  query: string;
  verdict: string | null;
  topPick: string | null;
  snapshot: TSnapshot;
}

export interface NewHistoryEntry<TSnapshot = unknown> {
  query: string;
  verdict: string | null;
  topPick: string | null;
  snapshot: TSnapshot;
}

function isEntry(value: unknown): value is HistoryEntry {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const entry = value as Record<string, unknown>;
  return (
    entry.version === HISTORY_VERSION &&
    typeof entry.id === "string" &&
    entry.id.length > 0 &&
    typeof entry.savedAt === "string" &&
    typeof entry.query === "string" &&
    entry.query.length > 0 &&
    (entry.verdict === null || typeof entry.verdict === "string") &&
    (entry.topPick === null || typeof entry.topPick === "string") &&
    typeof entry.snapshot === "object" &&
    entry.snapshot !== null
  );
}

function createHistoryId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function readEntries(storage: Storage, key: string): HistoryEntry[] {
  try {
    const raw = storage.getItem(key);
    if (!raw) {
      return [];
    }
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter(isEntry);
  } catch {
    return [];
  }
}

function writeEntries(
  storage: Storage,
  key: string,
  entries: HistoryEntry[],
): HistoryEntry[] {
  try {
    storage.setItem(key, JSON.stringify(entries));
    return entries;
  } catch {
    // Quota exceeded: keep the newest half and retry once.
    const trimmed = entries.slice(
      0,
      Math.max(1, Math.floor(entries.length / 2)),
    );
    try {
      storage.setItem(key, JSON.stringify(trimmed));
      return trimmed;
    } catch {
      return readEntries(storage, key);
    }
  }
}

/** Newest first. Corrupt or foreign data yields an empty list. */
export function loadHistory<TSnapshot>(
  storage: Storage,
  key: string,
): Array<HistoryEntry<TSnapshot>> {
  const entries = readEntries(storage, key) as Array<HistoryEntry<TSnapshot>>;
  return [...entries].sort((a, b) => (a.savedAt < b.savedAt ? 1 : -1));
}

/**
 * Insert or refresh the entry for `entry.query` (newest first, capped).
 * Returns the stored list.
 */
export function saveHistoryEntry<TSnapshot>(
  storage: Storage,
  key: string,
  entry: NewHistoryEntry<TSnapshot>,
  savedAt: string,
  limit: number = HISTORY_LIMIT,
): Array<HistoryEntry<TSnapshot>> {
  const normalized = entry.query.trim();
  if (!normalized) {
    return loadHistory(storage, key);
  }
  const full: HistoryEntry<TSnapshot> = {
    version: HISTORY_VERSION,
    id: createHistoryId(),
    savedAt,
    query: normalized,
    verdict: entry.verdict,
    topPick: entry.topPick,
    snapshot: entry.snapshot,
  };
  const rest = readEntries(storage, key).filter(
    (existing) => existing.query !== normalized,
  );
  const next = [full, ...rest].slice(0, Math.max(1, limit));
  return writeEntries(storage, key, next) as Array<HistoryEntry<TSnapshot>>;
}

export function removeHistoryEntry<TSnapshot>(
  storage: Storage,
  key: string,
  id: string,
): Array<HistoryEntry<TSnapshot>> {
  const next = readEntries(storage, key).filter(
    (existing) => existing.id !== id,
  );
  return writeEntries(storage, key, next) as Array<HistoryEntry<TSnapshot>>;
}

export function clearHistory(storage: Storage, key: string): void {
  try {
    storage.removeItem(key);
  } catch {
    // Best effort; a stale history is harmless next to fresh searches.
  }
}
