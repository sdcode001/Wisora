import { z } from "zod";

// Points per scoring dimension. Must sum to 100 so totals stay comparable.
// price: budget fit (or neutral when unpriced). relevance: query-term
// coverage outside stated requirements. evidence: price/rating verification
// strength. wants: matched share of optional preferences by importance.
export const ScoreWeightsSchema = z
  .object({
    price: z.number().min(0).max(100),
    relevance: z.number().min(0).max(100),
    evidence: z.number().min(0).max(100),
    wants: z.number().min(0).max(100),
  })
  .refine((w) => w.price + w.relevance + w.evidence + w.wants === 100, {
    message: "weights must sum to 100",
  });
export type ScoreWeights = z.infer<typeof ScoreWeightsSchema>;

export const DEFAULT_WEIGHTS: ScoreWeights = {
  price: 35,
  relevance: 30,
  evidence: 20,
  wants: 15,
};

export interface RawWeights {
  price: number;
  relevance: number;
  evidence: number;
  wants: number;
}

export function normalizeWeights(input: RawWeights): ScoreWeights {
  const entries = (
    Object.entries(input) as Array<[keyof RawWeights, number]>
  ).map(([key, value]) => [
    key,
    Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0,
  ]) as Array<[keyof RawWeights, number]>;
  const total = entries.reduce((sum, [, value]) => sum + value, 0);
  if (total <= 0) {
    return { ...DEFAULT_WEIGHTS };
  }
  const scaled = entries.map(
    ([key, value]) => [key, (value / total) * 100] as const,
  );
  const rounded = new Map<keyof RawWeights, number>(
    scaled.map(([key, value]) => [key, Math.round(value)]),
  );
  const drift =
    100 - [...rounded.values()].reduce((sum, value) => sum + value, 0);
  if (drift !== 0) {
    let largest: keyof RawWeights = "price";
    for (const [key, value] of scaled) {
      if (value > (scaled.find(([k]) => k === largest)?.[1] ?? -1)) {
        largest = key;
      }
    }
    rounded.set(largest, (rounded.get(largest) ?? 0) + drift);
  }
  return ScoreWeightsSchema.parse({
    price: rounded.get("price"),
    relevance: rounded.get("relevance"),
    evidence: rounded.get("evidence"),
    wants: rounded.get("wants"),
  });
}
