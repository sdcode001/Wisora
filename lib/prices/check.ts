import type { MemoryStore } from "../memory/store";
import type { Product } from "../products/schema";
import { tavilyExtract } from "../tavily/client";
import { extractRupeeAmounts, selectObservedPrice } from "./extract";
import type { Notifier } from "./notify";
import type {
  CheckStatus,
  PriceAlert,
  PriceObservation,
  Watch,
} from "./observation";

/** Returns page text, or null when the page cannot be retrieved. */
export type PageFetcher = (url: string) => Promise<string | null>;

export async function tavilyPageFetcher(
  apiKey: string,
  url: string,
): Promise<string | null> {
  const pages = await tavilyExtract({ apiKey, urls: [url] });
  return pages[0]?.text ?? null;
}

const UNAVAILABLE_PATTERNS = [
  /out of stock/i,
  /\bsold out\b/i,
  /currently unavailable/i,
  /no longer available/i,
];

export interface WatchCheckOutcome {
  watch: Watch;
  status: CheckStatus;
  error?: string;
  observation?: PriceObservation;
  recorded?: boolean;
  alert?: PriceAlert | null;
  alertSkipped?: "target-not-met" | "duplicate" | "watch-paused" | null;
}

function isDuplicate(
  alerts: PriceAlert[],
  watchId: string,
  priceInr: number,
  targetPrice: number,
): boolean {
  const latest = alerts.find((alert) => alert.watchId === watchId);
  return (
    latest !== undefined &&
    latest.observedPrice === priceInr &&
    latest.targetPrice === targetPrice
  );
}

async function createAlertWithEmail(args: {
  store: MemoryStore;
  userSub: string;
  notifier: Notifier;
  watch: Watch;
  observation: PriceObservation;
}): Promise<PriceAlert> {
  const { store, userSub, notifier, watch, observation } = args;
  const alert = await store.saveAlert(userSub, {
    watchId: watch.id,
    productId: watch.productId,
    title: watch.title,
    merchant: watch.merchant,
    url: watch.url,
    observedPrice: observation.priceInr,
    targetPrice: watch.targetPrice,
    observedAt: observation.observedAt,
  });
  if (!watch.notifyEmail) {
    await store.updateAlertEmail(userSub, alert.id, {
      attempted: false,
      sent: false,
    });
    return { ...alert, email: { attempted: false, sent: false } };
  }
  const result = await notifier.sendAlert({
    to: watch.notifyEmail,
    productTitle: watch.title,
    merchant: watch.merchant,
    url: watch.url,
    observedPrice: observation.priceInr,
    targetPrice: watch.targetPrice,
    observedAt: observation.observedAt,
  });
  const email = {
    attempted: true,
    sent: result.sent,
    ...(result.error ? { error: result.error } : {}),
  };
  await store.updateAlertEmail(userSub, alert.id, email);
  return { ...alert, email };
}

/**
 * Run one price check: fetch the listing, parse the price, record the
 * observation, and alert (in-app + email) when an active watch's target
 * is newly met. Failures are recorded on the watch — never silently
 * marked successful, and email problems never fail the check itself.
 */
export async function runWatchCheck(args: {
  store: MemoryStore;
  userSub: string;
  watch: Watch;
  fetchPage: PageFetcher;
  notifier: Notifier;
  now?: string;
}): Promise<WatchCheckOutcome> {
  const { store, userSub, watch, fetchPage, notifier } = args;
  const now = args.now ?? new Date().toISOString();

  const fail = async (
    status: Exclude<CheckStatus, "ok">,
    error: string,
  ): Promise<WatchCheckOutcome> => {
    const updated = await store.updateWatchCheck(userSub, watch.id, {
      at: now,
      status,
      error: error.slice(0, 300),
    });
    return {
      watch: updated ?? watch,
      status,
      error,
      alert: null,
      alertSkipped: null,
    };
  };

  let text: string | null;
  try {
    text = await fetchPage(watch.url);
  } catch (error) {
    return fail(
      "fetch-failed",
      error instanceof Error ? error.message : "Page fetch failed.",
    );
  }
  if (!text) {
    return fail("fetch-failed", "The product page could not be retrieved.");
  }
  const observed = selectObservedPrice(extractRupeeAmounts(text));
  if (!observed) {
    const unavailable = UNAVAILABLE_PATTERNS.some((pattern) =>
      pattern.test(text),
    );
    return fail(
      unavailable ? "unavailable" : "no-price",
      unavailable
        ? "The listing looks unavailable (no price found)."
        : "No price could be parsed from the listing.",
    );
  }

  const { observation, recorded } = await store.recordObservation({
    productId: watch.productId,
    url: watch.url,
    title: watch.title,
    merchant: watch.merchant,
    sourceId: watch.sourceId ?? "unknown",
    priceInr: observed.priceInr,
    currency: "INR",
    evidence: observed.evidence,
    candidates: observed.candidates,
    observedAt: now,
    source: "watch-check",
  });
  const updated =
    (await store.updateWatchCheck(userSub, watch.id, {
      at: now,
      priceInr: observation.priceInr,
      status: "ok",
    })) ?? watch;

  if (!watch.active) {
    return {
      watch: updated,
      status: "ok",
      observation,
      recorded,
      alert: null,
      alertSkipped: "watch-paused",
    };
  }
  if (observation.priceInr > watch.targetPrice) {
    return {
      watch: updated,
      status: "ok",
      observation,
      recorded,
      alert: null,
      alertSkipped: "target-not-met",
    };
  }
  if (
    isDuplicate(
      await store.listAlerts(userSub),
      watch.id,
      observation.priceInr,
      watch.targetPrice,
    )
  ) {
    return {
      watch: updated,
      status: "ok",
      observation,
      recorded,
      alert: null,
      alertSkipped: "duplicate",
    };
  }
  const alert = await createAlertWithEmail({
    store,
    userSub,
    notifier,
    watch,
    observation,
  });
  return {
    watch: (await store.getWatch(userSub, watch.id)) ?? updated,
    status: "ok",
    observation,
    recorded,
    alert,
    alertSkipped: null,
  };
}

/**
 * Record search/recommendation prices as observations. Returns the
 * observation per priced product (existing latest when deduped) so callers
 * can evaluate watches against them.
 */
export async function recordProductPrices(
  store: MemoryStore,
  products: Product[],
  source: "search" | "watch-check" = "search",
): Promise<PriceObservation[]> {
  const observations: PriceObservation[] = [];
  for (const product of products) {
    if (product.priceInr == null) {
      continue;
    }
    const { observation } = await store.recordObservation({
      productId: product.id,
      url: product.url,
      title: product.title,
      merchant: product.merchant,
      sourceId: product.sourceId,
      priceInr: product.priceInr,
      currency: "INR",
      evidence: product.priceEvidence ?? "single",
      candidates: product.priceEvidence === "repeated" ? 2 : 1,
      observedAt: product.priceSeenAt ?? product.retrievedAt,
      source,
    });
    observations.push(observation);
  }
  return observations;
}

/**
 * Evaluate a user's active watches against fresh observations (used after
 * searches and manual checks alike). Creates one alert per newly-met
 * target and emails when an address is on file.
 */
export async function evaluateObservationsForUser(args: {
  store: MemoryStore;
  userSub: string;
  observations: PriceObservation[];
  notifier: Notifier;
}): Promise<PriceAlert[]> {
  const { store, userSub, observations, notifier } = args;
  const watches = (await store.listWatches(userSub)).filter((w) => w.active);
  if (watches.length === 0 || observations.length === 0) {
    return [];
  }
  const alerts = await store.listAlerts(userSub);
  const created: PriceAlert[] = [];
  for (const observation of observations) {
    for (const watch of watches.filter(
      (w) => w.productId === observation.productId,
    )) {
      if (observation.priceInr > watch.targetPrice) {
        continue;
      }
      if (
        isDuplicate(
          [...created, ...alerts],
          watch.id,
          observation.priceInr,
          watch.targetPrice,
        )
      ) {
        continue;
      }
      created.push(
        await createAlertWithEmail({
          store,
          userSub,
          notifier,
          watch,
          observation,
        }),
      );
    }
  }
  return created;
}
