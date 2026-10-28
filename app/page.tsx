"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { SOURCES, type Category } from "../config/sources";
import type { Intent } from "../lib/intent/types";

const CATEGORIES: Array<{ id: Category; label: string }> = [
  { id: "electronics", label: "Electronics" },
  { id: "fashion", label: "Fashion" },
  { id: "footwear", label: "Footwear" },
  { id: "beauty", label: "Beauty & Skincare" },
  { id: "home-kitchen", label: "Home & Kitchen" },
  { id: "general", label: "General" },
];

const EXAMPLES = [
  "Find a laptop under ₹90,000 for .NET development.",
  "Suggest comfortable running shoes under ₹5,000.",
  "Compare smartphones with excellent battery life under ₹30,000.",
  "Find skincare products suitable for a simple daily routine.",
];

const STAGES = [
  { id: "understand", label: "Understanding your requirements" },
  { id: "category", label: "Identifying the product category" },
  { id: "search", label: "Searching selected shopping sources" },
  { id: "compare", label: "Comparing specifications and prices" },
  { id: "recommend", label: "Preparing your recommendation" },
] as const;

type Stage = "idle" | "searching" | "recommending" | "done";

interface IntentResponse {
  intent: Intent;
  llmUsed: boolean;
  llmAvailable: boolean;
}

interface Product {
  id: string;
  title: string;
  url: string;
  sourceId: string;
  merchant: string;
  snippet: string;
  score: number;
  priceInr?: number;
  priceEvidence?: "repeated" | "single";
  priceSeenAt?: string;
  imageUrl?: string;
  rating?: { value: number; count?: number; seenAt: string };
  retrievedAt: string;
}

interface ScoreReason {
  text: string;
  sentiment: "pro" | "con" | "info";
}

interface RankedItem {
  product: Product;
  score: { total: number; reasons: ScoreReason[] };
}

interface SourceStatus {
  sourceId: string;
  ok: boolean;
  error?: string;
  resultCount: number;
  searchedAt: string;
}

interface SearchData {
  products: Product[];
  statuses: SourceStatus[];
  searchedAt: string;
  warnings: string[];
}

interface Recommendation {
  verdict: "BUY" | "WAIT" | "AVOID" | "NEEDS_MORE_INFO";
  productId?: string;
  reason: string;
  tradeoffs: string[];
  uncertainties: string[];
  source: "llm" | "rules";
}

interface VerdictData {
  ranked: RankedItem[];
  recommendation: Recommendation;
  reasoningUsed: "llm" | "rules";
  statuses: SourceStatus[];
  searchedAt: string;
  warnings: string[];
}

function formatInr(value: number): string {
  return `₹${value.toLocaleString("en-IN")}`;
}

function formatCount(value: number): string {
  if (value >= 1000) {
    const k = value / 1000;
    return `${k >= 100 ? Math.round(k).toString() : k.toFixed(1)}k`;
  }
  return value.toLocaleString("en-IN");
}

function categoryLabel(id: Category): string {
  return CATEGORIES.find((c) => c.id === id)?.label ?? id;
}

const MAX_COMPARE = 4;

interface VoiceRecognition extends EventTarget {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult:
    | ((event: {
        resultIndex: number;
        results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>;
      }) => void)
    | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}

function getVoiceRecognition(): (new () => VoiceRecognition) | null {
  if (typeof window === "undefined") {
    return null;
  }
  const w = window as unknown as {
    SpeechRecognition?: new () => VoiceRecognition;
    webkitSpeechRecognition?: new () => VoiceRecognition;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

function subscribeVoiceSupport(): () => void {
  return () => {};
}

function getVoiceSupportSnapshot(): boolean {
  return getVoiceRecognition() !== null;
}

function getVoiceSupportServerSnapshot(): boolean {
  return false;
}

function scrollToElement(element: HTMLElement | null): void {
  if (!element) {
    return;
  }
  const rect = element.getBoundingClientRect();
  if (rect.top >= 0 && rect.bottom <= window.innerHeight) {
    return;
  }
  const reduceMotion = window.matchMedia(
    "(prefers-reduced-motion: reduce)",
  ).matches;
  element.scrollIntoView({
    behavior: reduceMotion ? "auto" : "smooth",
    block: "start",
  });
}

function Stars({ value }: { value: number }) {
  const pct = Math.max(0, Math.min(100, (value / 5) * 100));
  return (
    <span
      className="relative inline-flex leading-none"
      role="img"
      aria-label={`${value.toFixed(1)} out of 5 stars`}
    >
      <span aria-hidden="true" className="whitespace-nowrap text-stone-600">
        ★★★★★
      </span>
      <span
        aria-hidden="true"
        className="absolute inset-0 overflow-hidden whitespace-nowrap text-amber-300"
        style={{ width: `${pct}%` }}
      >
        ★★★★★
      </span>
    </span>
  );
}

function ScoreMeter({ total }: { total: number }) {
  const pct = Math.max(0, Math.min(100, total));
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="h-1.5 w-16 overflow-hidden rounded-full bg-white/10">
        <span
          className="block h-full rounded-full bg-teal-300"
          style={{ width: `${pct}%` }}
        />
      </span>
      <span>{total}/100</span>
    </span>
  );
}

function ProductImage({ url, merchant }: { url?: string; merchant: string }) {
  const [failed, setFailed] = useState(false);
  if (!url || failed) {
    return (
      <div
        aria-hidden="true"
        className="flex h-20 w-20 shrink-0 items-center justify-center rounded-md border border-white/10 bg-white/5 text-xl font-semibold text-stone-600"
      >
        {merchant.charAt(0)}
      </div>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={url}
      alt=""
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className="h-20 w-20 shrink-0 rounded-md border border-white/10 object-cover"
    />
  );
}

export default function Home() {
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<IntentResponse | null>(null);
  const [override, setOverride] = useState<Category | null>(null);
  const [disabled, setDisabled] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stage, setStage] = useState<Stage>("idle");
  const [search, setSearch] = useState<SearchData | null>(null);
  const [verdict, setVerdict] = useState<VerdictData | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [verdictError, setVerdictError] = useState<string | null>(null);
  const [compareIds, setCompareIds] = useState<string[]>([]);
  const [showCompare, setShowCompare] = useState(false);
  const [listening, setListening] = useState(false);
  const voiceSupported = useSyncExternalStore(
    subscribeVoiceSupport,
    getVoiceSupportSnapshot,
    getVoiceSupportServerSnapshot,
  );
  const recognitionRef = useRef<VoiceRecognition | null>(null);
  const stopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const intentRef = useRef<HTMLElement | null>(null);
  const stagesRef = useRef<HTMLOListElement | null>(null);
  const verdictRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    return () => {
      recognitionRef.current?.abort();
      if (stopTimerRef.current) {
        clearTimeout(stopTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (result) {
      scrollToElement(intentRef.current);
    }
  }, [result]);

  useEffect(() => {
    if (stage === "searching") {
      scrollToElement(stagesRef.current);
    }
  }, [stage]);

  useEffect(() => {
    if (verdict) {
      scrollToElement(verdictRef.current);
    }
  }, [verdict]);

  const effectiveCategory: Category | null =
    override ?? result?.intent.category ?? null;

  const visibleSources = useMemo(
    () =>
      effectiveCategory
        ? SOURCES.filter((s) => s.categories.includes(effectiveCategory))
        : [],
    [effectiveCategory],
  );

  const enabledCount = visibleSources.filter((s) => !disabled[s.id]).length;

  const cards: Array<{
    product: Product;
    score: RankedItem["score"] | null;
  }> = useMemo(() => {
    if (!verdict) {
      return [];
    }
    return verdict.ranked.slice(0, 5);
  }, [verdict]);

  const compareItems = useMemo(
    () =>
      compareIds
        .map((id) => cards.find((c) => c.product.id === id))
        .filter((c): c is { product: Product; score: RankedItem["score"] | null } => c != null),
    [compareIds, cards],
  );

  const statuses = verdict?.statuses ?? search?.statuses ?? [];
  const warnings = verdict?.warnings ?? search?.warnings ?? [];
  const searchedAt = verdict?.searchedAt ?? search?.searchedAt ?? null;

  function clearDownstream(): void {
    setSearch(null);
    setVerdict(null);
    setSearchError(null);
    setVerdictError(null);
    setCompareIds([]);
    setShowCompare(false);
    setStage("idle");
  }

  async function analyze(text: string): Promise<void> {
    const trimmed = text.trim();
    if (trimmed.length < 2 || loading) return;
    setLoading(true);
    setError(null);
    setResult(null);
    setOverride(null);
    clearDownstream();
    try {
      const response = await fetch("/api/intent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: trimmed }),
      });
      if (!response.ok) {
        throw new Error(`analysis failed (${response.status})`);
      }
      const data = (await response.json()) as IntentResponse;
      setResult(data);
    } catch {
      setError("Could not analyze that request. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  function toggleVoice(): void {
    if (listening) {
      if (stopTimerRef.current) {
        clearTimeout(stopTimerRef.current);
        stopTimerRef.current = null;
      }
      recognitionRef.current?.stop();
      return;
    }
    const Recognition = getVoiceRecognition();
    if (!Recognition) {
      setError("Voice input is not supported in this browser. Try Chrome or Edge.");
      return;
    }
    const recognition = new Recognition();
    recognitionRef.current = recognition;
    recognition.lang = "en-IN";
    recognition.interimResults = true;
    recognition.continuous = true;
    let finalTranscript = "";
    recognition.onresult = (event) => {
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const item = event.results[i];
        const transcript = item?.[0]?.transcript ?? "";
        if (item?.isFinal) {
          finalTranscript += transcript;
        } else {
          interim += transcript;
        }
      }
      setQuery(`${finalTranscript}${interim}`.trim());
      if (stopTimerRef.current) {
        clearTimeout(stopTimerRef.current);
      }
      stopTimerRef.current = setTimeout(() => {
        recognitionRef.current?.stop();
      }, 2000);
    };
    recognition.onerror = (event) => {
      if (stopTimerRef.current) {
        clearTimeout(stopTimerRef.current);
        stopTimerRef.current = null;
      }
      setListening(false);
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        setError("Microphone access was denied. Allow it in your browser to use voice input.");
      } else if (event.error !== "aborted") {
        setError("Voice input failed. Please type your request instead.");
      }
    };
    recognition.onend = () => {
      if (stopTimerRef.current) {
        clearTimeout(stopTimerRef.current);
        stopTimerRef.current = null;
      }
      setListening(false);
      recognitionRef.current = null;
    };
    setError(null);
    setListening(true);
    recognition.start();
  }

  async function runSearch(): Promise<void> {
    if (!result || !effectiveCategory || stage === "searching" || stage === "recommending") {
      return;
    }
    let phase: "search" | "recommend" = "search";
    setStage("searching");
    setSearch(null);
    setVerdict(null);
    setSearchError(null);
    setVerdictError(null);
    setCompareIds([]);
    setShowCompare(false);
    try {
      const searchResponse = await fetch("/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: result.intent.query,
          category: effectiveCategory,
          disabled,
        }),
      });
      const searchData = (await searchResponse.json()) as SearchData & {
        error?: string;
      };
      if (!searchResponse.ok) {
        throw new Error(searchData.error ?? `search failed (${searchResponse.status})`);
      }
      setSearch(searchData);
      phase = "recommend";
      setStage("recommending");
      const recommendResponse = await fetch("/api/recommend", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: result.intent.query,
          category: effectiveCategory,
          intent: result.intent,
          products: searchData.products,
          statuses: searchData.statuses,
          searchedAt: searchData.searchedAt,
        }),
      });
      const verdictData = (await recommendResponse.json()) as VerdictData & {
        error?: string;
      };
      if (!recommendResponse.ok) {
        throw new Error(
          verdictData.error ?? `recommendation failed (${recommendResponse.status})`,
        );
      }
      setVerdict(verdictData);
      setStage("done");
    } catch (e) {
      const message = e instanceof Error ? e.message : "Search failed. Please try again.";
      if (phase === "search") {
        setSearchError(message);
      } else {
        setVerdictError(message);
      }
      setStage("done");
    }
  }

  function toggleSource(id: string): void {
    setDisabled((prev) => ({ ...prev, [id]: !prev[id] }));
    clearDownstream();
  }

  function toggleCompare(id: string): void {
    setCompareIds((prev) => {
      if (prev.includes(id)) {
        return prev.filter((c) => c !== id);
      }
      if (prev.length >= MAX_COMPARE) {
        return prev;
      }
      return [...prev, id];
    });
  }

  function stageState(id: (typeof STAGES)[number]["id"]): "done" | "active" | "pending" {
    if (!result) {
      return "pending";
    }
    if (id === "understand" || id === "category") {
      return "done";
    }
    if (stage === "idle") {
      return "pending";
    }
    if (stage === "searching") {
      return id === "search" ? "active" : "pending";
    }
    if (stage === "recommending") {
      if (id === "search") {
        return "done";
      }
      return id === "compare" ? "active" : "pending";
    }
    return "done";
  }

  const verdictBadge = (v: Recommendation["verdict"]): string => {
    switch (v) {
      case "BUY":
        return "bg-teal-300 text-teal-950";
      case "WAIT":
        return "bg-amber-300 text-amber-950";
      case "AVOID":
        return "bg-red-400 text-red-950";
      default:
        return "border border-white/15 bg-white/10 text-stone-200";
    }
  };

  const verdictLabel = (v: Recommendation["verdict"]): string =>
    v === "NEEDS_MORE_INFO" ? "NEEDS MORE INFO" : v;

  const verdictProduct =
    verdict?.recommendation.productId != null
      ? cards.find((c) => c.product.id === verdict.recommendation.productId)?.product ?? null
      : null;

  return (
    <main className="relative mx-auto min-h-screen max-w-3xl px-4 py-10 text-stone-200 sm:px-6">
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-0 -z-10 bg-[radial-gradient(70rem_32rem_at_50%_-12%,rgba(45,212,191,0.09),transparent_60%),radial-gradient(40rem_24rem_at_85%_110%,rgba(45,212,191,0.05),transparent_60%)]"
      />
      <header className="mb-10">
        <p className="text-sm font-semibold tracking-[0.2em] text-teal-300 uppercase">
          Wisora
        </p>
        <h1 className="mt-3 font-serif text-4xl leading-tight text-stone-50 sm:text-5xl">
          Buy smarter, with evidence.
        </h1>
        <p className="mt-3 max-w-xl text-base leading-relaxed text-stone-400">
          Describe what you want. Wisora finds real options across trusted
          Indian stores, compares them, and recommends with reasons —
          never guesses.
        </p>
      </header>

      <section aria-label="Describe your need">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void analyze(query);
          }}
        >
          <label
            htmlFor="query"
            className="mb-2 block text-sm font-medium text-stone-300"
          >
            What are you looking to buy?
          </label>
          <textarea
            id="query"
            rows={3}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="e.g. Find a laptop under ₹90,000 for .NET development."
            className="w-full resize-y rounded-xl border border-white/10 bg-white/5 p-3 text-base text-stone-100 shadow-[inset_0_2px_8px_rgb(0,0,0,0.3)] backdrop-blur-xl placeholder:text-stone-500 focus:border-teal-300/60 focus:ring-2 focus:ring-teal-300/20 focus:outline-none"
          />
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="submit"
              disabled={loading || query.trim().length < 2}
              className="rounded-lg bg-white px-5 py-2.5 text-sm font-semibold text-stone-950 transition hover:bg-teal-200 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {loading ? (
                <span className="flex items-center gap-2">
                  <span
                    aria-hidden="true"
                    className="h-4 w-4 rounded-full border-2 border-stone-950/30 border-t-stone-950 motion-safe:animate-spin"
                  />
                  Analyzing…
                </span>
              ) : (
                "Analyze request"
              )}
            </button>
            <button
              type="button"
              onClick={toggleVoice}
              disabled={!voiceSupported}
              aria-pressed={listening}
              title={
                voiceSupported
                  ? "Search by voice"
                  : "Voice input is not supported in this browser"
              }
              className="rounded-lg border border-white/15 bg-white/5 px-4 py-2.5 text-sm font-semibold text-stone-200 backdrop-blur transition hover:border-teal-300/50 hover:text-teal-200 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {listening ? (
                <span className="flex items-center gap-2">
                  <span
                    aria-hidden="true"
                    className="inline-block h-2 w-2 rounded-full bg-red-400 motion-safe:animate-pulse"
                  />
                  Listening… tap to stop
                </span>
              ) : (
                <span className="flex items-center gap-2">
                  <svg
                    aria-hidden="true"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="h-4 w-4"
                  >
                    <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
                    <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                    <line x1="12" x2="12" y1="19" y2="22" />
                  </svg>
                  Voice input
                </span>
              )}
            </button>
            <span className="text-xs text-stone-500">
              Search runs against live sources only — no mock data.
            </span>
          </div>
        </form>

        <div className="mt-4 flex flex-wrap gap-2" aria-label="Example requests">
          {EXAMPLES.map((example) => (
            <button
              key={example}
              type="button"
              onClick={() => {
                setQuery(example);
                void analyze(example);
              }}
              className="rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-left text-xs text-stone-300 backdrop-blur transition hover:border-teal-300/40 hover:text-teal-200"
            >
              {example}
            </button>
          ))}
        </div>
      </section>

      <div aria-live="polite">
        {error && (
          <p className="mt-6 rounded-lg border border-red-400/30 bg-red-500/10 p-3 text-sm text-red-200 backdrop-blur">
            {error}
          </p>
        )}

        {result && (
          <section
            aria-label="Detected requirements"
            ref={intentRef}
            className="glass mt-8 scroll-mt-4 rounded-2xl p-5"
          >
            <h2 className="text-base font-semibold text-stone-100">
              What we understood
            </h2>
            <dl className="mt-3 space-y-2 text-sm">
              <div className="flex flex-wrap gap-2">
                <dt className="font-medium text-stone-300">Category:</dt>
                <dd>
                  <span className="rounded-full border border-teal-300/25 bg-teal-300/10 px-2.5 py-0.5 font-semibold text-teal-200">
                    {categoryLabel(result.intent.category)}
                  </span>{" "}
                  <span className="text-xs text-stone-500">
                    ({result.intent.categoryConfidence} confidence
                    {result.llmUsed ? ", refined with Muse" : ", rule-based"})
                  </span>
                </dd>
              </div>
              <div className="flex gap-2">
                <dt className="font-medium text-stone-300">Budget:</dt>
                <dd className="text-stone-400">
                  {result.intent.budgetInr?.min != null &&
                  result.intent.budgetInr?.max != null
                    ? `${formatInr(result.intent.budgetInr.min)} – ${formatInr(result.intent.budgetInr.max)}`
                    : result.intent.budgetInr?.max != null
                      ? `up to ${formatInr(result.intent.budgetInr.max)}`
                      : result.intent.budgetInr?.min != null
                        ? `from ${formatInr(result.intent.budgetInr.min)}`
                        : "no budget detected"}
                </dd>
              </div>
              <div className="flex gap-2">
                <dt className="font-medium text-stone-300">Search terms:</dt>
                <dd className="text-stone-400">{result.intent.searchTerms}</dd>
              </div>
            </dl>

            <div className="mt-4">
              <h3 className="text-sm font-medium text-stone-200">
                Category{" "}
                <span className="font-normal text-stone-500">
                  — pick one if we got it wrong
                </span>
              </h3>
              <div className="mt-2 flex flex-wrap gap-2" role="group" aria-label="Correct the category">
                {CATEGORIES.map((c) => {
                  const active = effectiveCategory === c.id;
                  const detected = !override && result.intent.category === c.id;
                  return (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => {
                        setOverride(detected ? null : c.id);
                        clearDownstream();
                      }}
                      aria-pressed={active}
                      className={
                        active
                          ? "rounded-full bg-teal-300 px-3 py-1.5 text-xs font-semibold text-teal-950"
                          : "rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-stone-300 hover:border-white/30"
                      }
                    >
                      {c.label}
                      {detected ? " · detected" : ""}
                    </button>
                  );
                })}
              </div>
            </div>

            <fieldset className="mt-4">
              <legend className="text-sm font-medium text-stone-200">
                Sources to search ({enabledCount} of {visibleSources.length})
              </legend>
              <ul className="mt-2 space-y-1.5">
                {visibleSources.map((s) => (
                  <li key={s.id}>
                    <label className="flex cursor-pointer items-center gap-2.5 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-sm transition hover:border-white/25">
                      <input
                        type="checkbox"
                        checked={!disabled[s.id]}
                        onChange={() => toggleSource(s.id)}
                        className="h-4 w-4 accent-teal-300"
                      />
                      <span className="font-medium text-stone-200">
                        {s.name}
                      </span>
                      <span className="text-xs text-stone-500">{s.domain}</span>
                    </label>
                  </li>
                ))}
              </ul>
              {!result.llmAvailable && (
                <p className="mt-3 text-xs text-stone-500">
                  Muse assistance is unavailable (no API key configured) —
                  analysis is rule-based only.
                </p>
              )}
            </fieldset>

            <div className="mt-5 border-t border-white/10 pt-4">
              <button
                type="button"
                onClick={() => void runSearch()}
                disabled={
                  stage === "searching" ||
                  stage === "recommending" ||
                  enabledCount === 0
                }
                className="rounded-lg bg-white px-5 py-2.5 text-sm font-semibold text-stone-950 transition hover:bg-teal-200 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {stage === "searching" || stage === "recommending" ? (
                  <span className="flex items-center gap-2">
                    <span
                      aria-hidden="true"
                      className="h-4 w-4 rounded-full border-2 border-stone-950/30 border-t-stone-950 motion-safe:animate-spin"
                    />
                    {stage === "searching" ? "Searching…" : "Preparing recommendation…"}
                  </span>
                ) : (
                  `Search ${enabledCount} source${enabledCount === 1 ? "" : "s"}`
                )}
              </button>
              {enabledCount === 0 && (
                <p className="mt-2 text-xs text-stone-500">
                  Enable at least one source to search.
                </p>
              )}

              {stage !== "idle" && (
                <ol ref={stagesRef} className="mt-4 scroll-mt-4" aria-label="Research progress">
                  {STAGES.map((s, index) => {
                    const state = stageState(s.id);
                    const last = index === STAGES.length - 1;
                    return (
                      <li key={s.id} className="flex gap-3">
                        <span className="flex flex-col items-center" aria-hidden="true">
                          {state === "done" ? (
                            <span className="flex h-5 w-5 items-center justify-center rounded-full bg-teal-300 text-[10px] font-bold text-teal-950">
                              ✓
                            </span>
                          ) : state === "active" ? (
                            <span className="relative flex h-5 w-5 items-center justify-center">
                              <span className="absolute h-5 w-5 rounded-full bg-teal-300/40 motion-safe:animate-ping" />
                              <span className="h-2.5 w-2.5 rounded-full bg-teal-300" />
                            </span>
                          ) : (
                            <span className="flex h-5 w-5 items-center justify-center rounded-full border border-white/15 text-[10px] text-stone-600">
                              {index + 1}
                            </span>
                          )}
                          {!last && (
                            <span
                              className={`w-px flex-1 ${state === "done" ? "bg-teal-300/40" : "bg-white/10"}`}
                            />
                          )}
                        </span>
                        <span
                          className={`pb-4 text-sm ${
                            state === "pending"
                              ? "text-stone-600"
                              : state === "active"
                                ? "font-medium text-teal-200"
                                : "text-stone-400"
                          }`}
                        >
                          {s.label}
                        </span>
                      </li>
                    );
                  })}
                </ol>
              )}

              {searchError && (
                <p className="mt-3 rounded-lg border border-red-400/30 bg-red-500/10 p-3 text-sm text-red-200 backdrop-blur">
                  {searchError}
                </p>
              )}
              {verdictError && (
                <p className="mt-3 rounded-lg border border-amber-300/30 bg-amber-400/10 p-3 text-sm text-amber-200 backdrop-blur">
                  {verdictError} Please try again.
                </p>
              )}
            </div>
          </section>
        )}

        {verdict && (
          <section
            aria-label="Recommendation"
            ref={verdictRef}
            className="glass mt-6 scroll-mt-4 rounded-2xl p-5 motion-safe:animate-[fade-rise_0.5s_ease-out]"
          >
            <div className="flex flex-wrap items-center gap-3">
              <span
                className={`rounded-md px-3 py-1.5 text-sm font-bold tracking-wide ${verdictBadge(verdict.recommendation.verdict)}`}
              >
                {verdictLabel(verdict.recommendation.verdict)}
              </span>
              <span className="text-xs text-stone-500">
                {verdict.reasoningUsed === "llm"
                  ? "Reasoned with Muse over verified results"
                  : "Rule-based recommendation"}
              </span>
            </div>
            <p className="mt-3 text-base leading-relaxed text-stone-100">
              {verdict.recommendation.reason}
            </p>
            {verdictProduct && (
              <p className="mt-2 text-sm">
                <a
                  href={verdictProduct.url}
                  target="_blank"
                  rel="noreferrer"
                  className="font-medium text-teal-300 hover:underline"
                >
                  Open {verdictProduct.title} at {verdictProduct.merchant} →
                </a>
              </p>
            )}
            {verdict.recommendation.tradeoffs.length > 0 && (
              <div className="mt-3">
                <h3 className="text-sm font-semibold text-stone-200">
                  Trade-offs
                </h3>
                <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-stone-400">
                  {verdict.recommendation.tradeoffs.map((t) => (
                    <li key={t}>{t}</li>
                  ))}
                </ul>
              </div>
            )}
            {verdict.recommendation.uncertainties.length > 0 && (
              <div className="mt-3">
                <h3 className="text-sm font-semibold text-stone-200">
                  Uncertainties
                </h3>
                <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-stone-400">
                  {verdict.recommendation.uncertainties.map((u) => (
                    <li key={u}>{u}</li>
                  ))}
                </ul>
              </div>
            )}
          </section>
        )}

        {verdict && (
          <section aria-label="Product results" className="mt-6">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-base font-semibold text-stone-100">
                Top 5 picks
              </h2>
              <p className="text-xs text-stone-500">
                Showing {cards.length} of {verdict.ranked.length} options ·{" "}
                {
                  statuses.filter(
                    (s) => s.ok && s.resultCount > 0,
                  ).length
                }{" "}
                of {statuses.length} sources returned results
                {searchedAt
                  ? ` · ${new Date(searchedAt).toLocaleTimeString("en-IN")}`
                  : ""}
              </p>
            </div>
            {warnings.map((warning) => (
              <p key={warning} className="mt-1 text-xs text-amber-200/80">
                {warning}
              </p>
            ))}

            {compareIds.length > 0 && (
              <div className="glass sticky bottom-4 z-10 mt-4 flex flex-wrap items-center gap-3 rounded-2xl px-4 py-2.5">
                <p className="text-sm text-stone-300">
                  {compareIds.length} selected for comparison
                  {compareIds.length >= MAX_COMPARE
                    ? ` (max ${MAX_COMPARE})`
                    : ""}
                </p>
                <button
                  type="button"
                  onClick={() => setShowCompare((v) => !v)}
                  disabled={compareIds.length < 2}
                  className="rounded-md border border-white/20 bg-white/10 px-3 py-1 text-xs font-semibold text-stone-100 hover:border-teal-300/40 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {showCompare ? "Hide comparison" : "Compare side by side"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setCompareIds([]);
                    setShowCompare(false);
                  }}
                  className="text-xs text-stone-500 hover:text-stone-200 hover:underline"
                >
                  Clear
                </button>
              </div>
            )}

            {showCompare && compareItems.length >= 2 && (
              <div className="glass mt-3 overflow-x-auto rounded-xl">
                <table className="w-full min-w-[560px] border-collapse text-sm">
                  <thead>
                    <tr className="border-b border-white/10">
                      <th className="w-28 p-3 text-left align-top" scope="col">
                        <span className="sr-only">Attribute</span>
                      </th>
                      {compareItems.map(({ product }) => (
                        <th key={product.id} className="p-3 text-left align-top" scope="col">
                          <a
                            href={product.url}
                            target="_blank"
                            rel="noreferrer"
                            className="font-medium text-stone-100 hover:text-teal-200 hover:underline"
                          >
                            {product.title}
                          </a>
                          <span className="mt-0.5 block text-xs font-normal text-stone-500">
                            {product.merchant}
                          </span>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/10">
                    <tr>
                      <th className="p-3 text-left font-medium text-stone-300" scope="row">
                        Price
                      </th>
                      {compareItems.map(({ product }) => (
                        <td key={product.id} className="p-3 text-stone-400">
                          {product.priceInr != null
                            ? formatInr(product.priceInr)
                            : "Unavailable"}
                        </td>
                      ))}
                    </tr>
                    <tr>
                      <th className="p-3 text-left font-medium text-stone-300" scope="row">
                        Evidence
                      </th>
                      {compareItems.map(({ product }) => (
                        <td key={product.id} className="p-3 text-stone-400">
                          {product.priceInr == null
                            ? "Unverified"
                            : product.priceEvidence === "repeated"
                              ? "Corroborated"
                              : "Seen once"}
                        </td>
                      ))}
                    </tr>
                    <tr>
                      <th className="p-3 text-left font-medium text-stone-300" scope="row">
                        Reviews
                      </th>
                      {compareItems.map(({ product }) => (
                        <td key={product.id} className="p-3 text-stone-400">
                          {product.rating != null ? (
                            <span className="inline-flex items-center gap-1.5">
                              <Stars value={product.rating.value} />
                              <span>
                                {product.rating.value.toFixed(1)}
                                {product.rating.count != null
                                  ? ` (${formatCount(product.rating.count)})`
                                  : ""}
                              </span>
                            </span>
                          ) : (
                            "Unavailable"
                          )}
                        </td>
                      ))}
                    </tr>
                    <tr>
                      <th className="p-3 text-left font-medium text-stone-300" scope="row">
                        Score
                      </th>
                      {compareItems.map(({ product, score }) => (
                        <td key={product.id} className="p-3 text-stone-400">
                          {score ? `${score.total} / 100` : "—"}
                        </td>
                      ))}
                    </tr>
                    <tr>
                      <th className="p-3 text-left font-medium text-stone-300" scope="row">
                        Listing
                      </th>
                      {compareItems.map(({ product }) => (
                        <td key={product.id} className="p-3">
                          <a
                            href={product.url}
                            target="_blank"
                            rel="noreferrer"
                            className="text-teal-300 hover:underline"
                          >
                            Open →
                          </a>
                        </td>
                      ))}
                    </tr>
                  </tbody>
                </table>
              </div>
            )}

            {cards.length === 0 ? (
              <div className="mt-3 flex items-center gap-3 rounded-lg border border-white/10 bg-white/[0.03] p-4">
                <svg
                  aria-hidden="true"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  className="h-8 w-8 shrink-0 text-stone-600"
                >
                  <circle cx="11" cy="11" r="7" />
                  <line x1="16.5" x2="21" y1="16.5" y2="21" strokeLinecap="round" />
                </svg>
                <p className="text-sm text-stone-400">
                  No products found. Try different terms, a corrected
                  category, or more sources.
                </p>
              </div>
            ) : (
              <ul className="mt-3 space-y-3">
                {cards.map(({ product: p, score }, index) => {
                  const pros = (score?.reasons ?? []).filter(
                    (r) => r.sentiment === "pro",
                  );
                  const cons = (score?.reasons ?? []).filter(
                    (r) => r.sentiment === "con",
                  );
                  const checked = compareIds.includes(p.id);
                  const compareDisabled =
                    !checked && compareIds.length >= MAX_COMPARE;
                  return (
                    <li
                      key={p.id}
                      className="glass rounded-xl p-4 transition hover:border-teal-300/25"
                    >
                      <div className="flex gap-4">
                        <ProductImage url={p.imageUrl} merchant={p.merchant} />
                        <div className="min-w-0 flex-1">
                          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-stone-500">
                            <span>
                              #{index + 1} · {p.merchant}
                            </span>
                            {score ? <ScoreMeter total={score.total} /> : null}
                          </p>
                          <a
                            href={p.url}
                            target="_blank"
                            rel="noreferrer"
                            className="mt-0.5 block truncate font-medium text-stone-50 hover:text-teal-200 hover:underline"
                            title={p.title}
                          >
                            {p.title}
                          </a>
                          <p className="mt-1 text-sm text-stone-200">
                            {p.priceInr != null
                              ? `${formatInr(p.priceInr)}${p.priceEvidence === "single" ? " · seen once — confirm on site" : " · seen on page"}`
                              : "Price unavailable"}
                          </p>
                          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm text-stone-400">
                            {p.rating != null ? (
                              <>
                                <Stars value={p.rating.value} />
                                <span>
                                  {p.rating.value.toFixed(1)}
                                  {p.rating.count != null
                                    ? ` · ${formatCount(p.rating.count)} ratings`
                                    : ""}
                                </span>
                                <span className="text-xs text-stone-500">(seen on page)</span>
                              </>
                            ) : (
                              "No rating found"
                            )}
                          </p>
                        </div>
                        <label className="flex shrink-0 cursor-pointer items-start gap-1.5 text-xs text-stone-400">
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={compareDisabled}
                            onChange={() => toggleCompare(p.id)}
                            className="mt-0.5 h-4 w-4 accent-teal-300 disabled:cursor-not-allowed"
                          />
                          Compare
                        </label>
                      </div>
                      {p.snippet && (
                        <p className="mt-2 line-clamp-3 text-sm text-stone-500">
                          {p.snippet}
                        </p>
                      )}
                      {(pros.length > 0 || cons.length > 0) && (
                        <ul className="mt-2 space-y-1 text-sm">
                          {pros.slice(0, 2).map((r) => (
                            <li key={r.text} className="text-teal-300">
                              + {r.text}
                            </li>
                          ))}
                          {cons.slice(0, 2).map((r) => (
                            <li key={r.text} className="text-rose-300">
                              – {r.text}
                            </li>
                          ))}
                        </ul>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        )}
      </div>
    </main>
  );
}
