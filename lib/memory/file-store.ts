import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
  NewWatchSchema,
  PriceAlertSchema,
  PriceObservationSchema,
  WatchSchema,
  type NewPriceAlert,
  type NewWatch,
  type PriceAlert,
  type PriceObservation,
  type Watch,
  type WatchCheck,
  type WatchUpdate,
} from "../prices/observation";
import { UserProfileSchema, type UserProfile } from "./profile";
import {
  DecisionRecordSchema,
  FeedbackSchema,
  NewDecisionRecordSchema,
  NewFeedbackSchema,
  NewSavedComparisonSchema,
  NewSavedProductSchema,
  SavedComparisonSchema,
  SavedProductSchema,
  createRecordId,
  type DecisionRecord,
  type Feedback,
  type NewDecisionRecord,
  type NewFeedback,
  type NewSavedComparison,
  type NewSavedProduct,
  type SavedComparison,
  type SavedProduct,
} from "./records";
import {
  ProposalSchema,
  type NewProposal,
  type Proposal,
  type ProposalStatus,
} from "./proposals";
import type { MemoryStore } from "./store";

/**
 * Stored bytes exist but cannot be used (unsupported version, identity
 * mismatch, unreadable directory). Routes map this to an honest 500 —
 * the bytes on disk are left untouched for inspection.
 */
export class StoredDataError extends Error {}

/** An active watch already tracks this product at this target. */
export class DuplicateWatchError extends Error {}

/** The per-user watchlist cap was reached. */
export class WatchlistFullError extends Error {}

/** Growth bounds per record file; oldest entries past the cap drop on write. */
export const MAX_DECISIONS = 50;
export const MAX_FEEDBACK = 100;
export const MAX_SAVED_PRODUCTS = 100;
export const MAX_SAVED_COMPARISONS = 30;
export const MAX_PROPOSALS = 50;
export const MAX_OBSERVATIONS_PER_PRODUCT = 200;
export const MAX_WATCHES = 50;
export const MAX_ALERTS = 100;
/** Same-price observations within this window are skipped, not duplicated. */
export const OBS_SAME_PRICE_WINDOW_HOURS = 6;

export function defaultDataDir(): string {
  return process.env.WISORA_DATA_DIR ?? path.join(process.cwd(), "data");
}

/**
 * File-backed MemoryStore. Each user gets one directory named by the
 * SHA-256 of their subject (so the raw sub is never a filename), holding
 * `profile.json` plus one JSON file per record list. Writes are atomic
 * (temp file + rename); reads validate against the record schemas, and
 * unparseable files are quarantined (bytes preserved) instead of trusted.
 */
export class FileMemoryStore implements MemoryStore {
  constructor(private readonly rootDir: string = defaultDataDir()) {}

  private userDir(userSub: string): string {
    const hash = createHash("sha256")
      .update(userSub, "utf8")
      .digest("hex")
      .slice(0, 32);
    return path.join(this.rootDir, "users", hash);
  }

  private profileFile(userSub: string): string {
    return path.join(this.userDir(userSub), "profile.json");
  }

  private listFile(userSub: string, name: string): string {
    return path.join(this.userDir(userSub), name);
  }

  private async readList<T>(
    file: string,
    parse: (data: unknown) => T[] | null,
  ): Promise<T[]> {
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      await this.quarantine(file);
      return [];
    }
    const parsed = parse(data);
    if (!parsed) {
      await this.quarantine(file);
      return [];
    }
    return parsed;
  }

  private async writeJson(file: string, value: unknown): Promise<void> {
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
    await rename(tmp, file);
  }

  async getProfile(userSub: string): Promise<UserProfile | null> {
    const file = this.profileFile(userSub);
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Unparseable bytes can never be migrated — quarantine and start fresh.
      await this.quarantine(file);
      return null;
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      (parsed as { version?: unknown }).version !== 1
    ) {
      // Version drift may be recoverable by a future migration: fail
      // loudly and preserve the file instead of quarantining it.
      throw new StoredDataError(`Unsupported profile version in ${file}`);
    }
    const valid = UserProfileSchema.safeParse(parsed);
    if (!valid.success) {
      await this.quarantine(file);
      return null;
    }
    if (valid.data.userSub !== userSub) {
      throw new StoredDataError(`Profile identity mismatch in ${file}`);
    }
    return valid.data;
  }

  async saveProfile(profile: UserProfile): Promise<void> {
    const valid = UserProfileSchema.parse(profile);
    await this.writeJson(this.profileFile(valid.userSub), valid);
  }

  async clearProfile(userSub: string): Promise<boolean> {
    const file = this.profileFile(userSub);
    try {
      await rm(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return false;
      }
      throw error;
    }
    // Best effort: remove the user directory when it holds nothing else.
    // Quarantined files intentionally keep the directory alive.
    try {
      const entries = await readdir(this.userDir(userSub));
      if (entries.length === 0) {
        await rm(this.userDir(userSub), { recursive: true });
      }
    } catch {
      // Directory cleanup is cosmetic; the profile itself is gone.
    }
    return true;
  }

  async listDecisions(
    userSub: string,
    limit?: number,
  ): Promise<DecisionRecord[]> {
    const records = await this.readList(
      this.listFile(userSub, "decisions.json"),
      (data) => {
        const parsed = DecisionRecordSchema.array().safeParse(data);
        return parsed.success ? parsed.data : null;
      },
    );
    return limit === undefined ? records : records.slice(0, limit);
  }

  async saveDecision(
    userSub: string,
    input: NewDecisionRecord,
  ): Promise<DecisionRecord> {
    const file = this.listFile(userSub, "decisions.json");
    const records = await this.listDecisions(userSub);
    const record: DecisionRecord = {
      ...NewDecisionRecordSchema.parse(input),
      id: createRecordId(),
      createdAt: new Date().toISOString(),
    };
    await this.writeJson(file, [record, ...records].slice(0, MAX_DECISIONS));
    return record;
  }

  async listSavedProducts(userSub: string): Promise<SavedProduct[]> {
    return this.readList(this.listFile(userSub, "saved-products.json"), (data) => {
      const parsed = SavedProductSchema.array().safeParse(data);
      return parsed.success ? parsed.data : null;
    });
  }

  async saveSavedProduct(
    userSub: string,
    input: NewSavedProduct,
  ): Promise<SavedProduct> {
    const file = this.listFile(userSub, "saved-products.json");
    const valid = NewSavedProductSchema.parse(input);
    const current = await this.listSavedProducts(userSub);
    const record: SavedProduct = {
      ...valid,
      savedAt: new Date().toISOString(),
    };
    const next = [
      record,
      ...current.filter((item) => item.productId !== valid.productId),
    ].slice(0, MAX_SAVED_PRODUCTS);
    await this.writeJson(file, next);
    return record;
  }

  async deleteSavedProduct(
    userSub: string,
    productId: string,
  ): Promise<boolean> {
    const file = this.listFile(userSub, "saved-products.json");
    const current = await this.listSavedProducts(userSub);
    const next = current.filter((item) => item.productId !== productId);
    if (next.length === current.length) {
      return false;
    }
    await this.writeJson(file, next);
    return true;
  }

  async listSavedComparisons(userSub: string): Promise<SavedComparison[]> {
    return this.readList(
      this.listFile(userSub, "saved-comparisons.json"),
      (data) => {
        const parsed = SavedComparisonSchema.array().safeParse(data);
        return parsed.success ? parsed.data : null;
      },
    );
  }

  async saveSavedComparison(
    userSub: string,
    input: NewSavedComparison,
  ): Promise<SavedComparison> {
    const file = this.listFile(userSub, "saved-comparisons.json");
    const records = await this.listSavedComparisons(userSub);
    const record: SavedComparison = {
      ...NewSavedComparisonSchema.parse(input),
      id: createRecordId(),
      createdAt: new Date().toISOString(),
    };
    await this.writeJson(
      file,
      [record, ...records].slice(0, MAX_SAVED_COMPARISONS),
    );
    return record;
  }

  async deleteSavedComparison(
    userSub: string,
    id: string,
  ): Promise<boolean> {
    const file = this.listFile(userSub, "saved-comparisons.json");
    const current = await this.listSavedComparisons(userSub);
    const next = current.filter((item) => item.id !== id);
    if (next.length === current.length) {
      return false;
    }
    await this.writeJson(file, next);
    return true;
  }

  async listFeedback(
    userSub: string,
    limit?: number,
  ): Promise<Feedback[]> {
    const records = await this.readList(
      this.listFile(userSub, "feedback.json"),
      (data) => {
        const parsed = FeedbackSchema.array().safeParse(data);
        return parsed.success ? parsed.data : null;
      },
    );
    return limit === undefined ? records : records.slice(0, limit);
  }

  async saveFeedback(
    userSub: string,
    input: NewFeedback,
  ): Promise<Feedback> {
    const file = this.listFile(userSub, "feedback.json");
    const records = await this.listFeedback(userSub);
    const record: Feedback = {
      ...NewFeedbackSchema.parse(input),
      id: createRecordId(),
      createdAt: new Date().toISOString(),
    };
    await this.writeJson(file, [record, ...records].slice(0, MAX_FEEDBACK));
    return record;
  }

  async listProposals(userSub: string): Promise<Proposal[]> {
    return this.readList(this.listFile(userSub, "proposals.json"), (data) => {
      const parsed = ProposalSchema.array().safeParse(data);
      return parsed.success ? parsed.data : null;
    });
  }

  async saveProposal(userSub: string, input: NewProposal): Promise<Proposal> {
    const file = this.listFile(userSub, "proposals.json");
    const records = await this.listProposals(userSub);
    const record = ProposalSchema.parse({
      ...input,
      id: createRecordId(),
      createdAt: new Date().toISOString(),
      status: "pending",
    });
    await this.writeJson(file, [record, ...records].slice(0, MAX_PROPOSALS));
    return record;
  }

  async decideProposal(
    userSub: string,
    id: string,
    status: Exclude<ProposalStatus, "pending">,
  ): Promise<Proposal | null> {
    const file = this.listFile(userSub, "proposals.json");
    const records = await this.listProposals(userSub);
    const index = records.findIndex((proposal) => proposal.id === id);
    if (index < 0) {
      return null;
    }
    const current = records[index];
    if (current === undefined || current.status !== "pending") {
      return current ?? null;
    }
    const decided: Proposal = {
      ...current,
      status,
      decidedAt: new Date().toISOString(),
    };
    await this.writeJson(file, [
      ...records.slice(0, index),
      decided,
      ...records.slice(index + 1),
    ]);
    return decided;
  }

  async clearHistory(userSub: string): Promise<{
    decisions: number;
    feedback: number;
    proposals: number;
  }> {
    const [decisions, feedback, proposals] = await Promise.all([
      this.listDecisions(userSub),
      this.listFeedback(userSub),
      this.listProposals(userSub),
    ]);
    await Promise.all(
      ["decisions.json", "feedback.json", "proposals.json"].map((name) =>
        rm(this.listFile(userSub, name), { force: true }),
      ),
    );
    return {
      decisions: decisions.length,
      feedback: feedback.length,
      proposals: proposals.length,
    };
  }

  private observationFile(productId: string): string {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(productId)) {
      throw new StoredDataError(`Unsafe product id: ${productId}`);
    }
    return path.join(this.rootDir, "prices", "observations", `${productId}.json`);
  }

  async recordObservation(
    input: PriceObservation,
  ): Promise<{ recorded: boolean; observation: PriceObservation }> {
    const valid = PriceObservationSchema.parse({
      ...input,
      priceInr: Math.round(input.priceInr),
    });
    const file = this.observationFile(valid.productId);
    const existing = await this.readList(file, (data) => {
      const parsed = PriceObservationSchema.array().safeParse(data);
      return parsed.success ? parsed.data : null;
    });
    const latest = existing[0];
    if (
      latest &&
      latest.priceInr === valid.priceInr &&
      new Date(valid.observedAt).getTime() - new Date(latest.observedAt).getTime() <
        OBS_SAME_PRICE_WINDOW_HOURS * 60 * 60 * 1000
    ) {
      return { recorded: false, observation: latest };
    }
    await this.writeJson(
      file,
      [valid, ...existing].slice(0, MAX_OBSERVATIONS_PER_PRODUCT),
    );
    return { recorded: true, observation: valid };
  }

  async listObservations(
    productId: string,
    limit?: number,
  ): Promise<PriceObservation[]> {
    const records = await this.readList(
      this.observationFile(productId),
      (data) => {
        const parsed = PriceObservationSchema.array().safeParse(data);
        return parsed.success ? parsed.data : null;
      },
    );
    return limit === undefined ? records : records.slice(0, limit);
  }

  private async ensureIdentity(dir: string, userSub: string): Promise<void> {
    await this.writeJson(path.join(dir, "identity.json"), { userSub });
  }

  async listWatches(userSub: string): Promise<Watch[]> {
    return this.readList(this.listFile(userSub, "watches.json"), (data) => {
      const parsed = WatchSchema.array().safeParse(data);
      return parsed.success ? parsed.data : null;
    });
  }

  async getWatch(userSub: string, id: string): Promise<Watch | null> {
    const watches = await this.listWatches(userSub);
    return watches.find((watch) => watch.id === id) ?? null;
  }

  async saveWatch(userSub: string, input: NewWatch): Promise<Watch> {
    const file = this.listFile(userSub, "watches.json");
    const valid = NewWatchSchema.parse(input);
    const current = await this.listWatches(userSub);
    if (
      current.some(
        (watch) =>
          watch.active &&
          watch.productId === valid.productId &&
          watch.targetPrice === valid.targetPrice,
      )
    ) {
      throw new DuplicateWatchError(
        "This product already has an active watch at this target.",
      );
    }
    if (current.length >= MAX_WATCHES) {
      throw new WatchlistFullError(
        `Watchlist is full (${MAX_WATCHES} products). Remove one first.`,
      );
    }
    const record: Watch = {
      ...valid,
      id: createRecordId(),
      createdAt: new Date().toISOString(),
    };
    await this.writeJson(file, [record, ...current]);
    await this.ensureIdentity(this.userDir(userSub), userSub);
    return record;
  }

  async updateWatch(
    userSub: string,
    update: WatchUpdate,
  ): Promise<Watch | null> {
    const file = this.listFile(userSub, "watches.json");
    const current = await this.listWatches(userSub);
    const index = current.findIndex((watch) => watch.id === update.id);
    if (index < 0) {
      return null;
    }
    const found = current[index];
    if (found === undefined) {
      return null;
    }
    const next: Watch = { ...found };
    if (update.targetPrice !== undefined) {
      next.targetPrice = update.targetPrice;
      // A new target is a new question: prior alerts must not suppress it.
      delete next.lastAlertAt;
      delete next.lastAlertedPrice;
    }
    if (update.active !== undefined) {
      next.active = update.active;
    }
    if (update.canWait !== undefined) {
      next.canWait = update.canWait;
    }
    if (update.notifyEmail !== undefined) {
      next.notifyEmail = update.notifyEmail;
    }
    if (update.variantLabel !== undefined) {
      if (update.variantLabel === null) {
        delete next.variantLabel;
      } else {
        next.variantLabel = update.variantLabel;
      }
    }
    const valid = WatchSchema.parse(next);
    await this.writeJson(file, [
      ...current.slice(0, index),
      valid,
      ...current.slice(index + 1),
    ]);
    await this.ensureIdentity(this.userDir(userSub), userSub);
    return valid;
  }

  async deleteWatch(userSub: string, id: string): Promise<boolean> {
    const file = this.listFile(userSub, "watches.json");
    const current = await this.listWatches(userSub);
    const next = current.filter((watch) => watch.id !== id);
    if (next.length === current.length) {
      return false;
    }
    await this.writeJson(file, next);
    return true;
  }

  async updateWatchCheck(
    userSub: string,
    id: string,
    check: WatchCheck,
  ): Promise<Watch | null> {
    const file = this.listFile(userSub, "watches.json");
    const current = await this.listWatches(userSub);
    const index = current.findIndex((watch) => watch.id === id);
    if (index < 0) {
      return null;
    }
    const valid = WatchSchema.parse({ ...current[index], lastCheck: check });
    await this.writeJson(file, [
      ...current.slice(0, index),
      valid,
      ...current.slice(index + 1),
    ]);
    return valid;
  }

  async listAlerts(userSub: string, limit?: number): Promise<PriceAlert[]> {
    const records = await this.readList(
      this.listFile(userSub, "alerts.json"),
      (data) => {
        const parsed = PriceAlertSchema.array().safeParse(data);
        return parsed.success ? parsed.data : null;
      },
    );
    return limit === undefined ? records : records.slice(0, limit);
  }

  async saveAlert(
    userSub: string,
    input: NewPriceAlert,
  ): Promise<PriceAlert> {
    const file = this.listFile(userSub, "alerts.json");
    const records = await this.listAlerts(userSub);
    const record = PriceAlertSchema.parse({
      ...input,
      id: createRecordId(),
      createdAt: new Date().toISOString(),
      currency: "INR",
      read: false,
    });
    await this.writeJson(file, [record, ...records].slice(0, MAX_ALERTS));
    const watches = await this.listWatches(userSub);
    if (watches.some((entry) => entry.id === input.watchId)) {
      await this.writeJson(
        this.listFile(userSub, "watches.json"),
        watches.map((entry) =>
          entry.id === input.watchId
            ? {
                ...entry,
                lastAlertAt: record.createdAt,
                lastAlertedPrice: record.observedPrice,
              }
            : entry,
        ),
      );
    }
    await this.ensureIdentity(this.userDir(userSub), userSub);
    return record;
  }

  async markAlertsRead(
    userSub: string,
    ids: string[] | "all",
  ): Promise<number> {
    const file = this.listFile(userSub, "alerts.json");
    const current = await this.listAlerts(userSub);
    let changed = 0;
    const next = current.map((alert) => {
      if (!alert.read && (ids === "all" || ids.includes(alert.id))) {
        changed += 1;
        return { ...alert, read: true };
      }
      return alert;
    });
    if (changed > 0) {
      await this.writeJson(file, next);
    }
    return changed;
  }

  async updateAlertEmail(
    userSub: string,
    alertId: string,
    email: { attempted: boolean; sent: boolean; error?: string },
  ): Promise<void> {
    const file = this.listFile(userSub, "alerts.json");
    const current = await this.listAlerts(userSub);
    await this.writeJson(
      file,
      current.map((alert) =>
        alert.id === alertId ? { ...alert, email } : alert,
      ),
    );
  }

  async listWatchOwners(): Promise<string[]> {
    const usersDir = path.join(this.rootDir, "users");
    let entries: string[];
    try {
      entries = await readdir(usersDir);
    } catch {
      return [];
    }
    const owners: string[] = [];
    for (const entry of entries) {
      const dir = path.join(usersDir, entry);
      try {
        const watches = await this.readList(
          path.join(dir, "watches.json"),
          (data) => (Array.isArray(data) ? (data as unknown[]) : null),
        );
        if (watches.length === 0) {
          continue;
        }
        const identity = JSON.parse(
          await readFile(path.join(dir, "identity.json"), "utf8"),
        ) as { userSub?: unknown };
        if (typeof identity.userSub === "string" && identity.userSub) {
          owners.push(identity.userSub);
          continue;
        }
      } catch {
        // Fall through to the profile fallback below.
      }
      try {
        const profile = JSON.parse(
          await readFile(path.join(dir, "profile.json"), "utf8"),
        ) as { userSub?: unknown };
        if (typeof profile.userSub === "string" && profile.userSub) {
          owners.push(profile.userSub);
        }
      } catch {
        // Unidentifiable dir — nothing to monitor.
      }
    }
    return owners;
  }

  private async quarantine(file: string): Promise<void> {
    await rename(file, `${file}.corrupt-${Date.now()}`);
  }
}
