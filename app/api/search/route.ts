import { NextResponse } from "next/server";
import { z } from "zod";
import { CategorySchema, enabledSourcesFor, SOURCES } from "../../../config/sources";
import { sessionUserFromRequest } from "../../../lib/auth/require-session";
import { resolveIntent } from "../../../lib/intent/service";
import { FileMemoryStore } from "../../../lib/memory/file-store";
import {
  evaluateObservationsForUser,
  recordProductPrices,
} from "../../../lib/prices/check";
import { notifierFromEnv } from "../../../lib/prices/notify";
import { dedupeProducts } from "../../../lib/products/dedup";
import { TavilySourceAdapter } from "../../../lib/search/adapter";
import {
  effectiveBudgetMax,
  searchTermsWithBudget,
} from "../../../lib/search/query";

const BodySchema = z.object({
  query: z.string().trim().min(2).max(500),
  category: CategorySchema.optional(),
  disabled: z.record(z.string(), z.boolean()).optional(),
  maxResults: z.number().int().min(1).max(50).optional(),
  allowOverBudget: z.boolean().optional(),
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

  const { intent, llmUsed } = await resolveIntent(parsed.data.query);
  const category = parsed.data.category ?? intent.category;
  const categorySource = parsed.data.category ? "user" : "detected";

  // Client sends `disabled` flags; convert to enabled-overrides.
  const enabledOverrides = Object.fromEntries(
    Object.entries(parsed.data.disabled ?? {}).map(([id, isDisabled]) => [
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

  const flexible = parsed.data.allowOverBudget === true;
  const effectiveMax = effectiveBudgetMax(intent.budgetInr, flexible);
  const adapter = new TavilySourceAdapter();
  const outcome = await adapter.search({
    searchTerms: searchTermsWithBudget(
      intent.searchTerms,
      effectiveMax,
      flexible,
    ),
    category,
    sources,
    apiKey,
    filters: {
      budgetInr:
        flexible && effectiveMax != null && intent.budgetInr
          ? { ...intent.budgetInr, max: effectiveMax }
          : intent.budgetInr,
      maxResults: parsed.data.maxResults,
    },
  });

  const { products, removed } = dedupeProducts(outcome.results);
  const warnings: string[] = [];
  if (removed > 0) {
    warnings.push(`${removed} duplicate listing${removed === 1 ? " was" : "s were"} merged.`);
  }
  if (outcome.enrichmentNote) {
    warnings.push(outcome.enrichmentNote);
  }
  const nameOf = (id: string): string =>
    SOURCES.find((s) => s.id === id)?.name ?? id;
  const empty = outcome.statuses.filter((s) => s.ok && s.resultCount === 0);
  if (empty.length > 0) {
    warnings.push(
      `No results from: ${empty.map((s) => nameOf(s.sourceId)).join(", ")}.`,
    );
  }
  const failed = outcome.statuses.filter((s) => !s.ok);
  for (const status of failed) {
    warnings.push(
      `${nameOf(status.sourceId)} could not be searched: ${status.error ?? "unknown error"}.`,
    );
  }

  // Price history builds from normal use: persist fresh prices, then check
  // the signed-in user's watches against them. Neither step may fail search.
  try {
    const store = new FileMemoryStore();
    const observations = await recordProductPrices(store, products, "search");
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
    intent: { ...intent, category },
    llmUsed,
    categorySource,
    products,
    statuses: outcome.statuses,
    searchedAt: new Date().toISOString(),
    warnings,
  });
}
