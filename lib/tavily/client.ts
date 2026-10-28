import { z } from "zod";

const BASE_URL = "https://api.tavily.com";

export class TavilyError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "TavilyError";
  }
}

export class TavilyAuthError extends TavilyError {
  constructor() {
    super("Tavily rejected the API key (invalid TAVILY_API_KEY?)", 401, false);
    this.name = "TavilyAuthError";
  }
}

const SearchItemSchema = z.looseObject({
  title: z.string().catch(""),
  url: z.string(),
  content: z.string().catch(""),
  score: z.number().catch(0),
});

const SearchResponseSchema = z.looseObject({
  results: z.array(z.unknown()).catch([]),
});

const ExtractItemSchema = z.looseObject({
  url: z.string().catch(""),
  raw_content: z.string().catch(""),
  content: z.string().catch(""),
  images: z.array(z.string()).catch([]),
});

const ExtractResponseSchema = z.looseObject({
  results: z.array(z.unknown()).catch([]),
});

export interface TavilyResult {
  title: string;
  url: string;
  content: string;
  score: number;
}

export interface TavilyPage {
  url: string;
  text: string;
  images: string[];
}

let lastCallAt = 0;

async function throttle(minGapMs = 1000): Promise<void> {
  const wait = minGapMs - (Date.now() - lastCallAt);
  if (wait > 0) {
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
  lastCallAt = Date.now();
}

async function post(
  path: string,
  apiKey: string,
  body: Record<string, unknown>,
  timeoutMs: number,
): Promise<unknown> {
  await throttle();
  let lastError: unknown = new Error("unreachable");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${BASE_URL}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ api_key: apiKey, ...body }),
        signal: controller.signal,
      });
      if (response.status === 401 || response.status === 403) {
        throw new TavilyAuthError();
      }
      if (response.status === 429 || response.status >= 500) {
        throw new TavilyError(
          `Tavily ${path} failed with status ${response.status}`,
          response.status,
          true,
        );
      }
      if (!response.ok) {
        throw new TavilyError(
          `Tavily ${path} failed with status ${response.status}`,
          response.status,
          false,
        );
      }
      return (await response.json()) as unknown;
    } catch (error) {
      lastError =
        error instanceof Error && error.name === "AbortError"
          ? new TavilyError(`Tavily ${path} timed out`, undefined, true)
          : error;
      if (lastError instanceof TavilyError && !lastError.retryable) {
        throw lastError;
      }
      if (attempt === 0) {
        await new Promise((resolve) => setTimeout(resolve, 800));
      }
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

export async function tavilySearch(options: {
  apiKey: string;
  query: string;
  includeDomains: string[];
  maxResults?: number;
}): Promise<TavilyResult[]> {
  const raw = await post(
    "/search",
    options.apiKey,
    {
      query: options.query,
      search_depth: "basic",
      max_results: options.maxResults ?? 20,
      include_domains: options.includeDomains,
      include_domains_mode: "restrict",
    },
    25000,
  );
  const parsed = SearchResponseSchema.safeParse(raw);
  if (!parsed.success) {
    return [];
  }
  const results: TavilyResult[] = [];
  for (const item of parsed.data.results) {
    const valid = SearchItemSchema.safeParse(item);
    if (valid.success) {
      results.push({
        title: valid.data.title,
        url: valid.data.url,
        content: valid.data.content,
        score: valid.data.score,
      });
    }
  }
  return results;
}

export async function tavilyExtract(options: {
  apiKey: string;
  urls: string[];
}): Promise<TavilyPage[]> {
  if (options.urls.length === 0) {
    return [];
  }
  const raw = await post(
    "/extract",
    options.apiKey,
    { urls: options.urls, include_images: true },
    45000,
  );
  const parsed = ExtractResponseSchema.safeParse(raw);
  if (!parsed.success) {
    return [];
  }
  const pages: TavilyPage[] = [];
  for (const item of parsed.data.results) {
    const valid = ExtractItemSchema.safeParse(item);
    if (valid.success && valid.data.url) {
      const text = valid.data.raw_content || valid.data.content;
      if (text) {
        pages.push({ url: valid.data.url, text, images: valid.data.images });
      }
    }
  }
  return pages;
}
