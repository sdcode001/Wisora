import type { Collection, Db, Filter } from "mongodb";
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
import {
  DuplicateWatchError,
  MAX_ALERTS,
  MAX_CHAT_MESSAGES,
  MAX_CHAT_THREADS,
  MAX_DECISIONS,
  MAX_FEEDBACK,
  MAX_MONITOR_RUNS,
  MAX_OBSERVATIONS_PER_PRODUCT,
  MAX_OPPORTUNITIES,
  MAX_PROPOSALS,
  MAX_REMINDERS,
  MAX_SAVED_COMPARISONS,
  MAX_SAVED_PRODUCTS,
  MAX_WATCHES,
  OBS_SAME_PRICE_WINDOW_HOURS,
  RemindersFullError,
  WatchlistFullError,
} from "./file-store";
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

/** Stored docs: driver ObjectIds, except profiles/settings keyed by sub. */
interface StoreDocument {
  _id?: unknown;
  [key: string]: unknown;
}

/** Profiles/settings are keyed by sub string; the driver expects ObjectId. */
function byId(id: string): Filter<StoreDocument> {
  return { _id: id } as unknown as Filter<StoreDocument>;
}

/**
 * Mongo-backed MemoryStore with the same contract as the file store:
 * per-user isolation by `userSub`, newest-first lists, growth caps applied
 * on write, and zod validation on every read (invalid docs are skipped).
 *
 * Ordering uses the ObjectId (`_id`) recency, which matches insertion
 * order exactly like the file store's prepend-on-write lists.
 */
export class MongoMemoryStore implements MemoryStore {
  constructor(private readonly db: Db) {}

  private col(name: string): Collection<StoreDocument> {
    return this.db.collection<StoreDocument>(name);
  }

  private async listNewestFirst<T>(
    name: string,
    filter: Filter<StoreDocument>,
    parse: (doc: unknown) => T | null,
    limit?: number,
  ): Promise<T[]> {
    const cursor = this.col(name).find(filter).sort({ _id: -1 });
    const docs =
      limit === undefined ? await cursor.toArray() : await cursor.limit(limit).toArray();
    const out: T[] = [];
    for (const doc of docs) {
      const parsed = parse(doc);
      if (parsed) {
        out.push(parsed);
      }
    }
    return out;
  }

  /** Delete oldest docs past `keep` under `filter` (insertion order). */
  private async prune(
    name: string,
    filter: Filter<StoreDocument>,
    keep: number,
  ): Promise<void> {
    const count = await this.col(name).countDocuments(filter);
    const over = count - keep;
    if (over <= 0) {
      return;
    }
    const oldest = await this.col(name)
      .find(filter)
      .sort({ _id: 1 })
      .limit(over)
      .toArray();
    const ids = oldest.map((doc) => doc._id);
    if (ids.length > 0) {
      await this.col(name).deleteMany({ _id: { $in: ids } });
    }
  }

  async getProfile(userSub: string): Promise<UserProfile | null> {
    const doc = await this.col("profiles").findOne(byId(userSub));
    if (!doc) {
      return null;
    }
    if ((doc as { version?: unknown }).version !== 1) {
      throw new Error(`Unsupported profile version for ${userSub}`);
    }
    const valid = UserProfileSchema.safeParse(doc);
    if (!valid.success) {
      return null;
    }
    if (valid.data.userSub !== userSub) {
      throw new Error(`Profile identity mismatch for ${userSub}`);
    }
    return valid.data;
  }

  async saveProfile(profile: UserProfile): Promise<void> {
    const valid = UserProfileSchema.parse(profile);
    await this.col("profiles").updateOne(
      byId(valid.userSub),
      { $set: { ...valid, _id: valid.userSub } },
      { upsert: true },
    );
  }

  async clearProfile(userSub: string): Promise<boolean> {
    const result = await this.col("profiles").deleteOne(byId(userSub));
    return result.deletedCount > 0;
  }

  async listDecisions(
    userSub: string,
    limit?: number,
  ): Promise<DecisionRecord[]> {
    return this.listNewestFirst(
      "decisions",
      { userSub },
      (doc) => {
        const parsed = DecisionRecordSchema.safeParse(doc);
        return parsed.success ? parsed.data : null;
      },
      limit,
    );
  }

  async saveDecision(
    userSub: string,
    input: NewDecisionRecord,
  ): Promise<DecisionRecord> {
    const record: DecisionRecord = {
      ...NewDecisionRecordSchema.parse(input),
      id: createRecordId(),
      createdAt: new Date().toISOString(),
    };
    await this.col("decisions").insertOne({ ...record, userSub });
    await this.prune("decisions", { userSub }, MAX_DECISIONS);
    return record;
  }

  async listSavedProducts(userSub: string): Promise<SavedProduct[]> {
    return this.listNewestFirst("savedProducts", { userSub }, (doc) => {
      const parsed = SavedProductSchema.safeParse(doc);
      return parsed.success ? parsed.data : null;
    });
  }

  async saveSavedProduct(
    userSub: string,
    input: NewSavedProduct,
  ): Promise<SavedProduct> {
    const valid = NewSavedProductSchema.parse(input);
    const record: SavedProduct = {
      ...valid,
      savedAt: new Date().toISOString(),
    };
    await this.col("savedProducts").deleteMany({
      userSub,
      productId: valid.productId,
    });
    await this.col("savedProducts").insertOne({ ...record, userSub });
    await this.prune("savedProducts", { userSub }, MAX_SAVED_PRODUCTS);
    return record;
  }

  async deleteSavedProduct(
    userSub: string,
    productId: string,
  ): Promise<boolean> {
    const result = await this.col("savedProducts").deleteMany({
      userSub,
      productId,
    });
    return result.deletedCount > 0;
  }

  async listSavedComparisons(userSub: string): Promise<SavedComparison[]> {
    return this.listNewestFirst("savedComparisons", { userSub }, (doc) => {
      const parsed = SavedComparisonSchema.safeParse(doc);
      return parsed.success ? parsed.data : null;
    });
  }

  async saveSavedComparison(
    userSub: string,
    input: NewSavedComparison,
  ): Promise<SavedComparison> {
    const record: SavedComparison = {
      ...NewSavedComparisonSchema.parse(input),
      id: createRecordId(),
      createdAt: new Date().toISOString(),
    };
    await this.col("savedComparisons").insertOne({ ...record, userSub });
    await this.prune("savedComparisons", { userSub }, MAX_SAVED_COMPARISONS);
    return record;
  }

  async deleteSavedComparison(
    userSub: string,
    id: string,
  ): Promise<boolean> {
    const result = await this.col("savedComparisons").deleteOne({
      userSub,
      id,
    });
    return result.deletedCount > 0;
  }

  async listFeedback(
    userSub: string,
    limit?: number,
  ): Promise<Feedback[]> {
    return this.listNewestFirst(
      "feedback",
      { userSub },
      (doc) => {
        const parsed = FeedbackSchema.safeParse(doc);
        return parsed.success ? parsed.data : null;
      },
      limit,
    );
  }

  async saveFeedback(
    userSub: string,
    input: NewFeedback,
  ): Promise<Feedback> {
    const record: Feedback = {
      ...NewFeedbackSchema.parse(input),
      id: createRecordId(),
      createdAt: new Date().toISOString(),
    };
    await this.col("feedback").insertOne({ ...record, userSub });
    await this.prune("feedback", { userSub }, MAX_FEEDBACK);
    return record;
  }

  async listProposals(userSub: string): Promise<Proposal[]> {
    return this.listNewestFirst("proposals", { userSub }, (doc) => {
      const parsed = ProposalSchema.safeParse(doc);
      return parsed.success ? parsed.data : null;
    });
  }

  async saveProposal(userSub: string, input: NewProposal): Promise<Proposal> {
    const record = ProposalSchema.parse({
      ...input,
      id: createRecordId(),
      createdAt: new Date().toISOString(),
      status: "pending",
    });
    await this.col("proposals").insertOne({ ...record, userSub });
    await this.prune("proposals", { userSub }, MAX_PROPOSALS);
    return record;
  }

  async decideProposal(
    userSub: string,
    id: string,
    status: Exclude<ProposalStatus, "pending">,
  ): Promise<Proposal | null> {
    const doc = await this.col("proposals").findOne({ userSub, id });
    const current = doc ? ProposalSchema.safeParse(doc) : null;
    if (!current?.success) {
      return null;
    }
    if (current.data.status !== "pending") {
      return current.data;
    }
    const decided: Proposal = {
      ...current.data,
      status,
      decidedAt: new Date().toISOString(),
    };
    await this.col("proposals").updateOne(
      { userSub, id },
      { $set: decided },
    );
    return decided;
  }

  async clearHistory(userSub: string): Promise<{
    decisions: number;
    feedback: number;
    proposals: number;
  }> {
    const [decisions, feedback, proposals] = await Promise.all([
      this.col("decisions").deleteMany({ userSub }),
      this.col("feedback").deleteMany({ userSub }),
      this.col("proposals").deleteMany({ userSub }),
    ]);
    return {
      decisions: decisions.deletedCount,
      feedback: feedback.deletedCount,
      proposals: proposals.deletedCount,
    };
  }

  async recordObservation(
    input: PriceObservation,
  ): Promise<{ recorded: boolean; observation: PriceObservation }> {
    const valid = PriceObservationSchema.parse({
      ...input,
      priceInr: Math.round(input.priceInr),
    });
    const docs = await this.col("observations")
      .find({ productId: valid.productId })
      .sort({ _id: -1 })
      .limit(1)
      .toArray();
    const latest = docs[0]
      ? PriceObservationSchema.safeParse(docs[0])
      : null;
    if (
      latest?.success &&
      latest.data.priceInr === valid.priceInr &&
      new Date(valid.observedAt).getTime() -
        new Date(latest.data.observedAt).getTime() <
        OBS_SAME_PRICE_WINDOW_HOURS * 60 * 60 * 1000
    ) {
      return { recorded: false, observation: latest.data };
    }
    await this.col("observations").insertOne({ ...valid });
    await this.prune(
      "observations",
      { productId: valid.productId },
      MAX_OBSERVATIONS_PER_PRODUCT,
    );
    return { recorded: true, observation: valid };
  }

  async listObservations(
    productId: string,
    limit?: number,
  ): Promise<PriceObservation[]> {
    return this.listNewestFirst(
      "observations",
      { productId },
      (doc) => {
        const parsed = PriceObservationSchema.safeParse(doc);
        return parsed.success ? parsed.data : null;
      },
      limit,
    );
  }

  async listWatches(userSub: string): Promise<Watch[]> {
    return this.listNewestFirst("watches", { userSub }, (doc) => {
      const parsed = WatchSchema.safeParse(doc);
      return parsed.success ? parsed.data : null;
    });
  }

  async getWatch(userSub: string, id: string): Promise<Watch | null> {
    const doc = await this.col("watches").findOne({ userSub, id });
    if (!doc) {
      return null;
    }
    const parsed = WatchSchema.safeParse(doc);
    return parsed.success ? parsed.data : null;
  }

  async saveWatch(userSub: string, input: NewWatch): Promise<Watch> {
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
    await this.col("watches").insertOne({ ...record, userSub });
    return record;
  }

  async updateWatch(
    userSub: string,
    update: WatchUpdate,
  ): Promise<Watch | null> {
    const found = await this.getWatch(userSub, update.id);
    if (!found) {
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
    // Full-document replace (same _id kept): dropped keys disappear, so a
    // retarget clears the prior alert fields exactly like the file store.
    await this.col("watches").replaceOne(
      { userSub, id: update.id },
      { ...valid, userSub },
    );
    return valid;
  }

  async deleteWatch(userSub: string, id: string): Promise<boolean> {
    const result = await this.col("watches").deleteOne({ userSub, id });
    return result.deletedCount > 0;
  }

  async updateWatchCheck(
    userSub: string,
    id: string,
    check: WatchCheck,
  ): Promise<Watch | null> {
    const found = await this.getWatch(userSub, id);
    if (!found) {
      return null;
    }
    const valid = WatchSchema.parse({ ...found, lastCheck: check });
    await this.col("watches").updateOne(
      { userSub, id },
      { $set: { lastCheck: valid.lastCheck } },
    );
    return valid;
  }

  async listAlerts(userSub: string, limit?: number): Promise<PriceAlert[]> {
    return this.listNewestFirst(
      "alerts",
      { userSub },
      (doc) => {
        const parsed = PriceAlertSchema.safeParse(doc);
        return parsed.success ? parsed.data : null;
      },
      limit,
    );
  }

  async saveAlert(
    userSub: string,
    input: NewPriceAlert,
  ): Promise<PriceAlert> {
    const record = PriceAlertSchema.parse({
      ...input,
      id: createRecordId(),
      createdAt: new Date().toISOString(),
      currency: "INR",
      read: false,
    });
    await this.col("alerts").insertOne({ ...record, userSub });
    await this.prune("alerts", { userSub }, MAX_ALERTS);
    await this.col("watches").updateOne(
      { userSub, id: input.watchId },
      {
        $set: {
          lastAlertAt: record.createdAt,
          lastAlertedPrice: record.observedPrice,
        },
      },
    );
    return record;
  }

  async markAlertsRead(
    userSub: string,
    ids: string[] | "all",
  ): Promise<number> {
    const filter: Filter<StoreDocument> =
      ids === "all"
        ? { userSub, read: false }
        : { userSub, read: false, id: { $in: ids } };
    const result = await this.col("alerts").updateMany(filter, {
      $set: { read: true },
    });
    return result.modifiedCount;
  }

  async updateAlertEmail(
    userSub: string,
    alertId: string,
    email: { attempted: boolean; sent: boolean; error?: string },
  ): Promise<void> {
    await this.col("alerts").updateOne(
      { userSub, id: alertId },
      { $set: { email } },
    );
  }

  async listOpportunities(
    userSub: string,
    limit?: number,
  ): Promise<Opportunity[]> {
    return this.listNewestFirst(
      "opportunities",
      { userSub },
      (doc) => {
        const parsed = OpportunitySchema.safeParse(doc);
        return parsed.success ? parsed.data : null;
      },
      limit,
    );
  }

  async saveOpportunity(
    userSub: string,
    input: NewOpportunity,
  ): Promise<Opportunity> {
    const record = OpportunitySchema.parse({
      ...input,
      id: createRecordId(),
      createdAt: new Date().toISOString(),
      status: "active",
    });
    await this.col("opportunities").insertOne({ ...record, userSub });
    await this.prune("opportunities", { userSub }, MAX_OPPORTUNITIES);
    return record;
  }

  async updateOpportunityStatus(
    userSub: string,
    id: string,
    status: OpportunityStatus,
  ): Promise<Opportunity | null> {
    const doc = await this.col("opportunities").findOne({ userSub, id });
    const current = doc ? OpportunitySchema.safeParse(doc) : null;
    if (!current?.success) {
      return null;
    }
    const updated: Opportunity = { ...current.data, status };
    await this.col("opportunities").updateOne(
      { userSub, id },
      { $set: { status } },
    );
    return updated;
  }

  async findOpportunityByDedupeKey(
    userSub: string,
    dedupeKey: string,
  ): Promise<Opportunity | null> {
    const doc = await this.col("opportunities").findOne({
      userSub,
      dedupeKey,
    });
    if (!doc) {
      return null;
    }
    const parsed = OpportunitySchema.safeParse(doc);
    return parsed.success ? parsed.data : null;
  }

  async updateOpportunityEmail(
    userSub: string,
    opportunityId: string,
    email: { attempted: boolean; sent: boolean; error?: string },
  ): Promise<void> {
    await this.col("opportunities").updateOne(
      { userSub, id: opportunityId },
      { $set: { email } },
    );
  }

  async listReminders(userSub: string): Promise<Reminder[]> {
    return this.listNewestFirst("reminders", { userSub }, (doc) => {
      const parsed = ReminderSchema.safeParse(doc);
      return parsed.success ? parsed.data : null;
    });
  }

  async saveReminder(
    userSub: string,
    input: NewReminder,
  ): Promise<Reminder> {
    const valid = NewReminderSchema.parse(input);
    const count = await this.col("reminders").countDocuments({ userSub });
    if (count >= MAX_REMINDERS) {
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
    await this.col("reminders").insertOne({ ...record, userSub });
    return record;
  }

  async updateReminder(
    userSub: string,
    update: ReminderUpdate | ReminderSystemUpdate,
  ): Promise<Reminder | null> {
    const doc = await this.col("reminders").findOne({
      userSub,
      id: update.id,
    });
    const found = doc ? ReminderSchema.safeParse(doc) : null;
    if (!found?.success) {
      return null;
    }
    const next: Reminder = { ...found.data };
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
    // Full-document replace (same _id kept): cleared fields disappear,
    // matching the file store's delete-then-write semantics.
    await this.col("reminders").replaceOne(
      { userSub, id: update.id },
      { ...valid, userSub },
    );
    return valid;
  }

  async deleteReminder(userSub: string, id: string): Promise<boolean> {
    const result = await this.col("reminders").deleteOne({ userSub, id });
    return result.deletedCount > 0;
  }

  async updateReminderEmail(
    userSub: string,
    reminderId: string,
    email: { attempted: boolean; sent: boolean; error?: string },
  ): Promise<void> {
    await this.col("reminders").updateOne(
      { userSub, id: reminderId },
      { $set: { email } },
    );
  }

  async getNotificationSettings(
    userSub: string,
  ): Promise<NotificationSettings> {
    const doc = await this.col("settings").findOne(byId(userSub));
    if (!doc) {
      return defaultNotificationSettings();
    }
    const valid = NotificationSettingsSchema.safeParse(doc);
    return valid.success ? valid.data : defaultNotificationSettings();
  }

  async saveNotificationSettings(
    userSub: string,
    patch: NotificationSettingsPatch,
  ): Promise<NotificationSettings> {
    const current = await this.getNotificationSettings(userSub);
    const valid = NotificationSettingsSchema.parse({
      ...current,
      ...patch,
      updatedAt: new Date().toISOString(),
    });
    await this.col("settings").updateOne(
      byId(userSub),
      { $set: { ...valid, _id: userSub } },
      { upsert: true },
    );
    return valid;
  }

  async listChatThreads(userSub: string): Promise<ChatThread[]> {
    return this.listNewestFirst("chatThreads", { userSub }, (doc) => {
      const parsed = ChatThreadSchema.safeParse(doc);
      return parsed.success ? parsed.data : null;
    });
  }

  async getChatThread(
    userSub: string,
    id: string,
  ): Promise<ChatThread | null> {
    const doc = await this.col("chatThreads").findOne({ userSub, id });
    if (!doc) {
      return null;
    }
    const parsed = ChatThreadSchema.safeParse(doc);
    return parsed.success ? parsed.data : null;
  }

  async createChatThread(
    userSub: string,
    input: NewChatThread,
  ): Promise<ChatThread> {
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
    await this.col("chatThreads").insertOne({ ...record, userSub });
    await this.prune("chatThreads", { userSub }, MAX_CHAT_THREADS);
    return record;
  }

  async appendChatMessages(
    userSub: string,
    threadId: string,
    messages: NewChatMessage[],
  ): Promise<ChatThread | null> {
    const found = await this.getChatThread(userSub, threadId);
    if (!found) {
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
      ...found,
      updatedAt: now,
      messages: [...found.messages, ...stamped].slice(-MAX_CHAT_MESSAGES),
    });
    await this.col("chatThreads").updateOne(
      { userSub, id: threadId },
      { $set: { updatedAt: now, messages: updated.messages } },
    );
    return updated;
  }

  async deleteChatThread(userSub: string, id: string): Promise<boolean> {
    const result = await this.col("chatThreads").deleteOne({ userSub, id });
    return result.deletedCount > 0;
  }

  async recordMonitorRun(input: NewMonitorRun): Promise<MonitorRun> {
    const record = MonitorRunSchema.parse({
      ...input,
      id: createRecordId(),
    });
    await this.col("monitorRuns").insertOne({ ...record });
    await this.prune("monitorRuns", {}, MAX_MONITOR_RUNS);
    return record;
  }

  async listMonitorRuns(limit?: number): Promise<MonitorRun[]> {
    return this.listNewestFirst(
      "monitorRuns",
      {},
      (doc) => {
        const parsed = MonitorRunSchema.safeParse(doc);
        return parsed.success ? parsed.data : null;
      },
      limit,
    );
  }

  async listWatchOwners(): Promise<string[]> {
    const owners = await this.col("watches").distinct("userSub", {});
    return owners.filter(
      (owner): owner is string => typeof owner === "string",
    );
  }

  async listReminderOwners(): Promise<string[]> {
    const owners = await this.col("reminders").distinct("userSub", {
      status: "active",
    });
    return owners.filter(
      (owner): owner is string => typeof owner === "string",
    );
  }
}
