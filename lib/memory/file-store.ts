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
  OpportunitySchema,
  type NewOpportunity,
  type Opportunity,
  type OpportunityStatus,
} from "../opportunities/schema";
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
import {
  MonitorRunSchema,
  type MonitorRun,
  type NewMonitorRun,
} from "../prices/run";
import { UserProfileSchema, type UserProfile } from "./profile";
import {
  ChatThreadSchema,
  DecisionRecordSchema,
  FeedbackSchema,
  NewDecisionRecordSchema,
  NewFeedbackSchema,
  NewReminderSchema,
  NewSavedComparisonSchema,
  NewSavedProductSchema,
  NotificationSettingsSchema,
  ReminderSchema,
  SavedComparisonSchema,
  SavedProductSchema,
  createRecordId,
  defaultNotificationSettings,
  type ChatThread,
  type DecisionRecord,
  type Feedback,
  type NewChatMessage,
  type NewChatThread,
  type NewDecisionRecord,
  type NewFeedback,
  type NewReminder,
  type NewSavedComparison,
  type NewSavedProduct,
  type NotificationSettings,
  type NotificationSettingsPatch,
  type Reminder,
  type ReminderSystemUpdate,
  type ReminderUpdate,
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

/** The per-user reminder cap was reached. */
export class RemindersFullError extends Error {}

/** Growth bounds per record file; oldest entries past the cap drop on write. */
export const MAX_DECISIONS = 50;
export const MAX_FEEDBACK = 100;
export const MAX_SAVED_PRODUCTS = 100;
export const MAX_SAVED_COMPARISONS = 30;
export const MAX_PROPOSALS = 50;
export const MAX_OBSERVATIONS_PER_PRODUCT = 200;
export const MAX_WATCHES = 50;
export const MAX_ALERTS = 100;
export const MAX_OPPORTUNITIES = 100;
export const MAX_MONITOR_RUNS = 50;
export const MAX_REMINDERS = 100;
export const MAX_CHAT_THREADS = 20;
export const MAX_CHAT_MESSAGES = 50;
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

  async listOpportunities(
    userSub: string,
    limit?: number,
  ): Promise<Opportunity[]> {
    const records = await this.readList(
      this.listFile(userSub, "opportunities.json"),
      (data) => {
        const parsed = OpportunitySchema.array().safeParse(data);
        return parsed.success ? parsed.data : null;
      },
    );
    return limit === undefined ? records : records.slice(0, limit);
  }

  async saveOpportunity(
    userSub: string,
    input: NewOpportunity,
  ): Promise<Opportunity> {
    const file = this.listFile(userSub, "opportunities.json");
    const records = await this.listOpportunities(userSub);
    const record = OpportunitySchema.parse({
      ...input,
      id: createRecordId(),
      createdAt: new Date().toISOString(),
      status: "active",
    });
    await this.writeJson(
      file,
      [record, ...records].slice(0, MAX_OPPORTUNITIES),
    );
    await this.ensureIdentity(this.userDir(userSub), userSub);
    return record;
  }

  async updateOpportunityStatus(
    userSub: string,
    id: string,
    status: OpportunityStatus,
  ): Promise<Opportunity | null> {
    const file = this.listFile(userSub, "opportunities.json");
    const records = await this.listOpportunities(userSub);
    const index = records.findIndex((entry) => entry.id === id);
    if (index < 0) {
      return null;
    }
    const current = records[index];
    if (current === undefined) {
      return null;
    }
    const updated: Opportunity = { ...current, status };
    await this.writeJson(file, [
      ...records.slice(0, index),
      updated,
      ...records.slice(index + 1),
    ]);
    return updated;
  }

  async findOpportunityByDedupeKey(
    userSub: string,
    dedupeKey: string,
  ): Promise<Opportunity | null> {
    const records = await this.listOpportunities(userSub);
    return records.find((entry) => entry.dedupeKey === dedupeKey) ?? null;
  }

  async updateOpportunityEmail(
    userSub: string,
    opportunityId: string,
    email: { attempted: boolean; sent: boolean; error?: string },
  ): Promise<void> {
    const file = this.listFile(userSub, "opportunities.json");
    const current = await this.listOpportunities(userSub);
    await this.writeJson(
      file,
      current.map((entry) =>
        entry.id === opportunityId ? { ...entry, email } : entry,
      ),
    );
  }

  async listReminders(userSub: string): Promise<Reminder[]> {
    return this.readList(this.listFile(userSub, "reminders.json"), (data) => {
      const parsed = ReminderSchema.array().safeParse(data);
      return parsed.success ? parsed.data : null;
    });
  }

  async saveReminder(
    userSub: string,
    input: NewReminder,
  ): Promise<Reminder> {
    const file = this.listFile(userSub, "reminders.json");
    const valid = NewReminderSchema.parse(input);
    const current = await this.listReminders(userSub);
    if (current.length >= MAX_REMINDERS) {
      throw new RemindersFullError(
        `Reminder list is full (${MAX_REMINDERS}). Remove one first.`,
      );
    }
    const record: Reminder = {
      ...valid,
      id: createRecordId(),
      createdAt: new Date().toISOString(),
      status: "active",
    };
    await this.writeJson(file, [record, ...current]);
    await this.ensureIdentity(this.userDir(userSub), userSub);
    return record;
  }

  async updateReminder(
    userSub: string,
    update: ReminderUpdate | ReminderSystemUpdate,
  ): Promise<Reminder | null> {
    const file = this.listFile(userSub, "reminders.json");
    const current = await this.listReminders(userSub);
    const index = current.findIndex((entry) => entry.id === update.id);
    if (index < 0) {
      return null;
    }
    const found = current[index];
    if (found === undefined) {
      return null;
    }
    const next: Reminder = { ...found };
    if (update.status !== undefined) {
      next.status = update.status;
      if (update.status !== "done") {
        // Re-arming clears the previous firing record.
        delete next.firedAt;
        delete next.firedBecause;
      }
    }
    if ("firedAt" in update) {
      next.firedAt = update.firedAt;
      next.firedBecause = update.firedBecause;
    }
    if ("title" in update && update.title !== undefined) {
      next.title = update.title;
    }
    if ("remindAt" in update && update.remindAt !== undefined) {
      next.remindAt = update.remindAt;
    }
    if ("timezone" in update && update.timezone !== undefined) {
      next.timezone = update.timezone;
    }
    if ("note" in update && update.note !== undefined) {
      if (update.note === null) {
        delete next.note;
      } else {
        next.note = update.note;
      }
    }
    if ("targetPriceInr" in update && update.targetPriceInr !== undefined) {
      if (update.targetPriceInr === null) {
        delete next.targetPriceInr;
      } else {
        next.targetPriceInr = update.targetPriceInr;
      }
    }
    const valid = ReminderSchema.parse(next);
    await this.writeJson(file, [
      ...current.slice(0, index),
      valid,
      ...current.slice(index + 1),
    ]);
    await this.ensureIdentity(this.userDir(userSub), userSub);
    return valid;
  }

  async deleteReminder(userSub: string, id: string): Promise<boolean> {
    const file = this.listFile(userSub, "reminders.json");
    const current = await this.listReminders(userSub);
    const next = current.filter((entry) => entry.id !== id);
    if (next.length === current.length) {
      return false;
    }
    await this.writeJson(file, next);
    return true;
  }

  async updateReminderEmail(
    userSub: string,
    reminderId: string,
    email: { attempted: boolean; sent: boolean; error?: string },
  ): Promise<void> {
    const file = this.listFile(userSub, "reminders.json");
    const current = await this.listReminders(userSub);
    await this.writeJson(
      file,
      current.map((entry) =>
        entry.id === reminderId ? { ...entry, email } : entry,
      ),
    );
  }

  async getNotificationSettings(
    userSub: string,
  ): Promise<NotificationSettings> {
    const file = this.listFile(userSub, "settings.json");
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return defaultNotificationSettings();
      }
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      await this.quarantine(file);
      return defaultNotificationSettings();
    }
    const valid = NotificationSettingsSchema.safeParse(parsed);
    if (!valid.success) {
      await this.quarantine(file);
      return defaultNotificationSettings();
    }
    return valid.data;
  }

  async saveNotificationSettings(
    userSub: string,
    patch: NotificationSettingsPatch,
  ): Promise<NotificationSettings> {
    const file = this.listFile(userSub, "settings.json");
    const current = await this.getNotificationSettings(userSub);
    const valid = NotificationSettingsSchema.parse({
      ...current,
      ...patch,
      updatedAt: new Date().toISOString(),
    });
    await this.writeJson(file, valid);
    await this.ensureIdentity(this.userDir(userSub), userSub);
    return valid;
  }

  async listChatThreads(userSub: string): Promise<ChatThread[]> {
    return this.readList(this.listFile(userSub, "chat.json"), (data) => {
      const parsed = ChatThreadSchema.array().safeParse(data);
      return parsed.success ? parsed.data : null;
    });
  }

  async getChatThread(
    userSub: string,
    id: string,
  ): Promise<ChatThread | null> {
    const threads = await this.listChatThreads(userSub);
    return threads.find((thread) => thread.id === id) ?? null;
  }

  async createChatThread(
    userSub: string,
    input: NewChatThread,
  ): Promise<ChatThread> {
    const file = this.listFile(userSub, "chat.json");
    const records = await this.listChatThreads(userSub);
    const now = new Date().toISOString();
    const record = ChatThreadSchema.parse({
      id: createRecordId(),
      createdAt: now,
      updatedAt: now,
      title: input.title.slice(0, 120),
      messages: [
        {
          id: createRecordId(),
          role: input.firstMessage.role,
          text: input.firstMessage.text,
          createdAt: now,
        },
      ],
    });
    await this.writeJson(file, [record, ...records].slice(0, MAX_CHAT_THREADS));
    await this.ensureIdentity(this.userDir(userSub), userSub);
    return record;
  }

  async appendChatMessages(
    userSub: string,
    threadId: string,
    messages: NewChatMessage[],
  ): Promise<ChatThread | null> {
    const file = this.listFile(userSub, "chat.json");
    const records = await this.listChatThreads(userSub);
    const index = records.findIndex((thread) => thread.id === threadId);
    if (index < 0) {
      return null;
    }
    const current = records[index];
    if (current === undefined) {
      return null;
    }
    const now = new Date().toISOString();
    const stamped = messages.map((entry) => ({
      id: createRecordId(),
      role: entry.role,
      text: entry.text,
      createdAt: now,
      ...(entry.sources ? { sources: entry.sources } : {}),
    }));
    const updated = ChatThreadSchema.parse({
      ...current,
      updatedAt: now,
      messages: [...current.messages, ...stamped].slice(-MAX_CHAT_MESSAGES),
    });
    await this.writeJson(file, [
      ...records.slice(0, index),
      updated,
      ...records.slice(index + 1),
    ]);
    return updated;
  }

  async deleteChatThread(userSub: string, id: string): Promise<boolean> {
    const file = this.listFile(userSub, "chat.json");
    const current = await this.listChatThreads(userSub);
    const next = current.filter((thread) => thread.id !== id);
    if (next.length === current.length) {
      return false;
    }
    await this.writeJson(file, next);
    return true;
  }

  private monitorRunsFile(): string {
    return path.join(this.rootDir, "prices", "monitor-runs.json");
  }

  async recordMonitorRun(input: NewMonitorRun): Promise<MonitorRun> {
    const file = this.monitorRunsFile();
    const records = await this.listMonitorRuns();
    const record = MonitorRunSchema.parse({
      ...input,
      id: createRecordId(),
    });
    await this.writeJson(file, [record, ...records].slice(0, MAX_MONITOR_RUNS));
    return record;
  }

  async listMonitorRuns(limit?: number): Promise<MonitorRun[]> {
    const records = await this.readList(this.monitorRunsFile(), (data) => {
      const parsed = MonitorRunSchema.array().safeParse(data);
      return parsed.success ? parsed.data : null;
    });
    return limit === undefined ? records : records.slice(0, limit);
  }

  private async userSubForDir(dir: string): Promise<string | null> {
    try {
      const identity = JSON.parse(
        await readFile(path.join(dir, "identity.json"), "utf8"),
      ) as { userSub?: unknown };
      if (typeof identity.userSub === "string" && identity.userSub) {
        return identity.userSub;
      }
    } catch {
      // Fall through to the profile fallback below.
    }
    try {
      const profile = JSON.parse(
        await readFile(path.join(dir, "profile.json"), "utf8"),
      ) as { userSub?: unknown };
      if (typeof profile.userSub === "string" && profile.userSub) {
        return profile.userSub;
      }
    } catch {
      // Unidentifiable dir — nothing to monitor.
    }
    return null;
  }

  private async listUserDirs(): Promise<string[]> {
    const usersDir = path.join(this.rootDir, "users");
    try {
      const entries = await readdir(usersDir);
      return entries.map((entry) => path.join(usersDir, entry));
    } catch {
      return [];
    }
  }

  async listWatchOwners(): Promise<string[]> {
    const owners: string[] = [];
    for (const dir of await this.listUserDirs()) {
      let watches: unknown[];
      try {
        watches = await this.readList(
          path.join(dir, "watches.json"),
          (data) => (Array.isArray(data) ? (data as unknown[]) : null),
        );
      } catch {
        continue;
      }
      if (watches.length === 0) {
        continue;
      }
      const userSub = await this.userSubForDir(dir);
      if (userSub) {
        owners.push(userSub);
      }
    }
    return owners;
  }

  async listReminderOwners(): Promise<string[]> {
    const owners: string[] = [];
    for (const dir of await this.listUserDirs()) {
      let reminders: unknown[];
      try {
        reminders = await this.readList(
          path.join(dir, "reminders.json"),
          (data) => (Array.isArray(data) ? (data as unknown[]) : null),
        );
      } catch {
        continue;
      }
      const hasActive = reminders.some(
        (entry) =>
          typeof entry === "object" &&
          entry !== null &&
          (entry as { status?: unknown }).status === "active",
      );
      if (!hasActive) {
        continue;
      }
      const userSub = await this.userSubForDir(dir);
      if (userSub) {
        owners.push(userSub);
      }
    }
    return owners;
  }

  private async quarantine(file: string): Promise<void> {
    await rename(file, `${file}.corrupt-${Date.now()}`);
  }
}
