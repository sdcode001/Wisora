import type { Category } from "../../config/sources";
import type { MemoryStore } from "../memory/store";
import type { CheckStatus, Watch } from "../prices/observation";
import {
  DEFAULT_THRESHOLDS,
  detectAvailabilityTransition,
  detectPriceOpportunity,
  snapshotFromWatch,
  type DetectionThresholds,
  type ProductSnapshot,
} from "./detect";
import { evaluateRelevance } from "./relevance";
import {
  isAvailabilityDuplicate,
  type NewOpportunity,
  type Opportunity,
  type OpportunityKind,
} from "./schema";

export interface EvaluateWatchInput {
  store: MemoryStore;
  userSub: string;
  /** The watch AFTER its latest check (lastCheck reflects fresh state). */
  watch: Watch;
  /** lastCheck.status BEFORE the latest check (for transitions). */
  previousStatus?: CheckStatus;
  thresholds?: DetectionThresholds;
  nowMs?: number;
}

export interface SkippedCandidate {
  kind: OpportunityKind;
  dedupeKey: string;
  reason: "duplicate" | "irrelevant";
}

export interface EvaluateWatchResult {
  created: Opportunity[];
  skipped: SkippedCandidate[];
}

async function resolveCategory(
  store: MemoryStore,
  userSub: string,
  productId: string,
): Promise<Category | null> {
  try {
    const decisions = await store.listDecisions(userSub, 20);
    const decision = decisions.find(
      (entry) => entry.topPick?.productId === productId,
    );
    if (decision) {
      return decision.category;
    }
    const comparisons = await store.listSavedComparisons(userSub);
    const comparison = comparisons.find((entry) =>
      entry.products.some((product) => product.productId === productId),
    );
    return comparison?.category ?? null;
  } catch {
    // Enrichment is best-effort: a category miss never blocks detection.
    return null;
  }
}

async function resolveImageUrl(
  store: MemoryStore,
  userSub: string,
  productId: string,
): Promise<string | null> {
  try {
    const saved = await store.listSavedProducts(userSub);
    return saved.find((entry) => entry.productId === productId)?.imageUrl ?? null;
  } catch {
    return null;
  }
}

/**
 * Latest saved decision on this product, when one exists — stamped onto
 * new opportunities so a changed recommendation is visible next to the
 * evidence that may invalidate it.
 */
async function resolveDecisionContext(
  store: MemoryStore,
  userSub: string,
  productId: string,
): Promise<string | null> {
  try {
    const decisions = await store.listDecisions(userSub, 20);
    const decision = decisions.find(
      (entry) => entry.topPick?.productId === productId,
    );
    if (!decision) {
      return null;
    }
    return (
      `Your ${decision.createdAt.slice(0, 10)} decision on this product ` +
      `was ${decision.verdict}.`
    );
  } catch {
    return null;
  }
}

/**
 * Evaluate one freshly-checked watch for opportunities: detect price and
 * availability candidates, relevance-filter them, dedupe against stored
 * history (any status), and persist the survivors. Pure detection plus
 * store IO — no fetching, so it is safe to call from the monitor cycle,
 * manual checks, and re-evaluation alike. Idempotent: re-running over
 * unchanged state creates nothing.
 */
export async function evaluateWatchForOpportunities(
  input: EvaluateWatchInput,
): Promise<EvaluateWatchResult> {
  const {
    store,
    userSub,
    watch,
    previousStatus,
    thresholds = DEFAULT_THRESHOLDS,
    nowMs = Date.now(),
  } = input;
  const result: EvaluateWatchResult = { created: [], skipped: [] };
  const observations = await store.listObservations(watch.productId, 50);
  const [category, imageUrl, decisionContext] = await Promise.all([
    resolveCategory(store, userSub, watch.productId),
    resolveImageUrl(store, userSub, watch.productId),
    resolveDecisionContext(store, userSub, watch.productId),
  ]);
  const snapshot: ProductSnapshot = {
    ...snapshotFromWatch(watch),
    ...(imageUrl ? { imageUrl } : {}),
  };
  const existing = await store.listOpportunities(userSub);

  const priceCandidate = detectPriceOpportunity({
    snapshot,
    watch,
    observations,
    thresholds,
    nowMs,
  });
  if (priceCandidate) {
    await considerCandidate(store, userSub, existing, result, {
      ...priceCandidate,
      ...(category ? { category } : {}),
      ...(decisionContext ? { decisionContext } : {}),
    });
  }

  const lastCheck = watch.lastCheck;
  if (lastCheck) {
    const availabilityCandidate = detectAvailabilityTransition({
      snapshot,
      watch,
      previousStatus,
      currentStatus: lastCheck.status,
      observedAt: lastCheck.at,
      staleDays: thresholds.staleDays,
      nowMs,
    });
    if (availabilityCandidate) {
      await considerCandidate(store, userSub, existing, result, {
        ...availabilityCandidate,
        ...(category ? { category } : {}),
        ...(decisionContext ? { decisionContext } : {}),
      });
    }
  }
  return result;
}

async function considerCandidate(
  store: MemoryStore,
  userSub: string,
  existing: Opportunity[],
  result: EvaluateWatchResult,
  candidate: NewOpportunity,
): Promise<void> {
  const verdict = await evaluateRelevance({
    store,
    userSub,
    opportunity: candidate,
  });
  const stamped: NewOpportunity = {
    ...candidate,
    relevance: verdict.relevance,
  };
  if (!verdict.relevant) {
    result.skipped.push({
      kind: candidate.kind,
      dedupeKey: candidate.dedupeKey,
      reason: "irrelevant",
    });
    return;
  }
  const duplicate =
    candidate.kind === "restored" || candidate.kind === "unavailable"
      ? isAvailabilityDuplicate(existing, candidate.productId, candidate.kind)
      : existing.some((entry) => entry.dedupeKey === candidate.dedupeKey);
  if (duplicate) {
    result.skipped.push({
      kind: candidate.kind,
      dedupeKey: candidate.dedupeKey,
      reason: "duplicate",
    });
    return;
  }
  const saved = await store.saveOpportunity(userSub, stamped);
  existing.unshift(saved);
  result.created.push(saved);
}
