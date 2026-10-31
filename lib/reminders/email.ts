import type { Reminder } from "../memory/records";
import type { MemoryStore } from "../memory/store";
import type { Notifier } from "../prices/notify";
import { formatInr } from "../text/format";
import { decideEmail } from "../notify/policy";

export function reminderEmail(reminder: Reminder): {
  subject: string;
  text: string;
} {
  const lines = [
    `Wisora reminder`,
    ``,
    `Reminder: ${reminder.title}`,
  ];
  if (reminder.note) {
    lines.push(`Note: ${reminder.note}`);
  }
  if (reminder.targetPriceInr != null) {
    lines.push(`Target: ${formatInr(reminder.targetPriceInr)} or below`);
  }
  lines.push(
    `Fired: ${reminder.firedAt ?? "now"} (${reminder.firedBecause ?? "time"})`,
  );
  if (reminder.url) {
    lines.push(`Link: ${reminder.url}`);
  }
  lines.push(
    ``,
    `This is a nudge to revisit your decision — not a prediction about ` +
      `prices or availability.`,
  );
  return { subject: `Reminder: ${reminder.title}`, text: lines.join("\n") };
}

/**
 * Email one fired freeform reminder when policy allows (product-bound
 * reminders email through their opportunity card instead). Returns true
 * only when an email went out.
 */
export async function maybeSendReminderEmail(args: {
  store: MemoryStore;
  notifier: Notifier;
  userSub: string;
  reminder: Reminder;
}): Promise<boolean> {
  const { store, notifier, userSub, reminder } = args;
  const fail = async (reason: string): Promise<boolean> => {
    await store.updateReminderEmail(userSub, reminder.id, {
      attempted: false,
      sent: false,
      error: reason.slice(0, 300),
    });
    return false;
  };
  if (!notifier.available) {
    return fail("email is not configured");
  }
  const decision = await decideEmail({
    store,
    userSub,
    kind: "reminder",
    watchId: reminder.watchId ?? null,
  });
  if (!decision.send || !decision.to) {
    return fail(decision.reason);
  }
  const content = reminderEmail(reminder);
  const result = await notifier.sendEmail({ to: decision.to, ...content });
  await store.updateReminderEmail(userSub, reminder.id, {
    attempted: true,
    sent: result.sent,
    ...(result.error ? { error: result.error } : {}),
  });
  return result.sent;
}
