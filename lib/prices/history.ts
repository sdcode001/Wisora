import type { PriceObservation } from "./observation";

/** Observations older than this are shown as stale, never as current. */
export const STALE_OBSERVATION_DAYS = 7;
/** Minimum window observations for an average to mean anything. */
export const MIN_AVERAGE_OBSERVATIONS = 2;

export interface PricePoint {
  priceInr: number;
  observedAt: string;
}

export interface PriceStats {
  count: number;
  windowDays: number;
  latest: PriceObservation | null;
  stale: boolean;
  min: PricePoint | null;
  max: PricePoint | null;
  averageInr: number | null;
  changeVsPrevious: { absoluteInr: number; percent: number } | null;
}

/**
 * Windowed statistics over newest-first observations. Every figure is
 * labeled by its window; thin data yields explicit nulls, never guesses.
 */
export function summarizeHistory(
  observations: PriceObservation[],
  windowDays = 30,
  nowMs: number = Date.now(),
): PriceStats {
  const cutoff = nowMs - windowDays * 24 * 60 * 60 * 1000;
  const inWindow = observations.filter(
    (obs) => Number(new Date(obs.observedAt).getTime()) >= cutoff,
  );
  const latest = inWindow[0] ?? null;
  if (!latest || inWindow.length === 0) {
    return {
      count: 0,
      windowDays,
      latest: null,
      stale: false,
      min: null,
      max: null,
      averageInr: null,
      changeVsPrevious: null,
    };
  }
  let min = inWindow[0] as PriceObservation;
  let max = inWindow[0] as PriceObservation;
  let sum = 0;
  for (const obs of inWindow) {
    if (obs.priceInr < min.priceInr) {
      min = obs;
    }
    if (obs.priceInr > max.priceInr) {
      max = obs;
    }
    sum += obs.priceInr;
  }
  const previous = inWindow[1];
  return {
    count: inWindow.length,
    windowDays,
    latest,
    stale:
      nowMs - new Date(latest.observedAt).getTime() >
      STALE_OBSERVATION_DAYS * 24 * 60 * 60 * 1000,
    min: { priceInr: min.priceInr, observedAt: min.observedAt },
    max: { priceInr: max.priceInr, observedAt: max.observedAt },
    averageInr:
      inWindow.length >= MIN_AVERAGE_OBSERVATIONS
        ? Math.round(sum / inWindow.length)
        : null,
    changeVsPrevious:
      previous && previous.priceInr !== latest.priceInr
        ? {
            absoluteInr: latest.priceInr - previous.priceInr,
            percent:
              Math.round(
                ((latest.priceInr - previous.priceInr) /
                  previous.priceInr) *
                  1000,
              ) / 10,
          }
        : null,
  };
}

/**
 * Honest note when a target sits below everything ever observed.
 * Returns null when the target is unremarkable or history is too thin.
 */
export function targetRealismNote(
  targetPrice: number,
  stats: PriceStats,
): string | null {
  if (!stats.min || stats.count < 2) {
    return null;
  }
  if (targetPrice < stats.min.priceInr) {
    return (
      `Heads up: this product was never observed below ` +
      `₹${stats.min.priceInr.toLocaleString("en-IN")} in the last ` +
      `${stats.windowDays} days (${stats.count} observations).`
    );
  }
  return null;
}
