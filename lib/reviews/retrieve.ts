import type { ReviewSource } from "../../config/review-sources";
import { productIdFor } from "../products/schema";
import { hostMatchesDomain } from "../search/adapter";
import {
  tavilyExtract,
  tavilySearch,
  type TavilyPage,
  type TavilyResult,
} from "../tavily/client";
import { contentTokens } from "../text/tokens";
import { extractIdentity, gradeRelevance } from "./identity";
import { ReviewRecordSchema, type ReviewRecord } from "./types";

export interface ReviewProductInput {
  id: string;
  title: string;
}

export interface SourceFailure {
  sourceId: string;
  error: string;
}

export interface ProductReviewRetrieval {
  productId: string;
  records: ReviewRecord[];
  failures: SourceFailure[];
  searchedAt: string;
}

export const MAX_REVIEW_PAGES = 4;
const MAX_EXCERPT_CHARS = 2000;

export function buildReviewQuery(title: string): string {
  const tokens = [...contentTokens(title)].slice(0, 8).join(" ");
  return `${tokens} review`.trim();
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function attributeSource(
  url: string,
  sources: ReviewSource[],
): ReviewSource | null {
  return (
    sources.find((source) => hostMatchesDomain(url, source.domain)) ?? null
  );
}

export function buildRecords(input: {
  product: ReviewProductInput;
  results: TavilyResult[];
  pages: Map<string, TavilyPage>;
  sources: ReviewSource[];
  competingModels: string[];
  searchedAt: string;
}): ReviewRecord[] {
  const identity = extractIdentity(input.product.title);
  const records: ReviewRecord[] = [];
  const seenUrls = new Set<string>();
  for (const result of input.results) {
    if (seenUrls.has(result.url)) {
      continue;
    }
    seenUrls.add(result.url);
    const source = attributeSource(result.url, input.sources);
    if (!source) {
      continue;
    }
    const page = input.pages.get(result.url);
    const text = page ? page.text : result.content;
    const parsed = ReviewRecordSchema.safeParse({
      id: `rev-${productIdFor(result.url)}`,
      productId: input.product.id,
      url: result.url,
      sourceId: source.id,
      sourceName: source.name,
      sourceType: source.type,
      title: result.title || result.url,
      excerpt: collapseWhitespace(text).slice(0, MAX_EXCERPT_CHARS),
      contentSource: page ? "extract" : "snippet",
      retrievedAt: input.searchedAt,
      relevance: gradeRelevance(
        identity,
        input.competingModels,
        { title: result.title, url: result.url, text },
      ),
    });
    if (parsed.success) {
      records.push(parsed.data);
    }
  }
  return records;
}

export interface RetrieveReviewsRequest {
  products: ReviewProductInput[];
  apiKey: string;
  sources: ReviewSource[];
  maxPagesPerProduct?: number;
}

export async function retrieveReviews(
  request: RetrieveReviewsRequest,
): Promise<ProductReviewRetrieval[]> {
  const searchedAt = new Date().toISOString();
  const identities = new Map(
    request.products.map((p) => [p.id, extractIdentity(p.title)]),
  );
  const maxPages = request.maxPagesPerProduct ?? MAX_REVIEW_PAGES;
  const outcomes: ProductReviewRetrieval[] = [];
  for (const product of request.products) {
    const failures: SourceFailure[] = [];
    let results: TavilyResult[] = [];
    try {
      results = await tavilySearch({
        apiKey: request.apiKey,
        query: buildReviewQuery(product.title),
        includeDomains: request.sources.map((s) => s.domain),
        maxResults: 10,
      });
    } catch (error) {
      outcomes.push({
        productId: product.id,
        records: [],
        failures: [
          {
            sourceId: "tavily-search",
            error: error instanceof Error ? error.message : "search failed",
          },
        ],
        searchedAt,
      });
      continue;
    }
    const candidates = [...results]
      .sort((a, b) => b.score - a.score)
      .filter((r) => attributeSource(r.url, request.sources) !== null)
      .slice(0, maxPages);
    let pages = new Map<string, TavilyPage>();
    try {
      const extracted = await tavilyExtract({
        apiKey: request.apiKey,
        urls: candidates.map((c) => c.url),
      });
      pages = new Map(extracted.map((p) => [p.url, p]));
    } catch (error) {
      failures.push({
        sourceId: "tavily-extract",
        error:
          error instanceof Error
            ? error.message
            : "page extraction failed; using snippets",
      });
    }
    const competing = request.products
      .filter((p) => p.id !== product.id)
      .flatMap((p) => identities.get(p.id)?.modelTokens ?? []);
    outcomes.push({
      productId: product.id,
      records: buildRecords({
        product,
        results,
        pages,
        sources: request.sources,
        competingModels: competing,
        searchedAt,
      }),
      failures,
      searchedAt,
    });
  }
  return outcomes;
}
