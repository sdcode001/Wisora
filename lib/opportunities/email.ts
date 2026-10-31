import type { MemoryStore } from "../memory/store";
import type { Notifier } from "../prices/notify";
import { formatInr } from "../text/format";
import { decideEmail, type EmailKind } from "../notify/policy";
import type { Opportunity, OpportunityKind } from "./schema";

const KIND_EMAIL: Record<OpportunityKind, EmailKind> = {
  "target-reached": "price",
  "price-drop": "price",
  "price-increase": "price",
  "back-in-range": "price",
  restored: "availability",
  unavailable: "availability",
  "reminder-due": "reminder",
};

function subjectFor(opportunity: Opportunity): string {
  const title = opportunity.title;
  const current =
    opportunity.currentPriceInr != null
      ? formatInr(opportunity.currentPriceInr)
      : null;
  switch (opportunity.kind) {
    case "target-reached":
      return `Target reached: ${title} at ${current ?? "your target"}`;
    case "price-drop":
      return `Price drop: ${title} now ${current ?? "lower"}`;
    case "price-increase":
      return `Price increase: ${title} now ${current ?? "higher"}`;
    case "back-in-range":
      return `Back in range: ${title} at ${current ?? "a good price"}`;
    case "restored":
      return `Back available: ${title}`;
    case "unavailable":
      return `Unavailable: ${title}`;
    case "reminder-due":
      return `Reminder: ${title}`;
  }
}

export function opportunityEmail(opportunity: Opportunity): {
  subject: string;
  text: string;
} {
  const lines = [
    `Wisora opportunity: ${opportunity.kind}`,
    ``,
    `Product: ${opportunity.title}`,
    `Merchant: ${opportunity.merchant}`,
  ];
  if (opportunity.currentPriceInr != null) {
    lines.push(`Current price: ${formatInr(opportunity.currentPriceInr)}`);
  }
  if (opportunity.previousPriceInr != null) {
    lines.push(`Previous price: ${formatInr(opportunity.previousPriceInr)}`);
  }
  if (opportunity.targetPriceInr != null) {
    lines.push(`Your target: ${formatInr(opportunity.targetPriceInr)}`);
  }
  lines.push(
    ``,
    opportunity.reason,
    `Observed at: ${opportunity.evidence.observedAt}`,
    `Link: ${opportunity.url}`,
    ``,
    `Prices change quickly and availability is not guaranteed — this ` +
      `reflects a single verified observation, not a promise you can buy ` +
      `at this price.`,
  );
  return { subject: subjectFor(opportunity), text: lines.join("\n") };
}

/**
 * Email one freshly created opportunity when policy allows. Every outcome
 * — skipped, sent, or failed — is recorded on the opportunity so the feed
 * can show it honestly. Returns true only when an email went out.
 */
export async function maybeSendOpportunityEmail(args: {
  store: MemoryStore;
  notifier: Notifier;
  userSub: string;
  opportunity: Opportunity;
}): Promise<boolean> {
  const { store, notifier, userSub, opportunity } = args;
  const fail = async (reason: string): Promise<boolean> => {
    await store.updateOpportunityEmail(userSub, opportunity.id, {
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
    kind: KIND_EMAIL[opportunity.kind],
    watchId: opportunity.watchId ?? null,
  });
  if (!decision.send || !decision.to) {
    return fail(decision.reason);
  }
  const content = opportunityEmail(opportunity);
  const result = await notifier.sendEmail({ to: decision.to, ...content });
  await store.updateOpportunityEmail(userSub, opportunity.id, {
    attempted: true,
    sent: result.sent,
    ...(result.error ? { error: result.error } : {}),
  });
  return result.sent;
}
