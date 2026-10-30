/**
 * Per-user localStorage persistence for the search/recommend workflow.
 *
 * The key MUST be namespaced by the signed-in user's `sub`: a single global
 * key leaks one account's searches and verdicts into another account sharing
 * the same browser. Callers pass an explicit key so ownership is visible at
 * every read and write.
 */
export const WORKFLOW_VERSION = 1 as const;

/** Pre-fix global key. Never written again; removed once on load. */
export const LEGACY_WORKFLOW_KEY = "wisora:workflow:v1";

export function workflowStorageKey(ownerSub: string): string {
  if (!ownerSub || ownerSub.trim() === "") {
    throw new Error("workflowStorageKey requires a non-empty owner sub.");
  }
  return `${LEGACY_WORKFLOW_KEY}:user:${ownerSub}`;
}

interface Versioned {
  version: number;
}

export function loadStoredWorkflow<T extends Versioned>(
  storage: Storage,
  key: string,
): T | null {
  try {
    const raw = storage.getItem(key);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as Partial<T>;
    if (parsed?.version !== WORKFLOW_VERSION) {
      return null;
    }
    return parsed as T;
  } catch {
    return null;
  }
}

export function saveStoredWorkflow<T extends Versioned>(
  storage: Storage,
  key: string,
  state: T,
): void {
  try {
    storage.setItem(key, JSON.stringify(state));
  } catch {
    // Storage full or unavailable — the app works without persistence.
  }
}

export function clearStoredWorkflow(storage: Storage, key: string): void {
  try {
    storage.removeItem(key);
  } catch {
    // Best effort; a stale draft is harmless next to server-side memory.
  }
}
