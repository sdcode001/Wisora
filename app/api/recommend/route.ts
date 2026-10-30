import { NextResponse } from "next/server";
import { z } from "zod";
import { CategorySchema, enabledSourcesFor, SOURCES } from "../../../config/sources";
import { filterEligible } from "../../../lib/eligibility/filter";
import {
  assessConfidence,
  buildProductEvidence,
} from "../../../lib/evidence/quality";
import { resolveIntent } from "../../../lib/intent/service";
import { IntentSchema } from "../../../lib/intent/types";
import { getReasonProvider } from "../../../lib/llm/provider";
import { sessionUserFromRequest } from "../../../lib/auth/require-session";
import { FileMemoryStore } from "../../../lib/memory/file-store";
import { resolvePersonalization } from "../../../lib/memory/personalize";
import { PROFILE_KEY_PREFIX } from "../../../lib/memory/profile";
import {
  evaluateObservationsForUser,
  recordProductPrices,
} from "../../../lib/prices/check";
import { notifierFromEnv } from "../../../lib/prices/notify";
import { dedupeProducts } from "../../../lib/products/dedup";
import { ProductSchema, type Product } from "../../../lib/products/schema";
import { extractRequirements } from "../../../lib/requirements/extract";
import { RequirementSetSchema } from "../../../lib/requirements/types";
import { describeRankingGap, scoreProducts } from "../../../lib/recommend/score";
import { decideRecommendation } from "../../../lib/recommend/policy";
import {
  DEFAULT_WEIGHTS,
  ScoreWeightsSchema,
} from "../../../lib/recommend/weights";
import {
  TavilySourceAdapter,
  type SourceStatus,
} from "../../../lib/search/adapter";

const StatusSchema = z.looseObject({
  sourceId: z.string(),
  ok: z.boolean(),
  error: z.string().optional(),
  resultCount: z.number(),
  searchedAt: z.string(),
});

const BodySchema = z.object({
  query: z.string().trim().min(2).max(500),
  category: CategorySchema.optional(),
  disabled: z.record(z.string(), z.boolean()).optional(),
  maxResults: z.number().int().min(1).max(50).optional(),
  intent: IntentSchema.optional(),
  requirements: RequirementSetSchema.optional(),
  weights: z.unknown().optional(),
  allowOverBudget: z.boolean().optional(),
  products: z.array(ProductSchema).optional(),
  statuses: z.array(StatusSchema).optional(),
  searchedAt: z.string().optional(),
  personalize: z.boolean().optional(),
});

export async function POST(request: Request): Promise<NextResponse> {
  const body: unknown = await request.json().catch(() => null);
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "query must be a string of 2–500 characters" },
      { status: 400 },
    );
  }
  const input = parsed.data;
  const warnings: string[] = [];

  const resolved = input.intent
    ? { intent: input.intent, llmUsed: false, llmAvailable: true }
    : await resolveIntent(input.query);
  const detectedIntent = resolved.intent;
  const category = input.category ?? detectedIntent.category;
  const categorySource = input.category ? "user" : "detected";

  const baseRequirements =
    input.requirements ??
    (await extractRequirements(detectedIntent.query, detectedIntent))
      .requirements;

  const personalization = await resolvePersonalization(request, {
    intent: detectedIntent,
    requirements: baseRequirements,
    category,
    weightsProvided: input.weights !== undefined,
    personalize: input.personalize ?? true,
  });
  if (personalization.warning) {
    warnings.push(personalization.warning);
  }
  const intent = personalization.intent;
  const requirements = personalization.requirements;

  const weightsParsed = ScoreWeightsSchema.safeParse(
    input.weights ?? personalization.preset ?? DEFAULT_WEIGHTS,
  );
  const weights = weightsParsed.success ? weightsParsed.data : DEFAULT_WEIGHTS;
  if (!weightsParsed.success) {
    warnings.push("Invalid scoring weights ignored; using defaults.");
  }
  if (input.weights !== undefined) {
    personalization.report.weightsSource = weightsParsed.success
      ? "request"
      : "default";
  }

  let products: Product[];
  let statuses: SourceStatus[];
  let searchedAt: string;

  if (input.products) {
    products = input.products;
    statuses = (input.statuses ?? []) as SourceStatus[];
    searchedAt = input.searchedAt ?? new Date().toISOString();
  } else {
    const enabledOverrides = Object.fromEntries(
      Object.entries(input.disabled ?? {}).map(([id, isDisabled]) => [
        id,
        !isDisabled,
      ]),
    );
    const sources = enabledSourcesFor(category, enabledOverrides);
    if (sources.length === 0) {
      return NextResponse.json(
        {
          error:
            "No enabled sources support this category. Enable at least one source.",
          code: "no-sources",
        },
        { status: 400 },
      );
    }
    const apiKey = process.env.TAVILY_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        {
          error:
            "Product search is not configured (TAVILY_API_KEY is missing). Add it to .env to enable live search.",
          code: "missing-tavily-key",
        },
        { status: 503 },
      );
    }
    const adapter = new TavilySourceAdapter();
    const outcome = await adapter.search({
      searchTerms: intent.searchTerms,
      category,
      sources,
      apiKey,
      filters: { budgetInr: intent.budgetInr, maxResults: input.maxResults },
    });
    products = outcome.results;
    statuses = outcome.statuses;
    searchedAt = new Date().toISOString();
    if (outcome.enrichmentNote) {
      warnings.push(outcome.enrichmentNote);
    }
    const nameOf = (id: string): string =>
      SOURCES.find((s) => s.id === id)?.name ?? id;
    const empty = statuses.filter((s) => s.ok && s.resultCount === 0);
    if (empty.length > 0) {
      warnings.push(
        `No results from: ${empty.map((s) => nameOf(s.sourceId)).join(", ")}.`,
      );
    }
    for (const status of statuses.filter((s) => !s.ok)) {
      warnings.push(
        `${nameOf(status.sourceId)} could not be searched: ${status.error ?? "unknown error"}.`,
      );
    }
  }

  const deduped = dedupeProducts(products);
  if (deduped.removed > 0) {
    warnings.push(
      `${deduped.removed} duplicate listing${deduped.removed === 1 ? " was" : "s were"} merged.`,
    );
  }

  const effectiveIntent = { ...intent, category };
  const { eligible, excluded, checks } = filterEligible(
    deduped.products,
    requirements,
    effectiveIntent,
    { allowOverBudget: input.allowOverBudget },
  );
  if (excluded.length > 0) {
    warnings.push(
      `${excluded.length} option${excluded.length === 1 ? " was" : "s were"} excluded by requirements or budget.`,
    );
  }

  const ranked = scoreProducts(eligible, effectiveIntent, requirements, weights);
  const evidence = new Map(
    ranked.map((entry) => [
      entry.product.id,
      buildProductEvidence(entry.product, deduped.conflicts),
    ]),
  );
  const confidence = assessConfidence(
    ranked.slice(0, 5).map((entry) => entry.product),
    evidence,
  );

  let llmVerdict:
    | {
        verdict: "BUY" | "WAIT" | "AVOID";
        productId?: string | null;
        reason: string;
        tradeoffs: string[];
        uncertainties: string[];
      }
    | undefined;
  const reasonProvider = eligible.length > 0 ? getReasonProvider() : null;
  if (reasonProvider) {
    try {
      const llm = await reasonProvider.explainVerdict({
        query: intent.query,
        budgetMax: intent.budgetInr?.max,
        constraints: [
          ...requirements.must.map((m) => `Must: ${m.label}`),
          ...requirements.exclude.map(
            (e) =>
              `Exclude: ${e.label}${e.key.startsWith(PROFILE_KEY_PREFIX) ? " (saved preference)" : ""}`,
          ),
        ],
        candidates: ranked.slice(0, 6).map((entry) => ({
          id: entry.product.id,
          title: entry.product.title,
          merchant: entry.product.merchant,
          priceInr: entry.product.priceInr,
          priceEvidence: entry.product.priceEvidence,
          rating: entry.product.rating
            ? {
                value: entry.product.rating.value,
                count: entry.product.rating.count,
              }
            : undefined,
          snippet: entry.product.snippet,
        })),
        topReasons: (ranked[0]?.score.reasons ?? []).map((r) => r.text),
      });
      llmVerdict = {
        verdict: llm.verdict,
        productId: llm.productId,
        reason: llm.reason,
        tradeoffs: llm.tradeoffs,
        uncertainties: llm.uncertainties,
      };
    } catch {
      llmVerdict = undefined;
    }
  }

  const recommendation = decideRecommendation({
    ranked,
    totalFound: deduped.products.length,
    excluded,
    intent: effectiveIntent,
    confidence,
    llmVerdict,
  });

  const runnerUpDiff =
    ranked.length >= 2 && ranked[0] && ranked[1]
      ? describeRankingGap(ranked[0], ranked[1])
      : [];

  // Price history builds from normal use: persist fresh prices, then check
  // the signed-in user's watches against them. Neither step may fail this.
  try {
    const store = new FileMemoryStore();
    const observations = await recordProductPrices(
      store,
      ranked.map((entry) => entry.product),
      "search",
    );
    const user = sessionUserFromRequest(request);
    if (user && observations.length > 0) {
      const alerts = await evaluateObservationsForUser({
        store,
        userSub: user.sub,
        observations,
        notifier: notifierFromEnv(),
      });
      if (alerts.length > 0) {
        warnings.push(
          `${alerts.length} price alert${alerts.length === 1 ? " was" : "s were"} triggered — see Watchlist.`,
        );
      }
    }
  } catch {
    warnings.push("Price history was unavailable for this search.");
  }

  return NextResponse.json({
    intent: effectiveIntent,
    categorySource,
    llmUsed: resolved.llmUsed,
    personalization: personalization.report,
    requirements,
    ranked: ranked.map((entry) => ({
      ...entry,
      analysis: {
        checks: checks[entry.product.id] ?? [],
        evidence: evidence.get(entry.product.id) ?? null,
      },
    })),
    excluded,
    excludedByBudget: excluded.filter((entry) =>
      entry.reasons.some((reason) => reason.startsWith("Over budget")),
    ).length,
    statuses,
    searchedAt,
    warnings,
    recommendation,
    reasoningUsed: recommendation.source,
    confidence,
    runnerUpDiff,
  });
}
