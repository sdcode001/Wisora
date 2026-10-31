import type {
  NewOpportunity,
  Opportunity,
  OpportunityStatus,
} from "../opportunities/schema";
import type {
  NewPriceAlert,
  NewWatch,
  PriceAlert,
  PriceObservation,
  Watch,
  WatchCheck,
  WatchUpdate,
} from "../prices/observation";
import type { MonitorRun, NewMonitorRun } from "../prices/run";
import type { UserProfile } from "./profile";
import type {
  ChatThread,
  DecisionRecord,
  Feedback,
  NewChatMessage,
  NewChatThread,
  NewDecisionRecord,
  NewFeedback,
  NewReminder,
  NewSavedComparison,
  NewSavedProduct,
  NotificationSettings,
  NotificationSettingsPatch,
  Reminder,
  ReminderSystemUpdate,
  ReminderUpdate,
  SavedComparison,
  SavedProduct,
} from "./records";
import type { NewProposal, Proposal, ProposalStatus } from "./proposals";

/**
 * Persistence boundary for per-user memory, keyed by the authenticated
 * user's subject (`sub`). Implementations must isolate users: a caller can
 * only ever read or write data for the sub it passes in.
 *
 * Lists return newest-first. Counts bound file growth; oldest entries
 * beyond the cap are dropped on write.
 */
export interface MemoryStore {
  getProfile(userSub: string): Promise<UserProfile | null>;
  saveProfile(profile: UserProfile): Promise<void>;
  clearProfile(userSub: string): Promise<boolean>;

  listDecisions(userSub: string, limit?: number): Promise<DecisionRecord[]>;
  saveDecision(
    userSub: string,
    input: NewDecisionRecord,
  ): Promise<DecisionRecord>;

  listSavedProducts(userSub: string): Promise<SavedProduct[]>;
  /** Save or update by productId (re-saving refreshes the snapshot). */
  saveSavedProduct(
    userSub: string,
    input: NewSavedProduct,
  ): Promise<SavedProduct>;
  deleteSavedProduct(userSub: string, productId: string): Promise<boolean>;

  listSavedComparisons(userSub: string): Promise<SavedComparison[]>;
  saveSavedComparison(
    userSub: string,
    input: NewSavedComparison,
  ): Promise<SavedComparison>;
  deleteSavedComparison(userSub: string, id: string): Promise<boolean>;

  listFeedback(userSub: string, limit?: number): Promise<Feedback[]>;
  saveFeedback(userSub: string, input: NewFeedback): Promise<Feedback>;

  listProposals(userSub: string): Promise<Proposal[]>;
  saveProposal(userSub: string, input: NewProposal): Promise<Proposal>;
  decideProposal(
    userSub: string,
    id: string,
    status: Exclude<ProposalStatus, "pending">,
  ): Promise<Proposal | null>;

  /** Clear decisions, feedback, and proposals (saved items are kept). */
  clearHistory(userSub: string): Promise<{
    decisions: number;
    feedback: number;
    proposals: number;
  }>;

  /**
   * Global price observations (not per-user: prices are facts, and watches
   * are evaluated against them). Same-price observations within the dedup
   * window are skipped — `recorded` tells which happened.
   */
  recordObservation(
    input: PriceObservation,
  ): Promise<{ recorded: boolean; observation: PriceObservation }>;
  listObservations(
    productId: string,
    limit?: number,
  ): Promise<PriceObservation[]>;

  listWatches(userSub: string): Promise<Watch[]>;
  getWatch(userSub: string, id: string): Promise<Watch | null>;
  saveWatch(userSub: string, input: NewWatch): Promise<Watch>;
  updateWatch(userSub: string, update: WatchUpdate): Promise<Watch | null>;
  deleteWatch(userSub: string, id: string): Promise<boolean>;
  updateWatchCheck(
    userSub: string,
    id: string,
    check: WatchCheck,
  ): Promise<Watch | null>;

  listAlerts(userSub: string, limit?: number): Promise<PriceAlert[]>;
  saveAlert(userSub: string, input: NewPriceAlert): Promise<PriceAlert>;
  markAlertsRead(userSub: string, ids: string[] | "all"): Promise<number>;
  updateAlertEmail(
    userSub: string,
    alertId: string,
    email: { attempted: boolean; sent: boolean; error?: string },
  ): Promise<void>;

  listOpportunities(
    userSub: string,
    limit?: number,
  ): Promise<Opportunity[]>;
  saveOpportunity(
    userSub: string,
    input: NewOpportunity,
  ): Promise<Opportunity>;
  updateOpportunityStatus(
    userSub: string,
    id: string,
    status: OpportunityStatus,
  ): Promise<Opportunity | null>;
  findOpportunityByDedupeKey(
    userSub: string,
    dedupeKey: string,
  ): Promise<Opportunity | null>;
  updateOpportunityEmail(
    userSub: string,
    opportunityId: string,
    email: { attempted: boolean; sent: boolean; error?: string },
  ): Promise<void>;

  listReminders(userSub: string): Promise<Reminder[]>;
  saveReminder(userSub: string, input: NewReminder): Promise<Reminder>;
  updateReminder(
    userSub: string,
    update: ReminderUpdate | ReminderSystemUpdate,
  ): Promise<Reminder | null>;
  deleteReminder(userSub: string, id: string): Promise<boolean>;
  updateReminderEmail(
    userSub: string,
    reminderId: string,
    email: { attempted: boolean; sent: boolean; error?: string },
  ): Promise<void>;

  /** Defaults when never saved; reads never write. */
  getNotificationSettings(userSub: string): Promise<NotificationSettings>;
  saveNotificationSettings(
    userSub: string,
    patch: NotificationSettingsPatch,
  ): Promise<NotificationSettings>;

  listChatThreads(userSub: string): Promise<ChatThread[]>;
  getChatThread(userSub: string, id: string): Promise<ChatThread | null>;
  createChatThread(
    userSub: string,
    input: NewChatThread,
  ): Promise<ChatThread>;
  appendChatMessages(
    userSub: string,
    threadId: string,
    messages: NewChatMessage[],
  ): Promise<ChatThread | null>;
  deleteChatThread(userSub: string, id: string): Promise<boolean>;

  /** Global monitor-run log (counts only, no user data). */
  recordMonitorRun(input: NewMonitorRun): Promise<MonitorRun>;
  listMonitorRuns(limit?: number): Promise<MonitorRun[]>;

  /** Owner subs for dirs holding watches (monitor cycle only). */
  listWatchOwners(): Promise<string[]>;

  /** Owner subs for dirs holding active reminders (monitor cycle only). */
  listReminderOwners(): Promise<string[]>;
}
