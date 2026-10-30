import type { Category, ShoppingSource } from "../../config/sources";
import type { Budget } from "../intent/types";
import { extractRupeeAmounts, selectObservedPrice } from "../prices/extract";
import {
  ProductSchema,
  productIdFor,
  type PriceEvidence,
  type Product,
} from "../products/schema";
import {
  tavilyExtract,
  tavilySearch,
  type TavilyPage,
  type TavilyResult,
} from "../tavily/client";

export interface SearchFilters {
  budgetInr?: Budget;
  maxResults?: number;
}

export interface AdapterSearchRequest {
  searchTerms: string;
  category: Category;
  sources: ShoppingSource[];
  apiKey: string;
  filters?: SearchFilters;
}

export interface SourceStatus {
  sourceId: string;
  ok: boolean;
  error?: string;
  resultCount: number;
  searchedAt: string;
}

export interface AdapterSearchOutcome {
  results: Product[];
  statuses: SourceStatus[];
  enrichmentNote?: string;
}

export interface SourceMetadata {
  id: string;
  name: string;
  domain: string;
  baseUrl: string;
}

export interface SourceAdapter {
  readonly method: "search-api";
  search(request: AdapterSearchRequest): Promise<AdapterSearchOutcome>;
  getSourceMetadata(source: ShoppingSource): SourceMetadata;
}

export function hostMatchesDomain(url: string, domain: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    const clean = domain.toLowerCase();
    return host === clean || host.endsWith(`.${clean}`);
  } catch {
    return false;
  }
}

const IMAGE_MD_RE = /!\[[^\]]*\]\(([^)\s]+)\)/g;

const IMAGE_CHROME_KEYWORDS = [
  "sprite",
  "pixel",
  "logo",
  "icon",
  "banner",
  "megamenu",
  "menu",
  "nav-",
  "/nav/",
  "header",
  "footer",
  "transparent",
  "grey",
  "gray",
  "loading",
  "badge",
  "star",
  "rating",
  "emoji",
  "avatar",
  "placeholder",
  "spinner",
  "loader",
  "sash",
  "chevron",
  "arrow",
  "tick",
  "assured",
  "truck",
  "shield",
  "secure",
  "seller",
  "giftcard",
  "notification",
  "helpcenter",
  "downloadapp",
  "advertise",
];

function normalizeImageUrl(raw: string, pageUrl: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.startsWith("data:")) {
    return undefined;
  }
  try {
    const absolute = trimmed.startsWith("//")
      ? `https:${trimmed}`
      : new URL(trimmed, pageUrl).toString();
    const parsed = new URL(absolute);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return undefined;
    }
    return absolute;
  } catch {
    return undefined;
  }
}

function isChromeImage(url: string): boolean {
  const lower = url.toLowerCase();
  if (/\.svg(?:[?#]|$)/.test(lower)) {
    return true;
  }
  return IMAGE_CHROME_KEYWORDS.some((keyword) => lower.includes(keyword));
}

function scoreImage(url: string): number {
  const lower = url.toLowerCase();
  let score = 0;
  if (/\/images\/I\//.test(lower)) {
    score += 10;
  }
  if (lower.includes("rukminim")) {
    score += 10;
  }
  if (/assets\.myntassets\.com\/.*\/assets\/images\//.test(lower)) {
    score += 10;
  }
  if (/\/image\/\d+\/\d+\//.test(lower)) {
    score += 3;
  }
  if (/_SL\d+_|_SS\d+_|_SX\d+_|_SY\d+_/.test(lower)) {
    score += 3;
  }
  if (/[?&](w|h|width|height)=/.test(lower) || /,w_\d+/.test(lower)) {
    score += 2;
  }
  if (/\/images\/[GS]\//.test(lower)) {
    score -= 4;
  }
  if (
    lower.includes("static-assets-web") ||
    lower.includes("constant.myntassets") ||
    lower.includes("/web/assets/")
  ) {
    score -= 4;
  }
  if (
    !/\.(?:jpe?g|png|webp|avif|gif)(?:[?#]|$)/i.test(lower) &&
    !lower.includes("rukminim") &&
    !lower.includes("myntassets") &&
    !lower.includes("/image/")
  ) {
    score -= 6;
  }
  return score;
}

export function upscaleImage(url: string): string {
  const lower = url.toLowerCase();
  if (/\/images\/I\//i.test(url)) {
    return url.replace(/\._[^.]+\.(jpg|jpeg|png|webp)$/i, "._SL1500_.$1");
  }
  if (lower.includes("rukminim")) {
    return url.replace(/\/image\/\d+\/\d+\//, "/image/832/832/");
  }
  if (lower.includes("assets.myntassets.com")) {
    return url.replace(/,h_\d+/g, ",h_1440").replace(/,w_\d+/g, ",w_1080");
  }
  return url;
}

export function extractImageUrl(
  text: string,
  pageUrl: string,
  extraImages: string[] = [],
): string | undefined {
  IMAGE_MD_RE.lastIndex = 0;
  const candidates: string[] = [];
  let match: RegExpExecArray | null;
  let guard = 0;
  while ((match = IMAGE_MD_RE.exec(text)) !== null && guard < 300) {
    guard += 1;
    const normalized = normalizeImageUrl(match[1] ?? "", pageUrl);
    if (normalized && !isChromeImage(normalized)) {
      candidates.push(normalized);
    }
  }
  for (const raw of extraImages.slice(0, 50)) {
    const normalized = normalizeImageUrl(raw, pageUrl);
    if (
      normalized &&
      !isChromeImage(normalized) &&
      !candidates.includes(normalized)
    ) {
      candidates.push(normalized);
    }
  }
  if (candidates.length === 0) {
    return undefined;
  }
  let best = candidates[0] as string;
  let bestScore = scoreImage(best);
  for (const candidate of candidates.slice(1)) {
    const score = scoreImage(candidate);
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return upscaleImage(best);
}

export interface PageRating {
  value: number;
  count?: number;
}

export function isProductUrl(url: string, sourceId: string): boolean {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return false;
  }
  switch (sourceId) {
    case "amazon-in":
      return /\/(?:dp|gp\/product)\//.test(path);
    case "flipkart":
      return /\/p\/|\/product\//.test(path);
    case "myntra":
      return /\/buy\/?$/.test(path);
    case "ajio":
      return /\/p\//.test(path);
    case "tata-cliq":
      return /\/[cp]-/.test(path);
    case "nykaa-fashion":
      return /\/p\//.test(path);
    default:
      return true;
  }
}

const RATING_VALUE_PATTERNS = [
  /(\d(?:\.\d)?)\s*out of\s*5/i,
  /(\d(?:\.\d)?)\s*★/,
  /rated\s*(\d(?:\.\d)?)\b/i,
  /(\d(?:\.\d)?)\s*\/\s*5\b/,
];

const RATING_COUNT_PATTERNS = [
  /([\d,]+)\s*(?:global\s+)?ratings?/i,
  /([\d,]+)\s*reviews?/i,
];

export function extractRating(text: string): PageRating | undefined {
  let value: number | undefined;
  for (const pattern of RATING_VALUE_PATTERNS) {
    const match = pattern.exec(text);
    if (match?.[1]) {
      const parsed = Number.parseFloat(match[1]);
      if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 5) {
        value = Math.round(parsed * 10) / 10;
        break;
      }
    }
  }
  if (value === undefined) {
    return undefined;
  }
  let count: number | undefined;
  for (const pattern of RATING_COUNT_PATTERNS) {
    const match = pattern.exec(text);
    if (match?.[1]) {
      const parsed = Number.parseInt(match[1].replace(/,/g, ""), 10);
      if (Number.isFinite(parsed) && parsed >= 0) {
        count = parsed;
        break;
      }
    }
  }
  return { value, count };
}

interface Enrichment {
  priceInr?: number;
  evidence?: PriceEvidence;
  imageUrl?: string;
  rating?: PageRating;
}

async function enrich(
  entries: Array<{ url: string; sourceId: string }>,
  apiKey: string,
): Promise<{ byUrl: Map<string, Enrichment>; failed: boolean }> {
  if (entries.length === 0) {
    return { byUrl: new Map(), failed: false };
  }
  const sourceByUrl = new Map(entries.map((e) => [e.url, e.sourceId]));
  let pages: TavilyPage[];
  try {
    pages = await tavilyExtract({ apiKey, urls: entries.map((e) => e.url) });
  } catch {
    return { byUrl: new Map(), failed: true };
  }
  const byUrl = new Map<string, Enrichment>();
  for (const page of pages) {
    const observed = selectObservedPrice(extractRupeeAmounts(page.text));
    const priceInr = observed?.priceInr;
    const evidence: PriceEvidence | undefined = observed?.evidence;
    const sourceId = sourceByUrl.get(page.url);
    const rating =
      sourceId && isProductUrl(page.url, sourceId)
        ? extractRating(page.text)
        : undefined;
    byUrl.set(page.url, {
      priceInr,
      evidence,
      imageUrl: extractImageUrl(page.text, page.url, page.images),
      rating,
    });
  }
  return { byUrl, failed: false };
}

export class TavilySourceAdapter implements SourceAdapter {
  readonly method = "search-api" as const;

  getSourceMetadata(source: ShoppingSource): SourceMetadata {
    return {
      id: source.id,
      name: source.name,
      domain: source.domain,
      baseUrl: source.baseUrl,
    };
  }

  async search(request: AdapterSearchRequest): Promise<AdapterSearchOutcome> {
    const searchedAt = new Date().toISOString();
    let raw: TavilyResult[];
    try {
      raw = await tavilySearch({
        apiKey: request.apiKey,
        query: request.searchTerms,
        includeDomains: request.sources.map((s) => s.domain),
        maxResults: request.filters?.maxResults,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "search failed";
      return {
        results: [],
        statuses: request.sources.map((s) => ({
          sourceId: s.id,
          ok: false,
          error: message,
          resultCount: 0,
          searchedAt,
        })),
      };
    }

    const attributed: Array<{ item: TavilyResult; source: ShoppingSource }> = [];
    for (const item of raw) {
      const source = request.sources.find((s) =>
        hostMatchesDomain(item.url, s.domain),
      );
      if (!source) {
        continue;
      }
      attributed.push({ item, source });
    }

    const topEntries = [...attributed]
      .sort((a, b) => b.item.score - a.item.score)
      .slice(0, 5)
      .map((entry) => ({ url: entry.item.url, sourceId: entry.source.id }));
    const { byUrl: enrichment, failed: enrichmentFailed } = await enrich(
      topEntries,
      request.apiKey,
    );

    const products: Product[] = [];
    for (const { item, source } of attributed) {
      const extra = enrichment.get(item.url);
      const parsed = ProductSchema.safeParse({
        id: productIdFor(item.url),
        title: item.title || item.url,
        url: item.url,
        sourceId: source.id,
        merchant: source.name,
        snippet: item.content.slice(0, 600),
        score: item.score,
        ...(extra?.priceInr != null && extra.evidence
          ? {
              priceInr: extra.priceInr,
              priceEvidence: extra.evidence,
              priceSeenAt: searchedAt,
            }
          : {}),
        ...(extra?.imageUrl ? { imageUrl: extra.imageUrl } : {}),
        ...(extra?.rating
          ? { rating: { ...extra.rating, seenAt: searchedAt } }
          : {}),
        retrievedAt: searchedAt,
      });
      if (parsed.success) {
        products.push(parsed.data);
      }
    }

    const counts = new Map<string, number>();
    for (const product of products) {
      counts.set(product.sourceId, (counts.get(product.sourceId) ?? 0) + 1);
    }
    return {
      results: products,
      statuses: request.sources.map((s) => ({
        sourceId: s.id,
        ok: true,
        resultCount: counts.get(s.id) ?? 0,
        searchedAt,
      })),
      enrichmentNote: enrichmentFailed
        ? "Detail enrichment was unavailable for this search; prices and images may be missing."
        : undefined,
    };
  }
}
