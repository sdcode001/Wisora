import { MongoClient, type Db } from "mongodb";
import { FileMemoryStore, defaultDataDir } from "./file-store";
import { MongoMemoryStore } from "./mongo-store";
import type { MemoryStore } from "./store";

/**
 * Single entry point for route handlers. MongoDB is used when
 * `MONGODB_URI` is set (required on serverless hosts, where the disk is
 * read-only); otherwise the file store keeps working for local development.
 *
 * The file store is constructed fresh on every call — route tests point
 * `WISORA_DATA_DIR` at a new temp dir per test, so caching it would leak
 * data across tests. The Mongo client is the only shared instance (the
 * driver pools connections internally), wrapped in a one-retry proxy so a
 * stale topology heals itself instead of failing every call.
 */
export function getMemoryStore(): MemoryStore {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    return new FileMemoryStore(defaultDataDir());
  }
  return withTopologyRetry(
    () => new MongoMemoryStore(sharedDb(uri)),
    dropSharedClient,
  );
}

interface MongoGlobal {
  __wisoraMongoClient?: MongoClient;
  __wisoraMongoUri?: string;
}

function sharedDb(uri: string): Db {
  const globalState = globalThis as MongoGlobal;
  if (
    !globalState.__wisoraMongoClient ||
    globalState.__wisoraMongoUri !== uri
  ) {
    globalState.__wisoraMongoClient = new MongoClient(uri);
    globalState.__wisoraMongoUri = uri;
  }
  // The driver connects lazily on first operation.
  return globalState.__wisoraMongoClient.db(
    process.env.WISORA_MONGO_DB ?? "wisora",
  );
}

function dropSharedClient(): void {
  const globalState = globalThis as MongoGlobal;
  const stale = globalState.__wisoraMongoClient;
  delete globalState.__wisoraMongoClient;
  delete globalState.__wisoraMongoUri;
  if (stale) {
    // Best effort: release the dead topology's sockets without ever
    // throwing or rejecting unhandled inside a request path.
    void stale.close().catch(() => {});
  }
}

function isStaleTopology(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const name = (error as { name?: unknown }).name;
  return (
    name === "MongoTopologyClosedError" || name === "MongoNotConnectedError"
  );
}

/**
 * Wrap a store so a dead client heals once per call: on a stale-topology
 * error the cached client is dropped, a fresh store is built, and the
 * operation runs exactly one more time. Any other error — including a
 * second stale-topology failure — propagates untouched.
 */
export function withTopologyRetry(
  getStore: () => MemoryStore,
  onStale: () => void,
): MemoryStore {
  return new Proxy({} as MemoryStore, {
    get(_target, prop: string | symbol) {
      // Never become thenable: `await getMemoryStore()` must not invoke us.
      if (prop === "then") {
        return undefined;
      }
      const method = prop as keyof MemoryStore;
      return async (...args: Array<unknown>): Promise<unknown> => {
        const invoke = (store: MemoryStore): Promise<unknown> =>
          (store[method] as (...callArgs: Array<unknown>) => Promise<unknown>)(
            ...args,
          );
        try {
          return await invoke(getStore());
        } catch (error) {
          if (!isStaleTopology(error)) {
            throw error;
          }
          console.warn(
            "Mongo topology was closed; recreating the client and retrying once.",
          );
          onStale();
          return await invoke(getStore());
        }
      };
    },
  });
}

/** Test-only: drop the cached client so URI changes take effect. */
export function resetMemoryStoreForTests(): void {
  dropSharedClient();
}
