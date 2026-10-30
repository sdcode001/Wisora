import type { PriceEvidence } from "../products/schema";

const RUPEE_RE = /(?:₹|rs\.?|inr)\s*([\d,]+(?:\.\d{1,2})?)/gi;

export function extractRupeeAmounts(text: string): number[] {
  const amounts: number[] = [];
  RUPEE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  let guard = 0;
  while ((match = RUPEE_RE.exec(text)) !== null && guard < 500) {
    guard += 1;
    const value = Number.parseFloat((match[1] ?? "").replace(/,/g, ""));
    if (Number.isFinite(value) && value >= 1 && value <= 10000000) {
      amounts.push(Math.round(value));
    }
  }
  return amounts;
}

export interface ObservedPrice {
  priceInr: number;
  evidence: PriceEvidence;
  /** Distinct amounts seen — high counts mean an ambiguous page. */
  candidates: number;
}

/**
 * Pick the selling price from extracted amounts: the most frequent amount
 * wins (product pages repeat the selling price; crossed-out MRPs and
 * accessories usually appear once). Returns null when nothing parseable.
 */
export function selectObservedPrice(amounts: number[]): ObservedPrice | null {
  if (amounts.length === 0) {
    return null;
  }
  const frequency = new Map<number, number>();
  for (const amount of amounts) {
    frequency.set(amount, (frequency.get(amount) ?? 0) + 1);
  }
  let best = amounts[0] as number;
  let bestCount = 0;
  for (const [amount, count] of frequency) {
    if (count > bestCount) {
      best = amount;
      bestCount = count;
    }
  }
  return {
    priceInr: best,
    evidence: bestCount >= 2 ? "repeated" : "single",
    candidates: frequency.size,
  };
}
