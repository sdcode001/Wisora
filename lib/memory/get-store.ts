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
 * driver pools connections internally).
 */
export function getMemoryStore(): MemoryStore {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    return new FileMemoryStore(defaultDataDir());
  }
  return new MongoMemoryStore(sharedDb(uri));
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

/** Test-only: drop the cached client so URI changes take effect. */
export function resetMemoryStoreForTests(): void {
  const globalState = globalThis as MongoGlobal;
  delete globalState.__wisoraMongoClient;
  delete globalState.__wisoraMongoUri;
}
