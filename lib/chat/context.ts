import type { MemoryStore } from "../memory/store";
import type { PriceObservation } from "../prices/observation";
import { formatInr } from "../text/format";

/** Hard cap on the formatted context block (prompt cost bound). */
export const MAX_CONTEXT_CHARS = 6000;

export interface KnownProduct {
  productId: string;
  title: string;
  merchant: string;
  url: string;
  targetPriceInr: number | null;
  latest: PriceObservation | null;
  history: PriceObservation[];
  decisionVerdict: string | null;
  saved: boolean;
  activeOpportunityKinds: string[];
}

export interface ChatContext {
  text: string;
  products: KnownProduct[];
  generatedAt: string;
}

function ageLabel(observedAt: string, nowMs: number): string {
  const ms = new Date(observedAt).getTime();
  if (!Number.isFinite(ms)) {
    return "unknown time";
  }
  const diffMs = nowMs - ms;
  if (diffMs < 0) {
    return "in the future";
  }
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 72) {
    return `${hours}h ago`;
  }
  return `${Math.floor(hours / 24)}d ago`;
}

function formatObserved(
  obs: PriceObservation,
  nowMs: number,
): string {
  return `${formatInr(obs.priceInr)} (${ageLabel(obs.observedAt, nowMs)}, ${obs.source})`;
}

/**
 * Gather everything the assistant may cite: watches + price history,
 * active opportunities, recent decisions, saved products, and the
 * preference signals that shape recommendations. Nothing here is fetched
 * live — it is all stored data, labeled by age so answers can separate
 * the latest check from earlier observations.
 */
export async function buildChatContext(args: {
  store: MemoryStore;
  userSub: string;
  nowMs?: number;
}): Promise<ChatContext> {
  const { store, userSub } = args;
  const nowMs = args.nowMs ?? Date.now();
  const [profile, watches, opportunities, decisions, saved] =
    await Promise.all([
      store.getProfile(userSub).catch(() => null),
      store.listWatches(userSub).catch(() => []),
      store.listOpportunities(userSub, 20).catch(() => []),
      store.listDecisions(userSub, 5).catch(() => []),
      store.listSavedProducts(userSub).catch(() => []),
    ]);

  const byId = new Map<string, KnownProduct>();
  const ensure = (
    productId: string,
    snapshot: { title: string; merchant: string; url: string },
  ): KnownProduct => {
    const found = byId.get(productId);
    if (found) {
      return found;
    }
    const created: KnownProduct = {
      productId,
      title: snapshot.title,
      merchant: snapshot.merchant,
      url: snapshot.url,
      targetPriceInr: null,
      latest: null,
      history: [],
      decisionVerdict: null,
      saved: false,
      activeOpportunityKinds: [],
    };
    byId.set(productId, created);
    return created;
  };

  for (const watch of watches) {
    if (!watch.active) {
      continue;
    }
    ensure(watch.productId, watch).targetPriceInr = watch.targetPrice;
  }
  for (const entry of saved.slice(0, 10)) {
    ensure(entry.productId, entry).saved = true;
  }
  for (const opp of opportunities) {
    if (opp.status !== "active") {
      continue;
    }
    ensure(opp.productId, opp).activeOpportunityKinds.push(opp.kind);
  }
  for (const decision of decisions) {
    const pick = decision.topPick;
    if (!pick) {
      continue;
    }
    const known = byId.get(pick.productId);
    if (known && !known.decisionVerdict) {
      known.decisionVerdict = decision.verdict;
    }
  }

  const products = [...byId.values()].slice(0, 12);
  await Promise.all(
    products.map(async (product) => {
      try {
        const history = await store.listObservations(product.productId, 3);
        product.history = history;
        product.latest = history[0] ?? null;
      } catch {
        product.history = [];
        product.latest = null;
      }
    }),
  );

  const lines: string[] = [];
  if (profile) {
    const general = profile.general.value;
    const bits: string[] = [];
    if (general.preferredBrands.length > 0) {
      bits.push(`likes brands: ${general.preferredBrands.join(", ")}`);
    }
    if (general.avoidedBrands.length > 0) {
      bits.push(`avoids brands: ${general.avoidedBrands.join(", ")}`);
    }
    if (general.categories.length > 0) {
      bits.push(`categories: ${general.categories.join(", ")}`);
    }
    const budgets: string[] = [];
    for (const [category, prefs] of Object.entries(profile.categories)) {
      const max = prefs?.value.budgetInr?.max;
      if (max != null) {
        budgets.push(`${category} ≤ ${formatInr(max)}`);
      }
    }
    if (budgets.length > 0) {
      bits.push(`budgets: ${budgets.join("; ")}`);
    }
    if (bits.length > 0) {
      lines.push(`User preferences — ${bits.join(". ")}.`);
    }
  }
  for (const product of products) {
    const bits: string[] = [
      `${product.title} (${product.merchant})`,
    ];
    if (product.latest) {
      bits.push(`latest: ${formatObserved(product.latest, nowMs)}`);
      const older = product.history
        .slice(1)
        .map((obs) => formatObserved(obs, nowMs));
      if (older.length > 0) {
        bits.push(`earlier: ${older.join("; ")}`);
      }
    } else {
      bits.push("no price observations");
    }
    if (product.targetPriceInr != null) {
      bits.push(`watch target: ${formatInr(product.targetPriceInr)}`);
    }
    if (product.decisionVerdict) {
      bits.push(`last decision: ${product.decisionVerdict}`);
    }
    if (product.activeOpportunityKinds.length > 0) {
      bits.push(
        `open cards: ${product.activeOpportunityKinds.join(", ")}`,
      );
    }
    lines.push(`- ${bits.join(". ")}.`);
  }
  if (products.length === 0) {
    lines.push(
      "No tracked products, saved items, decisions, or opportunities.",
    );
  }

  const text = lines.join("\n").slice(0, MAX_CONTEXT_CHARS);
  return {
    text,
    products,
    generatedAt: new Date(nowMs).toISOString(),
  };
}
