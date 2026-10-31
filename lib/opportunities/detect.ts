import { STALE_OBSERVATION_DAYS } from "../prices/history";
import type {
  CheckStatus,
  PriceObservation,
  Watch,
} from "../prices/observation";
import { formatInr } from "../text/format";
import {
  buildDedupeKey,
  type NewOpportunity,
} from "./schema";

export interface DetectionThresholds {
  /** Minimum drop size: both floors must pass. */
  minDropPercent: number;
  minDropInr: number;
  /** Minimum rise size: both floors must pass. */
  minRisePercent: number;
  minRiseInr: number;
  /** Lookback window for the favorable price range, in days. */
  rangeDays: number;
  /** Within this % of the window low counts as "in range". */
  rangeTolerancePercent: number;
  /** Observations older than this never trigger anything. */
  staleDays: number;
}

export const DEFAULT_THRESHOLDS: DetectionThresholds = {
  minDropPercent: 5,
  minDropInr: 500,
  minRisePercent: 10,
  minRiseInr: 1000,
  rangeDays: 30,
  rangeTolerancePercent: 2,
  staleDays: STALE_OBSERVATION_DAYS,
};

function envNumber(
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = Number.parseFloat(process.env[name] ?? "");
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}

export function detectionThresholdsFromEnv(): DetectionThresholds {
  return {
    minDropPercent: envNumber(
      "WISORA_OPP_MIN_DROP_PERCENT",
      DEFAULT_THRESHOLDS.minDropPercent,
      0,
      100,
    ),
    minDropInr: envNumber(
      "WISORA_OPP_MIN_DROP_INR",
      DEFAULT_THRESHOLDS.minDropInr,
      0,
      100_000_000,
    ),
    minRisePercent: envNumber(
      "WISORA_OPP_MIN_RISE_PERCENT",
      DEFAULT_THRESHOLDS.minRisePercent,
      0,
      100,
    ),
    minRiseInr: envNumber(
      "WISORA_OPP_MIN_RISE_INR",
      DEFAULT_THRESHOLDS.minRiseInr,
      0,
      100_000_000,
    ),
    rangeDays: envNumber(
      "WISORA_OPP_RANGE_DAYS",
      DEFAULT_THRESHOLDS.rangeDays,
      1,
      365,
    ),
    rangeTolerancePercent: envNumber(
      "WISORA_OPP_RANGE_TOLERANCE_PERCENT",
      DEFAULT_THRESHOLDS.rangeTolerancePercent,
      0,
      50,
    ),
    staleDays: envNumber(
      "WISORA_OPP_STALE_DAYS",
      DEFAULT_THRESHOLDS.staleDays,
      1,
      90,
    ),
  };
}

export interface ProductSnapshot {
  productId: string;
  title: string;
  merchant: string;
  url: string;
  imageUrl?: string;
}

export function snapshotFromWatch(
  watch: Watch,
  imageUrl?: string,
): ProductSnapshot {
  return {
    productId: watch.productId,
    title: watch.title,
    merchant: watch.merchant,
    url: watch.url,
    ...(imageUrl ? { imageUrl } : {}),
  };
}

function observedMs(observedAt: string): number | null {
  const ms = new Date(observedAt).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function isStale(observedAt: string, staleDays: number, nowMs: number): boolean {
  const ms = observedMs(observedAt);
  if (ms == null) {
    return true;
  }
  return nowMs - ms > staleDays * 24 * 60 * 60 * 1000;
}

/** First observation whose price differs from the latest (history is newest-first). */
function previousDistinct(
  observations: PriceObservation[],
): PriceObservation | null {
  const latest = observations[0];
  if (!latest) {
    return null;
  }
  return (
    observations.find((obs) => obs.priceInr !== latest.priceInr) ?? null
  );
}

function formatPercent(fraction: number): string {
  return `${Math.round(fraction * 1000) / 10}%`;
}

interface PriceCandidateInput {
  snapshot: ProductSnapshot;
  watch?: Watch;
  latest: PriceObservation;
  previous: PriceObservation | null;
}

function baseCandidate(input: PriceCandidateInput): Omit<
  NewOpportunity,
  "kind" | "dedupeKey" | "reason"
> {
  const { snapshot, watch, latest, previous } = input;
  return {
    ...(watch ? { watchId: watch.id } : {}),
    productId: snapshot.productId,
    title: snapshot.title,
    merchant: snapshot.merchant,
    url: snapshot.url,
    ...(snapshot.imageUrl ? { imageUrl: snapshot.imageUrl } : {}),
    currentPriceInr: latest.priceInr,
    previousPriceInr: previous?.priceInr ?? null,
    targetPriceInr: watch?.targetPrice ?? null,
    evidence: {
      source: latest.source,
      observedAt: latest.observedAt,
      ...(previous ? { previousObservedAt: previous.observedAt } : {}),
    },
  };
}

/**
 * One price opportunity per product per evaluation, by priority:
 * target-reached > back-in-range > significant move. A single latest
 * observation therefore never produces two cards for the same product.
 * Returns null when history is empty, the latest observation is stale
 * (or undated), or nothing meets the thresholds.
 */
export function detectPriceOpportunity(args: {
  snapshot: ProductSnapshot;
  watch?: Watch;
  observations: PriceObservation[];
  thresholds?: DetectionThresholds;
  nowMs?: number;
}): NewOpportunity | null {
  const {
    snapshot,
    watch,
    observations,
    thresholds = DEFAULT_THRESHOLDS,
    nowMs = Date.now(),
  } = args;
  const latest = observations[0];
  if (!latest || isStale(latest.observedAt, thresholds.staleDays, nowMs)) {
    return null;
  }
  const previous = previousDistinct(observations);
  const base = baseCandidate({ snapshot, watch, latest, previous });

  if (watch && latest.priceInr <= watch.targetPrice) {
    return {
      ...base,
      kind: "target-reached",
      dedupeKey: buildDedupeKey(
        "target-reached",
        snapshot.productId,
        latest.priceInr,
      ),
      reason:
        previous == null
          ? `At ${formatInr(latest.priceInr)} — within your ${formatInr(watch.targetPrice)} target.`
          : `At ${formatInr(latest.priceInr)} — within your ${formatInr(watch.targetPrice)} target (was ${formatInr(previous.priceInr)}).`,
    };
  }

  const ranged = detectBackInRangeCandidate(
    { snapshot, watch, latest, previous },
    base,
    observations,
    thresholds,
  );
  if (ranged) {
    return ranged;
  }

  if (previous == null) {
    return null;
  }
  const diff = latest.priceInr - previous.priceInr;
  const abs = Math.abs(diff);
  const percent = abs / previous.priceInr;
  if (diff < 0) {
    if (
      percent * 100 < thresholds.minDropPercent ||
      abs < thresholds.minDropInr
    ) {
      return null;
    }
    return {
      ...base,
      kind: "price-drop",
      dedupeKey: buildDedupeKey(
        "price-drop",
        snapshot.productId,
        latest.priceInr,
      ),
      reason:
        `Dropped ${formatInr(abs)} (${formatPercent(percent)}) to ` +
        `${formatInr(latest.priceInr)} from ${formatInr(previous.priceInr)}.`,
    };
  }
  if (
    percent * 100 < thresholds.minRisePercent ||
    abs < thresholds.minRiseInr
  ) {
    return null;
  }
  return {
    ...base,
    kind: "price-increase",
    dedupeKey: buildDedupeKey(
      "price-increase",
      snapshot.productId,
      latest.priceInr,
    ),
    reason:
      `Rose ${formatInr(abs)} (${formatPercent(percent)}) to ` +
      `${formatInr(latest.priceInr)} from ${formatInr(previous.priceInr)}.`,
  };
}

function detectBackInRangeCandidate(
  input: PriceCandidateInput,
  base: Omit<NewOpportunity, "kind" | "dedupeKey" | "reason">,
  observations: PriceObservation[],
  thresholds: DetectionThresholds,
): NewOpportunity | null {
  const { snapshot, latest, previous } = input;
  if (previous == null) {
    return null;
  }
  const latestMs = observedMs(latest.observedAt);
  if (latestMs == null) {
    return null;
  }
  const cutoff = latestMs - thresholds.rangeDays * 24 * 60 * 60 * 1000;
  const inWindow = observations.filter((obs) => {
    const ms = observedMs(obs.observedAt);
    return ms != null && ms >= cutoff;
  });
  if (inWindow.length < 2) {
    return null;
  }
  let low = inWindow[0] as PriceObservation;
  for (const obs of inWindow) {
    if (obs.priceInr < low.priceInr) {
      low = obs;
    }
  }
  const ceiling = low.priceInr * (1 + thresholds.rangeTolerancePercent / 100);
  // Re-entry only: the latest must be in range and the previous price
  // above it. A fresh low with no higher past price is just history.
  if (latest.priceInr > ceiling || previous.priceInr <= ceiling) {
    return null;
  }
  return {
    ...base,
    kind: "back-in-range",
    dedupeKey: buildDedupeKey(
      "back-in-range",
      snapshot.productId,
      latest.priceInr,
    ),
    reason:
      `Back near its ${thresholds.rangeDays}-day low at ` +
      `${formatInr(latest.priceInr)} (low ${formatInr(low.priceInr)}).`,
  };
}

/**
 * Availability transitions from consecutive watch-check statuses. Only the
 * "unavailable" status (listing shows out-of-stock / no price) counts as
 * an availability fact — fetch failures and parse misses are transient
 * and never alert. A first-ever check showing unavailable still informs:
 * the saved product cannot currently be bought.
 */
export function detectAvailabilityTransition(args: {
  snapshot: ProductSnapshot;
  watch?: Watch;
  previousStatus?: CheckStatus;
  currentStatus: CheckStatus;
  observedAt: string;
  staleDays?: number;
  nowMs?: number;
}): NewOpportunity | null {
  const {
    snapshot,
    watch,
    previousStatus,
    currentStatus,
    observedAt,
    staleDays = DEFAULT_THRESHOLDS.staleDays,
    nowMs = Date.now(),
  } = args;
  if (isStale(observedAt, staleDays, nowMs)) {
    return null;
  }
  const kind =
    currentStatus === "unavailable" && previousStatus !== "unavailable"
      ? "unavailable"
      : currentStatus === "ok" && previousStatus === "unavailable"
        ? "restored"
        : null;
  if (kind == null) {
    return null;
  }
  return {
    kind,
    dedupeKey: buildDedupeKey(kind, snapshot.productId, null),
    ...(watch ? { watchId: watch.id } : {}),
    productId: snapshot.productId,
    title: snapshot.title,
    merchant: snapshot.merchant,
    url: snapshot.url,
    ...(snapshot.imageUrl ? { imageUrl: snapshot.imageUrl } : {}),
    currentPriceInr: null,
    previousPriceInr: null,
    targetPriceInr: watch?.targetPrice ?? null,
    reason:
      kind === "unavailable"
        ? "Looks unavailable — the listing shows out of stock or no price."
        : "Available again — the listing shows a price after being unavailable.",
    evidence: { source: "watch-check", observedAt },
  };
}
