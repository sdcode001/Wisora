import type { MemoryStore } from "../memory/store";

export type EmailKind = "price" | "availability" | "reminder";

export interface EmailDecision {
  send: boolean;
  to?: string;
  reason: string;
}

/**
 * Decide whether an opportunity/reminder email may go out. Every trigger
 * sends — there is no daily cap. Skips happen only when the kind is
 * disabled in settings or no address is on file (the scheduler has no
 * session, so per-watch notifyEmail is the only address available).
 */
export async function decideEmail(args: {
  store: MemoryStore;
  userSub: string;
  kind: EmailKind;
  watchId: string | null;
}): Promise<EmailDecision> {
  const { store, userSub, kind, watchId } = args;
  const settings = await store.getNotificationSettings(userSub);
  const prefOff =
    (kind === "price" && !settings.priceEmails) ||
    (kind === "availability" && !settings.availabilityEmails) ||
    (kind === "reminder" && !settings.reminderEmails);
  if (prefOff) {
    return { send: false, reason: `${kind} emails are disabled in settings` };
  }
  const to = watchId
    ? ((await store.getWatch(userSub, watchId))?.notifyEmail ?? null)
    : null;
  if (!to) {
    return { send: false, reason: "no email address on the watch" };
  }
  return { send: true, to, reason: "ok" };
}
