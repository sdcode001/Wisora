import type { MemoryStore } from "../memory/store";
import type { Reminder } from "../memory/records";
import type { Opportunity } from "../opportunities/schema";
import { STALE_OBSERVATION_DAYS } from "../prices/history";
import { formatInr } from "../text/format";

export interface FireRemindersInput {
  store: MemoryStore;
  userSub: string;
  nowMs?: number;
}

export interface FireRemindersResult {
  fired: Reminder[];
  opportunities: Opportunity[];
}

/**
 * Fire due reminders: time-due ones, plus target-price ones whose latest
 * observation is fresh and meets the target. Each firing marks the
 * reminder done (never re-fires) and, for product-bound reminders, files
 * a `reminder-due` opportunity card. No relevance filtering: the user
 * explicitly asked for this nudge.
 */
export async function fireDueReminders(
  input: FireRemindersInput,
): Promise<FireRemindersResult> {
  const { store, userSub } = input;
  const nowMs = input.nowMs ?? Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const result: FireRemindersResult = { fired: [], opportunities: [] };
  const reminders = await store.listReminders(userSub);
  for (const reminder of reminders) {
    if (reminder.status !== "active") {
      continue;
    }
    const timeDue = Number.isFinite(Date.parse(reminder.remindAt))
      ? Date.parse(reminder.remindAt) <= nowMs
      : false;

    let targetMet = false;
    let latestPrice: number | null = null;
    let latestObservedAt: string | null = null;
    if (reminder.targetPriceInr != null && reminder.productId) {
      const latest = (await store.listObservations(reminder.productId, 1))[0];
      if (latest) {
        const ageMs = nowMs - new Date(latest.observedAt).getTime();
        const fresh =
          Number.isFinite(ageMs) &&
          ageMs <= STALE_OBSERVATION_DAYS * 24 * 60 * 60 * 1000;
        if (fresh && latest.priceInr <= reminder.targetPriceInr) {
          targetMet = true;
          latestPrice = latest.priceInr;
          latestObservedAt = latest.observedAt;
        }
      }
    }
    if (!timeDue && !targetMet) {
      continue;
    }

    const fired = await store.updateReminder(userSub, {
      id: reminder.id,
      status: "done",
      firedAt: nowIso,
      firedBecause: targetMet ? "target" : "time",
    });
    if (!fired) {
      continue;
    }
    result.fired.push(fired);

    if (
      reminder.productId &&
      reminder.url &&
      reminder.merchant
    ) {
      const dedupeKey = `reminder-due:${reminder.id}`;
      if (await store.findOpportunityByDedupeKey(userSub, dedupeKey)) {
        continue;
      }
      const reason =
        targetMet && latestPrice != null && reminder.targetPriceInr != null
          ? `Your reminder target was met: now ${formatInr(latestPrice)} ` +
            `(target ${formatInr(reminder.targetPriceInr)}).`
          : reminder.note
            ? `Your reminder fired: ${reminder.note}`
            : "Your reminder fired: time to revisit this decision.";
      const created = await store.saveOpportunity(userSub, {
        kind: "reminder-due",
        dedupeKey,
        ...(reminder.watchId ? { watchId: reminder.watchId } : {}),
        productId: reminder.productId,
        title: reminder.title,
        merchant: reminder.merchant,
        url: reminder.url,
        currentPriceInr: latestPrice,
        previousPriceInr: null,
        targetPriceInr: reminder.targetPriceInr ?? null,
        reason,
        relevance: { score: 50, reasons: [] },
        evidence: {
          source: "reminder",
          observedAt: latestObservedAt ?? nowIso,
        },
      });
      result.opportunities.push(created);
    }
  }
  return result;
}
