import { NextResponse } from "next/server";
import { z } from "zod";
import {
  CategorySchema,
  type Category,
} from "../../../config/sources";
import { enabledReviewSources } from "../../../config/review-sources";
import { getReasonProvider } from "../../../lib/llm/provider";
import { RequirementSetSchema } from "../../../lib/requirements/types";
import {
  buildProductReport,
  describeRankImpact,
} from "../../../lib/reviews/pipeline";
import { retrieveReviews } from "../../../lib/reviews/retrieve";
import type { ProductReviewReport } from "../../../lib/reviews/types";

const BodySchema = z.object({
  products: z
    .array(
      z.object({
        id: z.string().min(1),
        title: z.string().min(1).max(500),
        url: z.string().url().optional(),
      }),
    )
    .min(1)
    .max(3),
  category: CategorySchema.optional(),
  requirements: RequirementSetSchema.optional(),
  rankedTotals: z
    .array(z.object({ id: z.string().min(1), total: z.number() }))
    .optional(),
});

export async function POST(request: Request): Promise<NextResponse> {
  const body: unknown = await request.json().catch(() => null);
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "products must be an array of 1–3 { id, title } entries" },
      { status: 400 },
    );
  }
  const input = parsed.data;
  const category: Category = input.category ?? "general";

  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      {
        error:
          "Review search is not configured (TAVILY_API_KEY is missing). Add it to .env to enable review intelligence.",
        code: "missing-tavily-key",
      },
      { status: 503 },
    );
  }
  const sources = enabledReviewSources();
  if (sources.length === 0) {
    return NextResponse.json(
      {
        error:
          "No review sources are enabled. Enable at least one in config/review-sources.ts.",
        code: "no-sources",
      },
      { status: 400 },
    );
  }

  const searchedAt = new Date().toISOString();
  const warnings: string[] = [];
  const outcomes = await retrieveReviews({
    products: input.products,
    apiKey,
    sources,
  });
  const provider = getReasonProvider();
  if (!provider) {
    warnings.push(
      "AI theme extraction is unavailable (no API key configured) — showing sources without grouped insights.",
    );
  }

  const reports: ProductReviewReport[] = [];
  for (const outcome of outcomes) {
    const title =
      input.products.find((p) => p.id === outcome.productId)?.title ??
      outcome.productId;
    for (const failure of outcome.failures) {
      warnings.push(
        `${title}: ${failure.sourceId} — ${failure.error}`.slice(0, 200),
      );
    }
    let llmThemes = null;
    if (provider && outcome.records.length > 0) {
      try {
        llmThemes = await provider.extractReviewThemes({
          productTitle: title,
          records: outcome.records.slice(0, 6).map((r) => ({
            id: r.id,
            title: r.title,
            excerpt: r.excerpt,
          })),
        });
      } catch {
        llmThemes = null;
        warnings.push(
          `${title}: theme extraction failed — showing sources without grouped insights.`.slice(
            0,
            200,
          ),
        );
      }
    }
    const currentTotal = input.rankedTotals?.find(
      (t) => t.id === outcome.productId,
    )?.total;
    reports.push(
      buildProductReport({
        productId: outcome.productId,
        records: outcome.records,
        llmThemes,
        failureNotes: outcome.failures.map((f) => f.error.slice(0, 200)),
        requirements: input.requirements,
        category,
        currentTotal,
        searchedAt,
      }),
    );
  }

  const adjusted = new Map(
    reports.map((r) => [r.productId, r.adjustedTotal]),
  );
  const known = new Map<string, number>();
  for (const [id, total] of adjusted) {
    if (total != null) {
      known.set(id, total);
    }
  }
  const { notes, wouldChangeTopPick } = describeRankImpact(
    input.rankedTotals ?? [],
    known,
  );

  return NextResponse.json({
    reports,
    rankImpact: notes,
    wouldChangeTopPick,
    searchedAt,
    warnings: warnings.slice(0, 6),
  });
}
