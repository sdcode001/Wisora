import type { MemoryStore } from "../memory/store";
import { STALE_OBSERVATION_DAYS } from "../prices/history";
import { formatInr } from "../text/format";
import type { ChatContext, KnownProduct } from "./context";

export interface AnswerSource {
  label: string;
  url?: string;
}

export interface RuleAnswer {
  text: string;
  sources: AnswerSource[];
}

const FILLER_WORDS = new Set([
  "with",
  "from",
  "and",
  "for",
  "the",
  "this",
  "that",
  "pack",
  "combo",
  "laptop",
  "phone",
  "shoes",
]);

function distinctiveTokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9\u0900-\u097F]+/)
    .filter(
      (token) =>
        (token.length >= 4 || (token.length >= 3 && /\d/.test(token))) &&
        !FILLER_WORDS.has(token),
    );
}

/**
 * Match a question to one known product. A UI product hint wins outright;
 * otherwise the best token-overlap title wins only when it clearly beats
 * the runner-up. Anything ambiguous resolves to null so the question
 * falls through to the LLM (which sees every product) instead of
 * answering about the wrong one.
 */
export function resolveProduct(
  question: string,
  products: KnownProduct[],
  hintProductId?: string,
): KnownProduct | null {
  if (hintProductId) {
    return products.find((entry) => entry.productId === hintProductId) ?? null;
  }
  const questionTokens = new Set(distinctiveTokens(question));
  if (questionTokens.size === 0 || products.length === 0) {
    return null;
  }
  const scored = products.map((product) => {
    const titleTokens = distinctiveTokens(
      `${product.title} ${product.merchant}`,
    );
    const matched = titleTokens.filter((token) => questionTokens.has(token));
    return { product, score: matched.length };
  });
  scored.sort((a, b) => b.score - a.score);
  const [best, runnerUp] = scored as [
    { product: KnownProduct; score: number },
    { product: KnownProduct; score: number }?,
  ];
  if (!best || best.score < 1) {
    return null;
  }
  if (runnerUp && runnerUp.score >= best.score) {
    return null;
  }
  return best.product;
}

/**
 * Ensure a UI-hinted product is answerable even when it is absent from
 * the context (e.g. a read or dismissed opportunity card). Best-effort:
 * failures leave the context unchanged.
 */
export async function enrichContextWithProduct(
  store: MemoryStore,
  userSub: string,
  context: ChatContext,
  productId: string,
): Promise<ChatContext> {
  if (context.products.some((entry) => entry.productId === productId)) {
    return context;
  }
  try {
    const [watch, saved, opportunities, history] = await Promise.all([
      store
        .listWatches(userSub)
        .then((watches) => watches.find((entry) => entry.productId === productId) ?? null)
        .catch(() => null),
      store
        .listSavedProducts(userSub)
        .then((items) => items.find((entry) => entry.productId === productId) ?? null)
        .catch(() => null),
      store
        .listOpportunities(userSub, 50)
        .then((entries) => entries.filter((entry) => entry.productId === productId))
        .catch(() => []),
      store.listObservations(productId, 3).catch(() => []),
    ]);
    const snapshot = watch ?? saved ?? opportunities[0] ?? null;
    if (!snapshot && history.length === 0) {
      return context;
    }
    const product: KnownProduct = {
      productId,
      title: snapshot?.title ?? "Unknown product",
      merchant: snapshot?.merchant ?? "Unknown store",
      url: snapshot?.url ?? "",
      targetPriceInr: watch?.targetPrice ?? null,
      latest: history[0] ?? null,
      history,
      decisionVerdict: null,
      saved: saved != null,
      activeOpportunityKinds: opportunities
        .filter((entry) => entry.status === "active")
        .map((entry) => entry.kind),
    };
    const lines = [
      context.text,
      `- ${product.title} (${product.merchant}). ` +
        (product.latest
          ? `latest: ${formatInr(product.latest.priceInr)} (${product.latest.observedAt}).`
          : "no price observations."),
    ];
    return {
      ...context,
      text: lines.join("\n").slice(0, 6000),
      products: [...context.products, product],
    };
  } catch {
    return context;
  }
}

function sourceFor(product: KnownProduct): AnswerSource[] {
  if (!product.url) {
    return [];
  }
  // Real listing titles run past 200 chars; the source schema caps labels
  // there, so clamp — a throw here would 500 the whole chat turn.
  return [
    {
      label: `${product.title} — ${product.merchant}`.slice(0, 200),
      url: product.url,
    },
  ];
}

function ageDays(observedAt: string, nowMs: number): number | null {
  const ms = new Date(observedAt).getTime();
  if (!Number.isFinite(ms)) {
    return null;
  }
  return Math.max(0, Math.floor((nowMs - ms) / (24 * 60 * 60 * 1000)));
}

function staleNote(product: KnownProduct, nowMs: number): string {
  if (!product.latest) {
    return "";
  }
  const days = ageDays(product.latest.observedAt, nowMs);
  if (days != null && days > STALE_OBSERVATION_DAYS) {
    return ` That sighting is ${days} days old, so re-check before acting.`;
  }
  return "";
}

function answerCompare(context: ChatContext): RuleAnswer | null {
  const priced = context.products.filter((entry) => entry.latest);
  if (priced.length < 2) {
    return null;
  }
  const ranked = [...priced].sort(
    (a, b) => (a.latest?.priceInr ?? 0) - (b.latest?.priceInr ?? 0),
  );
  const lines = ranked.map((entry, index) => {
    const latest = entry.latest;
    if (!latest) {
      return `${index + 1}. ${entry.title} — no recorded price`;
    }
    return (
      `${index + 1}. ${entry.title} (${entry.merchant}) — ` +
      `${formatInr(latest.priceInr)}${entry.targetPriceInr != null ? `, target ${formatInr(entry.targetPriceInr)}` : ""}` +
      `${entry.decisionVerdict ? `, last decision ${entry.decisionVerdict}` : ""}`
    );
  });
  return {
    text:
      `Here is your shortlist by latest recorded price (cheapest first):\n${lines.join("\n")}\n` +
      "Prices are last-seen values, not live quotes — open a listing or re-check before deciding.",
    sources: ranked.slice(0, 5).flatMap(sourceFor),
  };
}

function answerPriceChange(
  product: KnownProduct,
  nowMs: number,
): RuleAnswer | null {
  const [latest, previous] = product.history;
  if (!latest) {
    return {
      text:
        `I have no recorded price for ${product.title} yet. ` +
        "Track it from the Watchlist and I will answer this next time.",
      sources: sourceFor(product),
    };
  }
  if (!previous || previous.priceInr === latest.priceInr) {
    return {
      text:
        `${product.title} is at ${formatInr(latest.priceInr)} with no ` +
        `recorded change since ${latest.observedAt.slice(0, 10)}.` +
        staleNote(product, nowMs),
      sources: sourceFor(product),
    };
  }
  const diff = latest.priceInr - previous.priceInr;
  const direction = diff < 0 ? "down" : "up";
  return {
    text:
      `${product.title} moved ${direction} ${formatInr(Math.abs(diff))}: ` +
      `${formatInr(previous.priceInr)} on ${previous.observedAt.slice(0, 10)} → ` +
      `${formatInr(latest.priceInr)} on ${latest.observedAt.slice(0, 10)}.` +
      staleNote(product, nowMs),
    sources: sourceFor(product),
  };
}

function answerGoodDeal(
  product: KnownProduct,
  nowMs: number,
): RuleAnswer | null {
  const latest = product.latest;
  if (!latest) {
    return {
      text:
        `I cannot call ${product.title} a deal yet — no price has been ` +
        "recorded. Track it or re-check, then ask again.",
      sources: sourceFor(product),
    };
  }
  const parts = [
    `${product.title} was last seen at ${formatInr(latest.priceInr)} ` +
      `on ${latest.observedAt.slice(0, 10)}`,
  ];
  if (product.targetPriceInr != null) {
    parts.push(
      latest.priceInr <= product.targetPriceInr
        ? `which meets your ${formatInr(product.targetPriceInr)} target`
        : `against your ${formatInr(product.targetPriceInr)} target ` +
          `(${formatInr(latest.priceInr - product.targetPriceInr)} over)`,
    );
  }
  const older = product.history.slice(1);
  if (older.length > 0) {
    const low = Math.min(...older.map((obs) => obs.priceInr), latest.priceInr);
    parts.push(
      latest.priceInr <= low
        ? "the lowest recorded price"
        : `${formatInr(latest.priceInr - low)} above the recorded low of ${formatInr(low)}`,
    );
  }
  if (product.decisionVerdict) {
    parts.push(`your saved decision was ${product.decisionVerdict}`);
  }
  if (product.activeOpportunityKinds.length > 0) {
    parts.push(
      `open cards: ${product.activeOpportunityKinds.join(", ")} (see the feed)`,
    );
  }
  return {
    text: `${parts.join(". ")}.${staleNote(product, nowMs)}`,
    sources: sourceFor(product),
  };
}

function answerWhy(product: KnownProduct): RuleAnswer | null {
  const parts: string[] = [];
  if (product.decisionVerdict) {
    parts.push(`your saved decision on ${product.title} is ${product.decisionVerdict}`);
  } else {
    parts.push(`there is no saved decision on ${product.title} yet`);
  }
  if (product.latest) {
    parts.push(
      `last seen at ${formatInr(product.latest.priceInr)} on ${product.latest.observedAt.slice(0, 10)}`,
    );
  }
  if (product.targetPriceInr != null) {
    parts.push(
      product.latest && product.latest.priceInr <= product.targetPriceInr
        ? `which meets your ${formatInr(product.targetPriceInr)} target`
        : `against your ${formatInr(product.targetPriceInr)} target`,
    );
  }
  if (product.activeOpportunityKinds.length > 0) {
    parts.push(`flagged in your feed (${product.activeOpportunityKinds.join(", ")})`);
  }
  return { text: `${parts.join(". ")}.`, sources: sourceFor(product) };
}

function answerPriceNow(
  product: KnownProduct,
  nowMs: number,
): RuleAnswer | null {
  const latest = product.latest;
  if (!latest) {
    return {
      text:
        `No price recorded for ${product.title} yet. Track it from the ` +
        "Watchlist and I will know next time.",
      sources: sourceFor(product),
    };
  }
  return {
    text:
      `${product.title} was last seen at ${formatInr(latest.priceInr)} ` +
      `(${product.merchant}, ${latest.observedAt.slice(0, 10)}).` +
      staleNote(product, nowMs),
    sources: sourceFor(product),
  };
}

function answerWhatTracked(context: ChatContext): RuleAnswer {
  const watched = context.products.filter(
    (entry) => entry.targetPriceInr != null,
  );
  const lines: string[] = [];
  if (watched.length > 0) {
    lines.push(
      `Tracked (${watched.length}): ` +
        watched
          .map(
            (entry) =>
              `${entry.title} (target ${entry.targetPriceInr != null ? formatInr(entry.targetPriceInr) : "?"})`,
          )
          .join("; "),
    );
  }
  const saved = context.products.filter((entry) => entry.saved);
  if (saved.length > 0) {
    lines.push(
      `Saved (${saved.length}): ${saved.map((entry) => entry.title).join("; ")}`,
    );
  }
  const flagged = context.products.filter(
    (entry) => entry.activeOpportunityKinds.length > 0,
  );
  if (flagged.length > 0) {
    lines.push(
      `With open feed cards (${flagged.length}): ${flagged.map((entry) => entry.title).join("; ")}`,
    );
  }
  if (lines.length === 0) {
    return {
      text: "You are not tracking or saving anything yet. Search for a product and tap Track to start.",
      sources: [],
    };
  }
  return {
    text: `${lines.join("\n")}\nAsk me about any of these — for example “is the Lenovo still a good deal?”`,
    sources: [],
  };
}

const COMPARE_RE = /\bcompar|better alternative|\bvs\.?\b|versus|which (one|is best)|shortlist/;
const CHANGE_RE = /\bchang|gone (up|down)|cheaper|expensive|\bdrop(ped|s)?\b|rose|\bris|\bfell\b|fallen|increas/;
const DEAL_RE = /good deal|still worth|worth (buying|it)|should i (buy|wait|act|get)|buy now|wait/;
const WHY_RE = /\bwhy\b/;
const PRICE_RE = /\bprice\b|\bcost\b|how much/;
const TRACKED_RE = /what.*(track|watch|remind|sav)|my (watchlist|list|products|saved)/;
const GREETING_RE = /^(hi|hello|hey|namaste)\b/;

/**
 * Answer from stored data without any model call. Returns null when no
 * rule matches so the caller can try the LLM, then the offline fallback.
 */
export function answerQuestion(
  question: string,
  context: ChatContext,
  options: { productId?: string; nowMs?: number } = {},
): RuleAnswer | null {
  const nowMs = options.nowMs ?? Date.now();
  const normalized = question.trim().toLowerCase();
  if (GREETING_RE.test(normalized)) {
    return {
      text:
        "Hi! Ask me about your tracked products — current prices, price " +
        "changes, whether something is still a good deal, or how your " +
        "shortlist compares.",
      sources: [],
    };
  }
  if (COMPARE_RE.test(normalized)) {
    const compared = answerCompare(context);
    if (compared) {
      return compared;
    }
  }
  if (TRACKED_RE.test(normalized)) {
    return answerWhatTracked(context);
  }
  const product = resolveProduct(question, context.products, options.productId);
  if (!product) {
    return null;
  }
  if (CHANGE_RE.test(normalized)) {
    return answerPriceChange(product, nowMs);
  }
  if (DEAL_RE.test(normalized)) {
    return answerGoodDeal(product, nowMs);
  }
  if (WHY_RE.test(normalized)) {
    return answerWhy(product);
  }
  if (PRICE_RE.test(normalized)) {
    return answerPriceNow(product, nowMs);
  }
  // A resolved product with an unrecognized question still gets the
  // current-price summary — the most useful default.
  return answerPriceNow(product, nowMs);
}
