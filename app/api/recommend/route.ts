import { NextResponse } from "next/server";
import { z } from "zod";
import {
  CategorySchema,
  enabledSourcesFor,
  SOURCES,
} from "../../../config/sources";
import { resolveIntent } from "../../../lib/intent/service";
import { IntentSchema } from "../../../lib/intent/types";
import { getReasonProvider } from "../../../lib/llm/provider";
import { dedupeProducts } from "../../../lib/products/dedup";
import { ProductSchema, type Product } from "../../../lib/products/schema";
import { scoreProducts } from "../../../lib/recommend/score";
import {
  deterministicVerdict,
  validateLlmVerdict,
} from "../../../lib/recommend/verdict";
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
  products: z.array(ProductSchema).optional(),
  statuses: z.array(StatusSchema).optional(),
  searchedAt: z.string().optional(),
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

  const resolved = input.intent
    ? { intent: input.intent, llmUsed: false, llmAvailable: true }
    : await resolveIntent(input.query);
  const intent = resolved.intent;
  const category = input.category ?? intent.category;
  const categorySource = input.category ? "user" : "detected";

  let products: Product[];
  let statuses: SourceStatus[];
  let searchedAt: string;
  const warnings: string[] = [];

  if (input.products) {
    products = input.products;
    statuses = (input.statuses ?? []) as SourceStatus[];
    searchedAt = input.searchedAt ?? new Date().toISOString();
  } else {
    // Client sends `disabled` flags; convert to enabled-overrides.
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
    const deduped = dedupeProducts(outcome.results);
    products = deduped.products;
    statuses = outcome.statuses;
    searchedAt = new Date().toISOString();
    if (deduped.removed > 0) {
      warnings.push(
        `${deduped.removed} duplicate listing${deduped.removed === 1 ? " was" : "s were"} merged.`,
      );
    }
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

  const effectiveIntent = { ...intent, category };
  const ranked = scoreProducts(products, effectiveIntent);

  let recommendation = deterministicVerdict(ranked, effectiveIntent);
  const reasonProvider = products.length > 0 ? getReasonProvider() : null;
  if (reasonProvider) {
    try {
      const llm = await reasonProvider.explainVerdict({
        query: intent.query,
        budgetMax: intent.budgetInr?.max,
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
      recommendation = validateLlmVerdict(
        {
          verdict: llm.verdict,
          productId: llm.productId,
          reason: llm.reason,
          tradeoffs: llm.tradeoffs,
          uncertainties: llm.uncertainties,
        },
        ranked,
        effectiveIntent,
      );
    } catch {
      recommendation = deterministicVerdict(ranked, effectiveIntent);
    }
  }

  return NextResponse.json({
    intent: effectiveIntent,
    categorySource,
    llmUsed: resolved.llmUsed,
    ranked,
    statuses,
    searchedAt,
    warnings,
    recommendation,
    reasoningUsed: recommendation.source,
  });
}
