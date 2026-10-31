import { randomBytes } from "node:crypto";
import { z } from "zod";
import { CategorySchema } from "../../config/sources";
import { BudgetRangeSchema } from "./profile";

/** Storage-assigned identity for memory records. */
export function createRecordId(): string {
  return randomBytes(12).toString("hex");
}

const StoredIdentity = {
  id: z.string().min(1).max(64),
  createdAt: z.string().min(1),
};

export const VerdictSchema = z.enum([
  "BUY",
  "WAIT",
  "AVOID",
  "INSUFFICIENT_EVIDENCE",
  "NEEDS_CLARIFICATION",
]);
export type Verdict = z.infer<typeof VerdictSchema>;

// --- Decisions: snapshots of past recommendations. ---

export const DecisionTopPickSchema = z.object({
  productId: z.string().min(1).max(64),
  title: z.string().min(1).max(500),
  merchant: z.string().min(1).max(120),
  priceInr: z.number().nonnegative().max(100_000_000).optional(),
});
export type DecisionTopPick = z.infer<typeof DecisionTopPickSchema>;

export const DecisionRecordSchema = z.object({
  ...StoredIdentity,
  query: z.string().trim().min(2).max(500),
  category: CategorySchema,
  budgetInr: BudgetRangeSchema.optional(),
  topPick: DecisionTopPickSchema.nullable(),
  verdict: VerdictSchema,
  personalizationApplied: z.array(z.string().max(300)).max(20).optional(),
});
export type DecisionRecord = z.infer<typeof DecisionRecordSchema>;

export const NewDecisionRecordSchema = DecisionRecordSchema.omit({
  id: true,
  createdAt: true,
});
export type NewDecisionRecord = z.infer<typeof NewDecisionRecordSchema>;

// --- Saved products: explicit keepsakes, keyed by productId (re-save upserts). ---

export const SavedProductSchema = z.object({
  productId: z.string().min(1).max(64),
  title: z.string().min(1).max(500),
  url: z.string().url().max(2000),
  merchant: z.string().min(1).max(120),
  priceInr: z.number().nonnegative().max(100_000_000).optional(),
  imageUrl: z.string().url().max(2000).optional(),
  note: z.string().trim().min(1).max(300).optional(),
  savedAt: z.string().min(1),
  sourceDecisionId: z.string().min(1).max(64).optional(),
});
export type SavedProduct = z.infer<typeof SavedProductSchema>;

export const NewSavedProductSchema = SavedProductSchema.omit({ savedAt: true });
export type NewSavedProduct = z.infer<typeof NewSavedProductSchema>;

// --- Saved comparisons: self-contained product sets (2–6 snapshots). ---

export const ComparisonProductSchema = z.object({
  productId: z.string().min(1).max(64),
  title: z.string().min(1).max(500),
  merchant: z.string().min(1).max(120),
  priceInr: z.number().nonnegative().max(100_000_000).optional(),
  url: z.string().url().max(2000).optional(),
});
export type ComparisonProduct = z.infer<typeof ComparisonProductSchema>;

export const SavedComparisonSchema = z.object({
  ...StoredIdentity,
  category: CategorySchema,
  query: z.string().trim().min(1).max(500).optional(),
  products: z.array(ComparisonProductSchema).min(2).max(6),
  note: z.string().trim().min(1).max(500).optional(),
});
export type SavedComparison = z.infer<typeof SavedComparisonSchema>;

export const NewSavedComparisonSchema = SavedComparisonSchema.omit({
  id: true,
  createdAt: true,
});
export type NewSavedComparison = z.infer<typeof NewSavedComparisonSchema>;

// --- Feedback: user reactions to recommendations. Product references carry
// --- their own snapshots so feedback stays interpretable without joins. ---

export const FeedbackProductSchema = z.object({
  productId: z.string().min(1).max(64),
  title: z.string().min(1).max(500),
  merchant: z.string().min(1).max(120).optional(),
});
export type FeedbackProduct = z.infer<typeof FeedbackProductSchema>;

const FeedbackBase = z.object({
  ...StoredIdentity,
  decisionId: z.string().min(1).max(64).nullable().optional(),
  helpful: z.boolean().nullable().optional(),
  preferred: FeedbackProductSchema.nullable().optional(),
  rejected: FeedbackProductSchema.nullable().optional(),
  rejectionReason: z.string().trim().min(1).max(500).optional(),
  purchased: FeedbackProductSchema.nullable().optional(),
  note: z.string().trim().min(1).max(500).optional(),
});

function hasSignal(value: {
  helpful?: boolean | null;
  preferred?: unknown;
  rejected?: unknown;
  purchased?: unknown;
  note?: string | null;
}): boolean {
  return (
    value.helpful != null ||
    value.preferred != null ||
    value.rejected != null ||
    value.purchased != null ||
    value.note != null
  );
}

export const FeedbackSchema = FeedbackBase.refine(hasSignal, {
  message: "feedback must include at least one signal",
});
export type Feedback = z.infer<typeof FeedbackSchema>;

export const NewFeedbackSchema = FeedbackBase.omit({
  id: true,
  createdAt: true,
}).refine(hasSignal, {
  message: "feedback must include at least one signal",
});
export type NewFeedback = z.infer<typeof NewFeedbackSchema>;

// --- Reminders: user requests to revisit a decision. A reminder fires once
// --- (time due and/or target met), never predicts, and never re-fires. ---

export const ReminderStatusSchema = z.enum(["active", "done", "disabled"]);
export type ReminderStatus = z.infer<typeof ReminderStatusSchema>;

function isParseableDate(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

function isIANATimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

const ReminderBase = z.object({
  ...StoredIdentity,
  // 500 matches the listing title cap: any feed card prefills a reminder.
  title: z.string().trim().min(1).max(500),
  url: z.string().url().max(2000).optional(),
  merchant: z.string().min(1).max(120).optional(),
  productId: z.string().min(1).max(64).optional(),
  watchId: z.string().min(1).max(64).optional(),
  kind: z.literal("one-time"),
  remindAt: z.string().min(1),
  timezone: z.string().min(1).max(64),
  note: z.string().trim().min(1).max(500).optional(),
  targetPriceInr: z.number().positive().max(100_000_000).optional(),
  status: ReminderStatusSchema,
  firedAt: z.string().min(1).optional(),
  firedBecause: z.enum(["time", "target"]).optional(),
  email: z
    .object({
      attempted: z.boolean(),
      sent: z.boolean(),
      error: z.string().max(300).optional(),
    })
    .optional(),
});

export const ReminderSchema = ReminderBase;
export type Reminder = z.infer<typeof ReminderSchema>;

export const NewReminderSchema = ReminderBase.omit({
  id: true,
  createdAt: true,
  status: true,
  firedAt: true,
  firedBecause: true,
})
  .extend({
    kind: z.literal("one-time").default("one-time"),
    timezone: z.string().min(1).max(64).default("UTC"),
  })
  .refine((value) => isParseableDate(value.remindAt), {
    message: "remindAt must be a parseable date",
  })
  .refine((value) => isIANATimezone(value.timezone), {
    message: "timezone must be a valid IANA name",
  });
export type NewReminder = z.infer<typeof NewReminderSchema>;

export const ReminderUpdateSchema = z
  .object({
    id: z.string().min(1).max(64),
    title: z.string().trim().min(1).max(500).optional(),
    remindAt: z.string().min(1).optional(),
    timezone: z.string().min(1).max(64).optional(),
    note: z.string().trim().min(1).max(500).nullable().optional(),
    targetPriceInr: z.number().positive().max(100_000_000).nullable().optional(),
    status: ReminderStatusSchema.optional(),
  })
  .refine(
    (value) => value.remindAt === undefined || isParseableDate(value.remindAt),
    { message: "remindAt must be a parseable date" },
  )
  .refine(
    (value) => value.timezone === undefined || isIANATimezone(value.timezone),
    { message: "timezone must be a valid IANA name" },
  );
export type ReminderUpdate = z.infer<typeof ReminderUpdateSchema>;

/** System-only transition when a reminder fires (never user-settable). */
export const ReminderSystemUpdateSchema = z.object({
  id: z.string().min(1).max(64),
  status: z.literal("done"),
  firedAt: z.string().min(1),
  firedBecause: z.enum(["time", "target"]),
});
export type ReminderSystemUpdate = z.infer<typeof ReminderSystemUpdateSchema>;

// --- Notification settings: user control over proactive behavior. ---

export const NotificationSettingsSchema = z.object({
  proactiveEnabled: z.boolean().default(true),
  priceEmails: z.boolean().default(true),
  availabilityEmails: z.boolean().default(true),
  reminderEmails: z.boolean().default(true),
  updatedAt: z.string().min(1).optional(),
});
export type NotificationSettings = z.infer<typeof NotificationSettingsSchema>;

export const NotificationSettingsPatchSchema =
  NotificationSettingsSchema.omit({ updatedAt: true }).partial();
export type NotificationSettingsPatch = z.infer<
  typeof NotificationSettingsPatchSchema
>;

export function defaultNotificationSettings(): NotificationSettings {
  return {
    proactiveEnabled: true,
    priceEmails: true,
    availabilityEmails: true,
    reminderEmails: true,
  };
}

// --- Chat threads: persisted assistant conversations. ---

export const ChatSourceSchema = z.object({
  label: z.string().min(1).max(200),
  url: z.string().url().max(2000).optional(),
});
export type ChatSource = z.infer<typeof ChatSourceSchema>;

export const ChatMessageSchema = z.object({
  id: z.string().min(1).max(64),
  role: z.enum(["user", "assistant"]),
  text: z.string().min(1).max(4000),
  createdAt: z.string().min(1),
  sources: z.array(ChatSourceSchema).max(8).optional(),
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

export const ChatThreadSchema = z.object({
  ...StoredIdentity,
  title: z.string().min(1).max(120),
  updatedAt: z.string().min(1),
  messages: z.array(ChatMessageSchema).max(60),
});
export type ChatThread = z.infer<typeof ChatThreadSchema>;

export interface NewChatThread {
  title: string;
  firstMessage: { role: "user"; text: string };
}

export interface NewChatMessage {
  role: "user" | "assistant";
  text: string;
  sources?: ChatSource[];
}
