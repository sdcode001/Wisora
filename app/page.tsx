"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { SOURCES, type Category } from "../config/sources";
import type { Intent } from "../lib/intent/types";
import { normalizeWeights } from "../lib/recommend/weights";
import {
  LEGACY_WORKFLOW_KEY,
  clearStoredWorkflow,
  loadStoredWorkflow,
  saveStoredWorkflow,
  workflowStorageKey,
} from "../lib/workflow/persist";
import {
  clearHistory as clearStoredHistory,
  historyStorageKey,
  loadHistory,
  removeHistoryEntry,
  saveHistoryEntry,
  type HistoryEntry,
} from "../lib/workflow/history";

const CATEGORIES: Array<{ id: Category; label: string }> = [
  { id: "electronics", label: "Electronics" },
  { id: "fashion", label: "Fashion" },
  { id: "footwear", label: "Footwear" },
  { id: "beauty", label: "Beauty & Skincare" },
  { id: "home-kitchen", label: "Home & Kitchen" },
  { id: "general", label: "General" },
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

interface AuthUser {
  sub: string;
  name: string | null;
  email: string | null;
  picture: string | null;
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
  source?: "query" | "profile";
}

interface RequirementCheck {
  key: string;
  label: string;
  kind: "must" | "want" | "exclude";
  status: "met" | "not-met" | "unknown";
}

interface AttributeEvidence {
  status: "verified" | "observed" | "missing" | "conflicting";
  detail?: string;
  sources: Array<{ url: string; retrievedAt: string }>;
}

interface ProductEvidence {
  productId: string;
  price: AttributeEvidence;
  rating: AttributeEvidence;
  specs: AttributeEvidence;
  identity: AttributeEvidence;
  stale: boolean;
}

interface RankedItem {
  product: Product;
  score: {
    price: number;
    relevance: number;
    evidence: number;
    wants: number;
    total: number;
    reasons: ScoreReason[];
  };
  analysis: {
    checks: RequirementCheck[];
    evidence: ProductEvidence | null;
  };
}

interface RequirementItem {
  key: string;
  label: string;
  kind: "must" | "want" | "exclude";
  importance: number;
}

interface RequirementSetData {
  category: string;
  useContext?: string;
  must: RequirementItem[];
  want: RequirementItem[];
  exclude: RequirementItem[];
  unanswered: string[];
}

interface ClarificationQuestion {
  id: string;
  prompt: string;
  options?: string[];
  freeText: boolean;
}

interface RequirementsResponse {
  requirements: RequirementSetData;
  questions: ClarificationQuestion[];
  suggestedCategory: string | null;
}

interface ReviewInsightData {
  theme: string;
  category: string;
  sentiment: "positive" | "negative" | "mixed";
  sources: string[];
  distinctSources: number;
  excerpt?: string;
  quality: string;
  limitations: string[];
}

interface ReviewRecordData {
  id: string;
  url: string;
  sourceName: string;
  sourceType: string;
  title: string;
  contentSource: string;
  retrievedAt: string;
  relevance: string;
  duplicateOf?: string;
}

interface ReviewReportData {
  productId: string;
  records: ReviewRecordData[];
  insights: ReviewInsightData[];
  contradictions: Array<{
    topic: string;
    positiveSources: string[];
    negativeSources: string[];
    note: string;
  }>;
  quality: { level: string; distinctSources: number; exactMatches: number };
  adjustment: { delta: number; reasons: string[]; unknownDimension: boolean };
  adjustedTotal: number | null;
  limitations: string[];
}

interface ReviewsResponse {
  reports: ReviewReportData[];
  rankImpact: string[];
  wouldChangeTopPick: boolean;
  warnings: string[];
}

interface ExcludedItem {
  productId: string;
  title: string;
  merchant: string;
  reasons: string[];
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
  verdict: "BUY" | "WAIT" | "AVOID" | "INSUFFICIENT_EVIDENCE" | "NEEDS_CLARIFICATION";
  productId?: string;
  reason: string;
  tradeoffs: string[];
  uncertainties: string[];
  source: "llm" | "rules";
}

interface VerdictData {
  ranked: RankedItem[];
  excluded: ExcludedItem[];
  excludedByBudget: number;
  recommendation: Recommendation;
  reasoningUsed: "llm" | "rules";
  statuses: SourceStatus[];
  searchedAt: string;
  warnings: string[];
  requirements: RequirementSetData;
  confidence: { score: number; level: string; gaps: string[] };
  runnerUpDiff: string[];
  intent?: Intent;
  personalization?: PersonalizationData;
}

interface PersonalizationData {
  enabled: boolean;
  reason?: "signed-out" | "opted-out" | "no-profile" | "unreadable";
  applied: string[];
  skipped: string[];
  budgetSource: "query" | "profile" | "none";
  weightsSource: "request" | "profile" | "default";
}

type Provenance = "explicit" | "confirmed" | "inferred";

interface StoredSection<T> {
  value: T;
  updatedAt: string;
  provenance: Provenance;
}

interface GeneralValue {
  currency: string;
  locale: string;
  categories: Category[];
  preferredBrands: string[];
  avoidedBrands: string[];
  preferredMerchants: string[];
  decisionPriority?: string;
}

interface CategoryValue {
  category: Category;
  budgetInr?: { min?: number; max?: number };
  useCase?: string;
  performanceLevel?: string;
  minRamGb?: number;
  minStorageGb?: number;
  batteryPriority?: number;
  portability?: string;
  warrantyPriority?: number;
  sizes?: string[];
  styles?: string[];
  materials?: string[];
  concerns?: string[];
  notes?: string;
}

interface ProfileData {
  version: 1;
  userSub: string;
  general: StoredSection<GeneralValue>;
  categories: Partial<Record<Category, StoredSection<CategoryValue>>>;
}

interface ProposalData {
  id: string;
  createdAt: string;
  status: "pending" | "confirmed" | "rejected";
  kind: "general" | "category";
  category?: Category;
  patch: Record<string, unknown>;
  reason: string;
  evidence: string[];
  fingerprint: string;
}

interface MemorySummary {
  hasProfile: boolean;
  profileUpdated?: string;
  decisions: number;
  feedback: number;
  savedProducts: number;
  savedComparisons: number;
  proposalsPending: number;
}

interface WatchData {
  id: string;
  productId: string;
  url: string;
  title: string;
  merchant: string;
  targetPrice: number;
  active: boolean;
  canWait: boolean;
  lastCheck?: {
    at: string;
    priceInr?: number;
    status: "ok" | "no-price" | "unavailable" | "fetch-failed";
    error?: string;
  };
  lastAlertAt?: string;
  lastAlertedPrice?: number;
}

interface PriceObservationData {
  productId: string;
  priceInr: number;
  observedAt: string;
  evidence: "repeated" | "single";
  source: "search" | "watch-check";
}

interface PriceStatsData {
  count: number;
  windowDays: number;
  latest: PriceObservationData | null;
  stale: boolean;
  min: { priceInr: number; observedAt: string } | null;
  max: { priceInr: number; observedAt: string } | null;
  averageInr: number | null;
  changeVsPrevious: { absoluteInr: number; percent: number } | null;
}

interface EnrichedWatch {
  watch: WatchData;
  latest: PriceObservationData | null;
  stats: PriceStatsData;
  recent: PriceObservationData[];
  unreadAlerts: number;
}

interface CardInsight {
  latest: PriceObservationData | null;
  stats: PriceStatsData;
  recent: PriceObservationData[];
}

interface AlertData {
  id: string;
  watchId: string;
  title: string;
  merchant: string;
  url: string;
  observedPrice: number;
  targetPrice: number;
  observedAt: string;
  read: boolean;
  email?: { attempted: boolean; sent: boolean; error?: string };
}

interface MonitorData {
  active: boolean;
  intervalMinutes: number;
  maxChecksPerCycle: number;
  tavilyConfigured: boolean;
  emailConfigured: boolean;
  lastRun: MonitorRunData | null;
}

interface MonitorRunData {
  startedAt: string;
  finishedAt: string;
  checked: number;
  ok: number;
  failed: number;
  alerts: number;
  opportunities: number;
  remindersFired: number;
  emails: number;
}

type OpportunityKind =
  | "target-reached"
  | "price-drop"
  | "price-increase"
  | "back-in-range"
  | "restored"
  | "unavailable"
  | "reminder-due";

type OpportunityStatus = "active" | "read" | "dismissed";

interface OpportunityData {
  id: string;
  createdAt: string;
  kind: OpportunityKind;
  status: OpportunityStatus;
  watchId?: string;
  category?: Category;
  relevance?: { score: number; reasons: string[] };
  productId: string;
  title: string;
  merchant: string;
  url: string;
  imageUrl?: string;
  currentPriceInr: number | null;
  previousPriceInr: number | null;
  targetPriceInr: number | null;
  reason: string;
  decisionContext?: string;
  email?: { attempted: boolean; sent: boolean; error?: string };
  evidence: {
    source: "search" | "watch-check" | "reminder";
    observedAt: string;
    previousObservedAt?: string;
  };
}

interface ReminderData {
  id: string;
  createdAt: string;
  title: string;
  url?: string;
  merchant?: string;
  productId?: string;
  watchId?: string;
  kind: "one-time";
  remindAt: string;
  timezone: string;
  note?: string;
  targetPriceInr?: number;
  status: "active" | "done" | "disabled";
  firedAt?: string;
  firedBecause?: "time" | "target";
}

interface NotificationSettingsData {
  proactiveEnabled: boolean;
  priceEmails: boolean;
  availabilityEmails: boolean;
  reminderEmails: boolean;
  updatedAt?: string;
}

type OppTab = "active" | "read" | "dismissed";

interface ReminderDraft {
  id: string | null;
  title: string;
  remindAtLocal: string;
  timezone: string;
  note: string;
  targetPrice: string;
  productId: string | null;
  url: string | null;
  merchant: string | null;
  watchId: string | null;
}

interface ChatMessageData {
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt: string;
  sources?: Array<{ label: string; url?: string }>;
}

interface ChatThreadData {
  id: string;
  createdAt: string;
  updatedAt: string;
  title: string;
  messages: ChatMessageData[];
}

interface ChatProductHint {
  productId: string;
  title: string;
}

interface TrackDraft {
  productId: string;
  url: string;
  title: string;
  merchant: string;
  sourceId: string;
  currentPrice: number | null;
  target: string;
  canWait: boolean;
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

const DEFAULT_WEIGHT_STATE = {
  price: 35,
  relevance: 30,
  evidence: 20,
  wants: 15,
};

const WEIGHT_LABELS: Record<keyof typeof DEFAULT_WEIGHT_STATE, string> = {
  price: "Price fit",
  relevance: "Relevance",
  evidence: "Evidence",
  wants: "Preferences",
};

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

interface PersistedWorkflow {
  version: 1;
  query: string;
  result: IntentResponse | null;
  override: Category | null;
  disabled: Record<string, boolean>;
  reqs: RequirementsResponse | null;
  answers: Record<string, string>;
  weights: typeof DEFAULT_WEIGHT_STATE;
  allowOverBudget: boolean;
  search: SearchData | null;
  verdict: VerdictData | null;
  reviews: ReviewsResponse | null;
  compareIds: string[];
  showCompare: boolean;
  error: string | null;
  searchError: string | null;
  verdictError: string | null;
  reqsError: string | null;
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

function BreakdownBars({
  score,
}: {
  score: { price: number; relevance: number; evidence: number; wants: number };
}) {
  const rows: Array<[string, number, string]> = [
    ["Price", score.price, "bg-teal-300"],
    ["Relevance", score.relevance, "bg-sky-300"],
    ["Evidence", score.evidence, "bg-amber-300"],
    ["Prefs", score.wants, "bg-violet-300"],
  ];
  const max = Math.max(
    1,
    score.price,
    score.relevance,
    score.evidence,
    score.wants,
  );
  return (
    <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1">
      {rows.map(([label, value, bar]) => (
        <div
          key={label}
          className="flex items-center gap-2 text-xs text-stone-500"
        >
          <dt className="w-14 shrink-0">{label}</dt>
          <dd className="flex flex-1 items-center gap-1.5">
            <span className="h-1 flex-1 overflow-hidden rounded-full bg-white/10">
              <span
                className={`block h-full rounded-full ${bar}`}
                style={{ width: `${(value / max) * 100}%` }}
              />
            </span>
            <span className="w-6 text-right text-stone-400">{value}</span>
          </dd>
        </div>
      ))}
    </dl>
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

const DECISION_PRIORITIES = [
  { id: "", label: "No preference" },
  { id: "lowest-price", label: "Lowest price" },
  { id: "best-value", label: "Best overall value" },
  { id: "performance", label: "Performance" },
  { id: "durability", label: "Durability" },
  { id: "premium", label: "Premium quality" },
] as const;

interface GeneralDraft {
  currency: string;
  locale: string;
  categories: Category[];
  preferredBrands: string;
  avoidedBrands: string;
  preferredMerchants: string;
  decisionPriority: string;
}

type CategoryField =
  | "budgetMin"
  | "budgetMax"
  | "useCase"
  | "performanceLevel"
  | "minRamGb"
  | "minStorageGb"
  | "batteryPriority"
  | "portability"
  | "warrantyPriority"
  | "sizes"
  | "styles"
  | "materials"
  | "concerns"
  | "notes";

type CategoryDraft = Record<CategoryField, string>;

const CATEGORY_FIELDS: Record<Category, CategoryField[]> = {
  electronics: [
    "budgetMin",
    "budgetMax",
    "useCase",
    "performanceLevel",
    "minRamGb",
    "minStorageGb",
    "batteryPriority",
    "portability",
    "warrantyPriority",
    "notes",
  ],
  fashion: ["budgetMin", "budgetMax", "sizes", "styles", "materials", "notes"],
  footwear: ["budgetMin", "budgetMax", "sizes", "useCase", "notes"],
  beauty: ["budgetMin", "budgetMax", "concerns", "notes"],
  "home-kitchen": ["budgetMin", "budgetMax", "useCase", "notes"],
  general: ["budgetMin", "budgetMax", "notes"],
};

const CATEGORY_FIELD_LABELS: Record<CategoryField, string> = {
  budgetMin: "Minimum budget (₹)",
  budgetMax: "Maximum budget (₹)",
  useCase: "Primary use",
  performanceLevel: "Performance level",
  minRamGb: "Minimum RAM (GB)",
  minStorageGb: "Minimum storage (GB)",
  batteryPriority: "Battery priority (0–1)",
  portability: "Portability",
  warrantyPriority: "Warranty priority (0–1)",
  sizes: "Sizes (comma-separated)",
  styles: "Styles (comma-separated)",
  materials: "Materials (comma-separated)",
  concerns: "Concerns (comma-separated)",
  notes: "Notes",
};

function emptyGeneralDraft(): GeneralDraft {
  return {
    currency: "INR",
    locale: "en-IN",
    categories: [],
    preferredBrands: "",
    avoidedBrands: "",
    preferredMerchants: "",
    decisionPriority: "",
  };
}

function emptyCategoryDraft(): CategoryDraft {
  return {
    budgetMin: "",
    budgetMax: "",
    useCase: "",
    performanceLevel: "",
    minRamGb: "",
    minStorageGb: "",
    batteryPriority: "",
    portability: "",
    warrantyPriority: "",
    sizes: "",
    styles: "",
    materials: "",
    concerns: "",
    notes: "",
  };
}

function parseCommaList(text: string): string[] {
  return text
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function provenanceLabel(provenance: Provenance): string {
  switch (provenance) {
    case "explicit":
      return "set by you";
    case "confirmed":
      return "confirmed suggestion";
    case "inferred":
      return "approved inference";
  }
}

function formatSavedDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return date.toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function formatRelative(iso: string, nowMs: number): string {
  const ms = new Date(iso).getTime();
  if (!Number.isFinite(ms)) {
    return "unknown time";
  }
  const diffMs = nowMs - ms;
  if (diffMs < 0) {
    return "in the future";
  }
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) {
    return "just now";
  }
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  const days = Math.floor(hours / 24);
  if (days < 7) {
    return `${days}d ago`;
  }
  return formatSavedDate(iso);
}

function isStaleEvidence(iso: string, nowMs: number): boolean {
  const ms = new Date(iso).getTime();
  if (!Number.isFinite(ms)) {
    return true;
  }
  return nowMs - ms > 7 * 24 * 60 * 60 * 1000;
}

const OPP_KIND_LABELS: Record<OpportunityKind, string> = {
  "target-reached": "Target reached",
  "price-drop": "Price drop",
  "price-increase": "Price increase",
  "back-in-range": "Back in range",
  restored: "Back available",
  unavailable: "Unavailable",
  "reminder-due": "Reminder",
};

function oppKindChip(kind: OpportunityKind): string {
  switch (kind) {
    case "target-reached":
    case "price-drop":
    case "back-in-range":
    case "restored":
      return "border-teal-300/30 bg-teal-300/10 text-teal-200";
    case "price-increase":
    case "unavailable":
      return "border-amber-300/30 bg-amber-300/10 text-amber-200";
    case "reminder-due":
      return "border-sky-300/30 bg-sky-300/10 text-sky-200";
  }
}

function toLocalInputValue(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";
  } catch {
    return "UTC";
  }
}

function generalToDraft(value: GeneralValue): GeneralDraft {
  return {
    currency: value.currency,
    locale: value.locale,
    categories: [...value.categories],
    preferredBrands: value.preferredBrands.join(", "),
    avoidedBrands: value.avoidedBrands.join(", "),
    preferredMerchants: value.preferredMerchants.join(", "),
    decisionPriority: value.decisionPriority ?? "",
  };
}

function categoryToDraft(value: CategoryValue | undefined): CategoryDraft {
  const draft = emptyCategoryDraft();
  if (!value) {
    return draft;
  }
  draft.budgetMin = value.budgetInr?.min != null ? String(value.budgetInr.min) : "";
  draft.budgetMax = value.budgetInr?.max != null ? String(value.budgetInr.max) : "";
  draft.useCase = value.useCase ?? "";
  draft.performanceLevel = value.performanceLevel ?? "";
  draft.minRamGb = value.minRamGb != null ? String(value.minRamGb) : "";
  draft.minStorageGb =
    value.minStorageGb != null ? String(value.minStorageGb) : "";
  draft.batteryPriority =
    value.batteryPriority != null ? String(value.batteryPriority) : "";
  draft.portability = value.portability ?? "";
  draft.warrantyPriority =
    value.warrantyPriority != null ? String(value.warrantyPriority) : "";
  draft.sizes = value.sizes?.join(", ") ?? "";
  draft.styles = value.styles?.join(", ") ?? "";
  draft.materials = value.materials?.join(", ") ?? "";
  draft.concerns = value.concerns?.join(", ") ?? "";
  draft.notes = value.notes ?? "";
  return draft;
}

function stringList(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") {
      return null;
    }
    out.push(entry);
  }
  return out;
}

/** Human-readable lines for a proposal patch (unknown keys fall back raw). */
function describeProposalPatch(patch: Record<string, unknown>): string[] {
  const lines: string[] = [];
  const brands = stringList(patch.preferredBrands);
  if (brands) {
    lines.push(`Prefer brands: ${brands.join(", ") || "—"}`);
  }
  const avoided = stringList(patch.avoidedBrands);
  if (avoided) {
    lines.push(`Avoid brands: ${avoided.join(", ") || "—"}`);
  }
  const merchants = stringList(patch.preferredMerchants);
  if (merchants) {
    lines.push(`Prefer merchants: ${merchants.join(", ") || "—"}`);
  }
  if (typeof patch.decisionPriority === "string") {
    const label =
      DECISION_PRIORITIES.find((p) => p.id === patch.decisionPriority)?.label ??
      String(patch.decisionPriority);
    lines.push(`Decide by: ${label}`);
  }
  if (typeof patch.currency === "string") {
    lines.push(`Currency: ${patch.currency}`);
  }
  if (typeof patch.locale === "string") {
    lines.push(`Locale: ${patch.locale}`);
  }
  const budget = patch.budgetInr as { min?: unknown; max?: unknown } | undefined;
  if (budget && typeof budget === "object") {
    if (typeof budget.max === "number") {
      lines.push(
        typeof budget.min === "number"
          ? `Budget: ${formatInr(budget.min)} – ${formatInr(budget.max)}`
          : `Budget up to ${formatInr(budget.max)}`,
      );
    } else if (typeof budget.min === "number") {
      lines.push(`Budget from ${formatInr(budget.min)}`);
    }
  }
  for (const [key, label] of [
    ["useCase", "Use"],
    ["performanceLevel", "Performance"],
    ["portability", "Portability"],
    ["notes", "Note"],
  ] as const) {
    if (typeof patch[key] === "string") {
      lines.push(`${label}: ${patch[key] as string}`);
    }
  }
  if (typeof patch.minRamGb === "number") {
    lines.push(`At least ${patch.minRamGb} GB RAM`);
  }
  if (typeof patch.minStorageGb === "number") {
    lines.push(`At least ${patch.minStorageGb} GB storage`);
  }
  if (typeof patch.batteryPriority === "number") {
    lines.push(`Battery priority ${patch.batteryPriority}`);
  }
  if (typeof patch.warrantyPriority === "number") {
    lines.push(`Warranty priority ${patch.warrantyPriority}`);
  }
  for (const [key, label] of [
    ["sizes", "Sizes"],
    ["styles", "Styles"],
    ["materials", "Materials"],
    ["concerns", "Concerns"],
  ] as const) {
    const list = stringList(patch[key]);
    if (list) {
      lines.push(`${label}: ${list.join(", ")}`);
    }
  }
  if (lines.length === 0) {
    for (const [key, value] of Object.entries(patch)) {
      lines.push(`${key}: ${JSON.stringify(value) ?? "?"}`);
    }
  }
  return lines;
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
  const [reqs, setReqs] = useState<RequirementsResponse | null>(null);
  const [reqsLoading, setReqsLoading] = useState(false);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [answering, setAnswering] = useState(false);
  const [reqsError, setReqsError] = useState<string | null>(null);
  const [weights, setWeights] = useState({ ...DEFAULT_WEIGHT_STATE });
  const [allowOverBudget, setAllowOverBudget] = useState(false);
  const [recalcLoading, setRecalcLoading] = useState(false);
  const [reviews, setReviews] = useState<ReviewsResponse | null>(null);
  const [reviewsLoading, setReviewsLoading] = useState(false);
  const [reviewsError, setReviewsError] = useState<string | null>(null);
  const [restored, setRestored] = useState(false);
  const [historyEntries, setHistoryEntries] = useState<
    Array<HistoryEntry<PersistedWorkflow>>
  >([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const router = useRouter();
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
  const restoredSubRef = useRef<string | null>(null);
  const historySigRef = useRef<string | null>(null);
  const [prefsOpen, setPrefsOpen] = useState(false);
  const [proposalsOpen, setProposalsOpen] = useState(false);
  const [profile, setProfile] = useState<ProfileData | null>(null);
  const [hasProfile, setHasProfile] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [profileNotice, setProfileNotice] = useState<string | null>(null);
  const [generalDraft, setGeneralDraft] = useState<GeneralDraft>(emptyGeneralDraft);
  const [catTab, setCatTab] = useState<Category>("electronics");
  const [catDraft, setCatDraft] = useState<CategoryDraft>(emptyCategoryDraft);
  const [catNotice, setCatNotice] = useState<string | null>(null);
  const [catError, setCatError] = useState<string | null>(null);
  const [savingGeneral, setSavingGeneral] = useState(false);
  const [savingCategory, setSavingCategory] = useState(false);
  const [proposals, setProposals] = useState<ProposalData[]>([]);
  const [proposalCount, setProposalCount] = useState(0);
  const [proposalsLoading, setProposalsLoading] = useState(false);
  const [proposalsError, setProposalsError] = useState<string | null>(null);
  const [proposalsNotice, setProposalsNotice] = useState<string | null>(null);
  const [decidingId, setDecidingId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [summary, setSummary] = useState<MemorySummary | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [useProfile, setUseProfile] = useState(true);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [savedDecisionId, setSavedDecisionId] = useState<string | null>(null);
  const [helpfulVote, setHelpfulVote] = useState<boolean | null>(null);
  const [votingHelpful, setVotingHelpful] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [preferId, setPreferId] = useState("");
  const [rejectId, setRejectId] = useState("");
  const [rejectReason, setRejectReason] = useState("");
  const [purchasedId, setPurchasedId] = useState("");
  const [feedbackSaving, setFeedbackSaving] = useState(false);
  const [feedbackDone, setFeedbackDone] = useState(false);
  const [feedbackError, setFeedbackError] = useState<string | null>(null);
  const [watchesOpen, setWatchesOpen] = useState(false);
  const [enrichedWatches, setEnrichedWatches] = useState<EnrichedWatch[]>([]);
  const [watchesLoading, setWatchesLoading] = useState(false);
  const [watchesError, setWatchesError] = useState<string | null>(null);
  const [watchesNotice, setWatchesNotice] = useState<string | null>(null);
  const [alerts, setAlerts] = useState<AlertData[]>([]);
  const [unreadAlerts, setUnreadAlerts] = useState(0);
  const [monitor, setMonitor] = useState<MonitorData | null>(null);
  const [trackDraft, setTrackDraft] = useState<TrackDraft | null>(null);
  const [creatingWatch, setCreatingWatch] = useState(false);
  const [checkingId, setCheckingId] = useState<string | null>(null);
  const [editingWatchId, setEditingWatchId] = useState<string | null>(null);
  const [editTarget, setEditTarget] = useState("");
  const [insights, setInsights] = useState<Record<string, CardInsight>>({});
  const [opportunities, setOpportunities] = useState<OpportunityData[]>([]);
  const [oppTab, setOppTab] = useState<OppTab>("active");
  const [oppCategory, setOppCategory] = useState<"" | Category>("");
  const [oppLoading, setOppLoading] = useState(false);
  const [oppError, setOppError] = useState<string | null>(null);
  const [oppNotice, setOppNotice] = useState<string | null>(null);
  const [activeOpps, setActiveOpps] = useState<OpportunityData[]>([]);
  const [expandedOppId, setExpandedOppId] = useState<string | null>(null);
  const [reevaluatingId, setReevaluatingId] = useState<string | null>(null);
  const [oppsOpen, setOppsOpen] = useState(false);
  const [widgetIndex, setWidgetIndex] = useState(0);
  const [widgetPaused, setWidgetPaused] = useState(false);
  const [remindersOpen, setRemindersOpen] = useState(false);
  const [reminders, setReminders] = useState<ReminderData[]>([]);
  const [remindersLoading, setRemindersLoading] = useState(false);
  const [remindersError, setRemindersError] = useState<string | null>(null);
  const [remindersNotice, setRemindersNotice] = useState<string | null>(null);
  const [reminderDraft, setReminderDraft] = useState<ReminderDraft | null>(null);
  const [savingReminder, setSavingReminder] = useState(false);
  const [settings, setSettings] = useState<NotificationSettingsData | null>(null);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsNotice, setSettingsNotice] = useState<string | null>(null);
  const [chatOpen, setChatOpen] = useState(false);
  const [chatThreads, setChatThreads] = useState<ChatThreadData[]>([]);
  const [chatThread, setChatThread] = useState<ChatThreadData | null>(null);
  const [chatLoading, setChatLoading] = useState(false);
  const [chatSending, setChatSending] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const [chatInput, setChatInput] = useState("");
  const [chatProduct, setChatProduct] = useState<ChatProductHint | null>(null);
  const chatEndRef = useRef<HTMLDivElement | null>(null);
  const nowMs = useMemo(() => Date.now(), []);

  useEffect(() => {
    return () => {
      recognitionRef.current?.abort();
      if (stopTimerRef.current) {
        clearTimeout(stopTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("/api/auth/me", {
          cache: "no-store",
        });
        if (cancelled) {
          return;
        }
        if (response.ok) {
          const data = (await response.json()) as { user: AuthUser | null };
          if (data.user) {
            setUser(data.user);
            setAuthChecked(true);
          } else {
            router.replace("/login");
          }
        } else {
          router.replace("/login");
        }
      } catch {
        if (!cancelled) {
          router.replace("/login");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [router]);

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

  useEffect(() => {
    if (!verdict || !user) {
      return;
    }
    const ids = verdict.ranked
      .slice(0, 10)
      .map((item) => item.product.id)
      .filter((id) => /^[A-Za-z0-9_-]{1,64}$/.test(id));
    if (ids.length === 0) {
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(
          `/api/prices/insights?ids=${ids.map((id) => encodeURIComponent(id)).join(",")}`,
        );
        if (!response.ok || cancelled) {
          return;
        }
        const data = (await response.json()) as {
          insights: Record<string, CardInsight>;
        };
        setInsights(data.insights ?? {});
      } catch {
        // Cards simply show no history line.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [verdict, user]);

  useEffect(() => {
    if (chatThread) {
      chatEndRef.current?.scrollIntoView({ block: "end" });
    }
  }, [chatThread, chatOpen]);

  useEffect(() => {
    if (activeOpps.length < 2 || widgetPaused) {
      return;
    }
    if (
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      return;
    }
    const id = setInterval(() => {
      setWidgetIndex((index) => index + 1);
    }, 5000);
    return () => clearInterval(id);
  }, [activeOpps.length, widgetPaused]);

  useEffect(() => {
    if (
      !prefsOpen &&
      !proposalsOpen &&
      !watchesOpen &&
      !remindersOpen &&
      !chatOpen &&
      !oppsOpen
    ) {
      return;
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setPrefsOpen(false);
        setProposalsOpen(false);
        setWatchesOpen(false);
        setRemindersOpen(false);
        setChatOpen(false);
        setOppsOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [prefsOpen, proposalsOpen, watchesOpen, remindersOpen, chatOpen, oppsOpen]);

  /* eslint-disable react-hooks/exhaustive-deps -- one-shot bootstrap when the
     signed-in user resolves; re-running on every render is not intended. */
  useEffect(() => {
    if (user) {
      void loadSummary();
      void loadAlerts();
      void refreshActiveOpps();
      void loadReminders();
    }
  }, [user]);
  /* eslint-enable react-hooks/exhaustive-deps */

  function resetWorkflowState(): void {
    // Persisted workflow fields back to their initial values…
    setQuery("");
    setResult(null);
    setOverride(null);
    setDisabled({});
    setReqs(null);
    setAnswers({});
    setReqsError(null);
    setWeights({ ...DEFAULT_WEIGHT_STATE });
    setAllowOverBudget(false);
    setSearch(null);
    setVerdict(null);
    setReviews(null);
    setReviewsError(null);
    setCompareIds([]);
    setShowCompare(false);
    setError(null);
    setSearchError(null);
    setVerdictError(null);
    setStage("idle");
    // …plus every per-user cache, so a new account never flashes the
    // previous account's data before its own loads.
    setPrefsOpen(false);
    setProposalsOpen(false);
    setWatchesOpen(false);
    setRemindersOpen(false);
    setChatOpen(false);
    setOppsOpen(false);
    setProfile(null);
    setHasProfile(false);
    setProfileError(null);
    setProfileNotice(null);
    setGeneralDraft(emptyGeneralDraft());
    setCatTab("electronics");
    setCatDraft(emptyCategoryDraft());
    setCatNotice(null);
    setCatError(null);
    setProposals([]);
    setProposalCount(0);
    setProposalsError(null);
    setProposalsNotice(null);
    setDecidingId(null);
    setEditingId(null);
    setEditValue("");
    setSummary(null);
    setSummaryError(null);
    setUseProfile(true);
    setSaveState("idle");
    setSavedDecisionId(null);
    setHelpfulVote(null);
    setFeedbackOpen(false);
    setPreferId("");
    setRejectId("");
    setRejectReason("");
    setPurchasedId("");
    setFeedbackDone(false);
    setFeedbackError(null);
    setEnrichedWatches([]);
    setWatchesError(null);
    setWatchesNotice(null);
    setAlerts([]);
    setUnreadAlerts(0);
    setMonitor(null);
    setTrackDraft(null);
    setCreatingWatch(false);
    setCheckingId(null);
    setEditingWatchId(null);
    setEditTarget("");
    setInsights({});
    setOpportunities([]);
    setOppTab("active");
    setOppCategory("");
    setOppError(null);
    setOppNotice(null);
    setActiveOpps([]);
    setExpandedOppId(null);
    setWidgetIndex(0);
    setReminders([]);
    setRemindersError(null);
    setRemindersNotice(null);
    setReminderDraft(null);
    setSettings(null);
    setSettingsNotice(null);
    setChatThreads([]);
    setChatThread(null);
    setChatError(null);
    setChatInput("");
    setChatProduct(null);
    setHistoryEntries([]);
    setHistoryOpen(false);
    historySigRef.current = null;
  }

  function restoreHistory(entry: HistoryEntry<PersistedWorkflow>): void {
    historySigRef.current = null;
    applyWorkflow(entry.snapshot);
    setHistoryOpen(false);
    requestAnimationFrame(() => {
      scrollToElement(intentRef.current);
    });
  }

  function deleteHistoryEntry(id: string): void {
    if (!user) {
      return;
    }
    setHistoryEntries(
      removeHistoryEntry<PersistedWorkflow>(
        window.localStorage,
        historyStorageKey(user.sub),
        id,
      ),
    );
  }

  function deleteAllHistory(): void {
    if (!user) {
      return;
    }
    clearStoredHistory(window.localStorage, historyStorageKey(user.sub));
    setHistoryEntries([]);
  }

  function applyWorkflow(saved: PersistedWorkflow): void {
    setQuery(saved.query ?? "");
    setResult(saved.result);
    setOverride(saved.override);
    setDisabled(saved.disabled ?? {});
    setReqs(saved.reqs);
    setAnswers(saved.answers ?? {});
    setReqsError(saved.reqsError);
    if (saved.weights) {
      setWeights(saved.weights);
    }
    setAllowOverBudget(saved.allowOverBudget ?? false);
    setSearch(saved.search);
    setVerdict(saved.verdict);
    setReviews(saved.reviews);
    setCompareIds(saved.compareIds ?? []);
    setShowCompare(saved.showCompare ?? false);
    setError(saved.error);
    setSearchError(saved.searchError);
    setVerdictError(saved.verdictError);
    setStage(saved.verdict ? "done" : "idle");
  }

  function topPickTitle(verdictData: VerdictData | null): string | null {
    const pickId = verdictData?.recommendation.productId;
    if (!verdictData || !pickId) {
      return null;
    }
    return (
      verdictData.ranked.find((item) => item.product.id === pickId)?.product
        .title ?? null
    );
  }

  /* eslint-disable react-hooks/set-state-in-effect -- client-only restore
     from localStorage must run in an effect; reading it during render
     would mismatch the server HTML on hydration. */
  useEffect(() => {
    const sub = user?.sub ?? null;
    if (sub === restoredSubRef.current) {
      return;
    }
    restoredSubRef.current = sub;
    resetWorkflowState();
    if (sub === null) {
      // Logged out (or auth unresolved): show nothing and persist nothing.
      setRestored(false);
      return;
    }
    // One-time cleanup of the pre-fix global key, then restore this
    // account's own draft — never another account's.
    clearStoredWorkflow(window.localStorage, LEGACY_WORKFLOW_KEY);
    const saved = loadStoredWorkflow<PersistedWorkflow>(
      window.localStorage,
      workflowStorageKey(sub),
    );
    if (saved) {
      applyWorkflow(saved);
    }
    setHistoryEntries(
      loadHistory<PersistedWorkflow>(
        window.localStorage,
        historyStorageKey(sub),
      ),
    );
    setRestored(true);
  }, [user]);
  /* eslint-enable react-hooks/set-state-in-effect */

  useEffect(() => {
    if (!restored || !user) {
      return;
    }
    const draft: PersistedWorkflow = {
      version: 1,
      query,
      result,
      override,
      disabled,
      reqs,
      answers,
      weights,
      allowOverBudget,
      search,
      verdict,
      reviews,
      compareIds,
      showCompare,
      error,
      searchError,
      verdictError,
      reqsError,
    };
    saveStoredWorkflow<PersistedWorkflow>(
      window.localStorage,
      workflowStorageKey(user.sub),
      draft,
    );
    // History keeps completed searches only. The signature gates writes so
    // typing in the query box does not rewrite the entry, while verdicts
    // and late-arriving reviews still refresh it.
    if (result && verdict) {
      const signature = [
        result.intent.query,
        verdict.recommendation.verdict,
        verdict.searchedAt,
        search?.searchedAt ?? "",
        reviews ? String(reviews.reports.length) : "none",
      ].join("|");
      if (signature !== historySigRef.current) {
        historySigRef.current = signature;
        setHistoryEntries(
          saveHistoryEntry<PersistedWorkflow>(
            window.localStorage,
            historyStorageKey(user.sub),
            {
              query: result.intent.query,
              verdict: verdict.recommendation.verdict,
              topPick: topPickTitle(verdict),
              snapshot: draft,
            },
            new Date().toISOString(),
          ),
        );
      }
    }
  }, [
    restored,
    user,
    query,
    result,
    override,
    disabled,
    reqs,
    answers,
    weights,
    allowOverBudget,
    search,
    verdict,
    reviews,
    compareIds,
    showCompare,
    error,
    searchError,
    verdictError,
    reqsError,
  ]);

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

  const requirementsComplete =
    reqs != null && !reqsLoading && reqs.questions.length === 0;

  const cards: Array<{
    product: Product;
    score: RankedItem["score"] | null;
    analysis: RankedItem["analysis"];
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
        .filter(
          (
            c,
          ): c is {
            product: Product;
            score: RankedItem["score"] | null;
            analysis: RankedItem["analysis"];
          } => c != null,
        ),
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
    setReviews(null);
    setReviewsError(null);
    setCompareIds([]);
    setShowCompare(false);
    setStage("idle");
    setSaveState("idle");
    setSavedDecisionId(null);
    setHelpfulVote(null);
    setFeedbackOpen(false);
    setPreferId("");
    setRejectId("");
    setRejectReason("");
    setPurchasedId("");
    setFeedbackDone(false);
    setFeedbackError(null);
  }

  function clearResults(): void {
    // Hide the previous analysis and everything below it; the query text
    // stays so it can be edited and re-run.
    setResult(null);
    setOverride(null);
    setDisabled({});
    setReqs(null);
    setAnswers({});
    setReqsError(null);
    setWeights({ ...DEFAULT_WEIGHT_STATE });
    setAllowOverBudget(false);
    setError(null);
    clearDownstream();
  }

  async function analyze(text: string): Promise<void> {
    const trimmed = text.trim();
    if (trimmed.length < 2 || loading) return;
    setLoading(true);
    setError(null);
    setResult(null);
    setOverride(null);
    setReqs(null);
    setAnswers({});
    setReqsError(null);
    setWeights({ ...DEFAULT_WEIGHT_STATE });
    setAllowOverBudget(false);
    setReviews(null);
    setReviewsError(null);
    setUseProfile(true);
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
      await loadRequirements(data.intent);
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

  async function loadRequirements(intent: Intent): Promise<void> {
    setReqsLoading(true);
    setReqsError(null);
    try {
      const reqResponse = await fetch("/api/requirements", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: intent.query, intent }),
      });
      if (!reqResponse.ok) {
        throw new Error(`requirements failed (${reqResponse.status})`);
      }
      const reqData = (await reqResponse.json()) as RequirementsResponse;
      setReqs(reqData);
    } catch {
      setReqsError("Could not understand requirements. Please retry.");
    } finally {
      setReqsLoading(false);
    }
  }

  async function retryRequirements(): Promise<void> {
    if (!result || reqsLoading) {
      return;
    }
    await loadRequirements(result.intent);
  }

  async function submitAnswers(): Promise<void> {
    if (!result || !reqs || answering) {
      return;
    }
    const payload = reqs.questions
      .map((q) => ({ questionId: q.id, value: (answers[q.id] ?? "").trim() }))
      .filter((a) => a.value.length > 0);
    if (payload.length !== reqs.questions.length) {
      return;
    }
    setAnswering(true);
    try {
      const response = await fetch("/api/requirements", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: result.intent.query,
          intent: result.intent,
          answers: payload,
        }),
      });
      if (!response.ok) {
        throw new Error(`requirements failed (${response.status})`);
      }
      const data = (await response.json()) as RequirementsResponse;
      setReqs(data);
      setAnswers({});
      const match = CATEGORIES.find((c) => c.id === data.suggestedCategory);
      if (match && match.id !== effectiveCategory) {
        setOverride(match.id);
        clearDownstream();
      }
    } catch {
      setError("Could not update requirements. Please try again.");
    } finally {
      setAnswering(false);
    }
  }

  async function recalc(next?: {
    weights?: typeof weights;
    allowOverBudget?: boolean;
  }): Promise<void> {
    if (!result || !search || !effectiveCategory || recalcLoading) {
      return;
    }
    const w = normalizeWeights(next?.weights ?? weights);
    const over = next?.allowOverBudget ?? allowOverBudget;
    setWeights(w);
    setAllowOverBudget(over);
    setRecalcLoading(true);
    setVerdictError(null);
    try {
      const response = await fetch("/api/recommend", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: result.intent.query,
          category: effectiveCategory,
          intent: result.intent,
          requirements: reqs?.requirements,
          weights: w,
          allowOverBudget: over,
          personalize: useProfile,
          products: search.products,
          statuses: search.statuses,
          searchedAt: search.searchedAt,
        }),
      });
      const data = (await response.json()) as VerdictData & { error?: string };
      if (!response.ok) {
        throw new Error(data.error ?? `recalculation failed (${response.status})`);
      }
      setVerdict(data);
      setReviews(null);
      setReviewsError(null);
      setCompareIds([]);
      setShowCompare(false);
    } catch (e) {
      setVerdictError(
        e instanceof Error ? e.message : "Recalculation failed. Please try again.",
      );
    } finally {
      setRecalcLoading(false);
    }
  }

  async function signOut(): Promise<void> {
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } catch {
      // Cookie may already be gone; still redirect to login.
    }
    setUser(null);
    // Full reload, not client-side nav: guarantees the session cookie,
    // component state, and any cached route data are all dropped together.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- deliberate full reload on logout
    window.location.href = "/login";
  }

  async function loadSummary(): Promise<void> {
    setSummaryLoading(true);
    setSummaryError(null);
    setProfileError(null);
    try {
      const [profileRes, decRes, fbRes, spRes, scRes, propRes] =
        await Promise.all([
          fetch("/api/profile"),
          fetch("/api/memory/decisions?limit=50"),
          fetch("/api/memory/feedback?limit=50"),
          fetch("/api/memory/saved/products"),
          fetch("/api/memory/saved/comparisons"),
          fetch("/api/memory/proposals"),
        ]);
      const responses = [profileRes, decRes, fbRes, spRes, scRes, propRes];
      if (!responses.every((r) => r.ok)) {
        throw new Error("Could not load saved data. Please try again.");
      }
      const [profileData, decData, fbData, spData, scData, propData] = (await Promise.all(
        responses.map((r) => r.json()),
      )) as [
        { profile: ProfileData | null },
        { decisions: unknown[] },
        { feedback: unknown[] },
        { products: unknown[] },
        { comparisons: unknown[] },
        { proposals: ProposalData[] },
      ];
      setProfile(profileData.profile);
      setHasProfile(profileData.profile != null);
      if (profileData.profile) {
        setGeneralDraft(generalToDraft(profileData.profile.general.value));
        setCatDraft(
          categoryToDraft(profileData.profile.categories[catTab]?.value),
        );
      }
      setSummary({
        hasProfile: profileData.profile != null,
        profileUpdated: profileData.profile?.general.updatedAt,
        decisions: decData.decisions.length,
        feedback: fbData.feedback.length,
        savedProducts: spData.products.length,
        savedComparisons: scData.comparisons.length,
        proposalsPending: propData.proposals.length,
      });
      setProposals(propData.proposals);
      setProposalCount(propData.proposals.length);
    } catch (e) {
      setSummaryError(
        e instanceof Error ? e.message : "Could not load saved data.",
      );
    } finally {
      setSummaryLoading(false);
    }
  }

  function openPrefs(): void {
    if (prefsOpen) {
      setPrefsOpen(false);
      return;
    }
    setProposalsOpen(false);
    setWatchesOpen(false);
    setRemindersOpen(false);
    setChatOpen(false);
    setOppsOpen(false);
    setPrefsOpen(true);
    setProfileNotice(null);
    setCatNotice(null);
    setCatError(null);
    void loadSummary();
  }

  function openProposals(): void {
    if (proposalsOpen) {
      setProposalsOpen(false);
      return;
    }
    setPrefsOpen(false);
    setWatchesOpen(false);
    setRemindersOpen(false);
    setChatOpen(false);
    setOppsOpen(false);
    setProposalsOpen(true);
    setProposalsNotice(null);
    setProposalsError(null);
    void loadProposals();
  }

  async function loadProposals(): Promise<void> {
    setProposalsLoading(true);
    setProposalsError(null);
    try {
      const response = await fetch("/api/memory/proposals");
      const data = (await response.json()) as {
        proposals?: ProposalData[];
        error?: string;
      };
      if (!response.ok) {
        throw new Error(data.error ?? "Could not load suggestions.");
      }
      setProposals(data.proposals ?? []);
      setProposalCount((data.proposals ?? []).length);
    } catch (e) {
      setProposalsError(
        e instanceof Error ? e.message : "Could not load suggestions.",
      );
    } finally {
      setProposalsLoading(false);
    }
  }

  async function saveGeneral(): Promise<void> {
    if (savingGeneral) {
      return;
    }
    const currency = generalDraft.currency.trim().toUpperCase();
    if (currency !== "" && !/^[A-Z]{3}$/.test(currency)) {
      setProfileError("Currency must be a 3-letter code like INR or USD.");
      return;
    }
    setSavingGeneral(true);
    setProfileError(null);
    setProfileNotice(null);
    try {
      const body: Record<string, unknown> = {
        preferredBrands: parseCommaList(generalDraft.preferredBrands),
        avoidedBrands: parseCommaList(generalDraft.avoidedBrands),
        preferredMerchants: parseCommaList(generalDraft.preferredMerchants),
        categories: generalDraft.categories,
      };
      if (currency !== "") {
        body.currency = currency;
      }
      if (generalDraft.locale.trim() !== "") {
        body.locale = generalDraft.locale.trim();
      }
      if (generalDraft.decisionPriority !== "") {
        body.decisionPriority = generalDraft.decisionPriority;
      } else if (profile?.general.value.decisionPriority !== undefined) {
        body.decisionPriority = null;
      }
      const response = await fetch("/api/profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ general: body }),
      });
      const data = (await response.json()) as {
        profile?: ProfileData;
        error?: string;
      };
      if (!response.ok || !data.profile) {
        throw new Error(data.error ?? "Could not save preferences.");
      }
      setProfile(data.profile);
      setHasProfile(true);
      setGeneralDraft(generalToDraft(data.profile.general.value));
      setProfileNotice("Preferences saved.");
    } catch (e) {
      setProfileError(
        e instanceof Error ? e.message : "Could not save preferences.",
      );
    } finally {
      setSavingGeneral(false);
    }
  }

  function buildCategoryPatch(): Record<string, unknown> {
    const stored = profile?.categories[catTab]?.value;
    const patch: Record<string, unknown> = {};
    const numberOrNull = (
      raw: string,
      label: string,
      opts?: { positive?: boolean; max?: number },
    ): number | null => {
      const trimmed = raw.trim();
      if (trimmed === "") {
        return null;
      }
      const value = Number(trimmed);
      if (
        !Number.isFinite(value) ||
        value < 0 ||
        (opts?.positive === true && value <= 0) ||
        (opts?.max !== undefined && value > opts.max)
      ) {
        throw new Error(
          `${label} must be a number${opts?.max !== undefined ? ` between 0 and ${opts.max}` : " ≥ 0"}.`,
        );
      }
      return value;
    };
    const min = numberOrNull(catDraft.budgetMin, "Minimum budget");
    const max = numberOrNull(catDraft.budgetMax, "Maximum budget", {
      positive: true,
    });
    if (min != null && max != null && min > max) {
      throw new Error("Minimum budget must not exceed the maximum.");
    }
    if (
      (min ?? stored?.budgetInr?.min) !== stored?.budgetInr?.min ||
      (max ?? stored?.budgetInr?.max) !== stored?.budgetInr?.max
    ) {
      patch.budgetInr =
        min == null && max == null
          ? null
          : {
              ...(min != null ? { min } : {}),
              ...(max != null ? { max } : {}),
            };
    }
    const text = (raw: string, current: string | undefined, key: string) => {
      const trimmed = raw.trim();
      if (trimmed !== "" && trimmed !== current) {
        patch[key] = trimmed;
      } else if (trimmed === "" && current !== undefined) {
        patch[key] = null;
      }
    };
    text(catDraft.useCase, stored?.useCase, "useCase");
    text(catDraft.performanceLevel, stored?.performanceLevel, "performanceLevel");
    text(catDraft.portability, stored?.portability, "portability");
    text(catDraft.notes, stored?.notes, "notes");
    const numeric = (
      raw: string,
      current: number | undefined,
      key: string,
      label: string,
      opts?: { positive?: boolean; max?: number },
    ) => {
      const value = numberOrNull(raw, label, opts);
      if (value !== current) {
        patch[key] = value;
      }
    };
    numeric(catDraft.minRamGb, stored?.minRamGb, "minRamGb", "Minimum RAM", {
      positive: true,
    });
    numeric(
      catDraft.minStorageGb,
      stored?.minStorageGb,
      "minStorageGb",
      "Minimum storage",
      { positive: true },
    );
    numeric(
      catDraft.batteryPriority,
      stored?.batteryPriority,
      "batteryPriority",
      "Battery priority",
      { max: 1 },
    );
    numeric(
      catDraft.warrantyPriority,
      stored?.warrantyPriority,
      "warrantyPriority",
      "Warranty priority",
      { max: 1 },
    );
    const list = (raw: string, current: string[] | undefined, key: string) => {
      const next = parseCommaList(raw);
      if (next.join("\n") !== (current ?? []).join("\n")) {
        patch[key] = next;
      }
    };
    list(catDraft.sizes, stored?.sizes, "sizes");
    list(catDraft.styles, stored?.styles, "styles");
    list(catDraft.materials, stored?.materials, "materials");
    list(catDraft.concerns, stored?.concerns, "concerns");
    return patch;
  }

  async function saveCategory(): Promise<void> {
    if (savingCategory) {
      return;
    }
    let patch: Record<string, unknown>;
    try {
      patch = buildCategoryPatch();
    } catch (e) {
      setCatError(e instanceof Error ? e.message : "Invalid preferences.");
      return;
    }
    if (Object.keys(patch).length === 0) {
      setCatNotice("No changes to save.");
      return;
    }
    setSavingCategory(true);
    setCatError(null);
    setCatNotice(null);
    try {
      const response = await fetch(`/api/profile/${catTab}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ preferences: patch }),
      });
      const data = (await response.json()) as {
        preferences?: StoredSection<CategoryValue>;
        error?: string;
      };
      if (!response.ok || !data.preferences) {
        throw new Error(data.error ?? "Could not save preferences.");
      }
      setProfile((prev) =>
        prev
          ? {
              ...prev,
              categories: {
                ...prev.categories,
                [catTab]: data.preferences as StoredSection<CategoryValue>,
              },
            }
          : prev,
      );
      setHasProfile(true);
      setCatDraft(categoryToDraft(data.preferences.value));
      setCatNotice(`${categoryLabel(catTab)} preferences saved.`);
    } catch (e) {
      setCatError(
        e instanceof Error ? e.message : "Could not save preferences.",
      );
    } finally {
      setSavingCategory(false);
    }
  }

  function switchCatTab(tab: Category): void {
    setCatTab(tab);
    setCatDraft(categoryToDraft(profile?.categories[tab]?.value));
    setCatNotice(null);
    setCatError(null);
  }

  async function clearHistory(): Promise<void> {
    if (
      !window.confirm(
        "Clear your decision history, feedback, and suggestions? Saved products and preferences are kept.",
      )
    ) {
      return;
    }
    setSummaryError(null);
    try {
      const response = await fetch("/api/memory/history", { method: "DELETE" });
      if (!response.ok) {
        throw new Error("Could not clear history. Please try again.");
      }
      await loadSummary();
    } catch (e) {
      setSummaryError(e instanceof Error ? e.message : "Could not clear history.");
    }
  }

  async function clearProfile(): Promise<void> {
    if (
      !window.confirm(
        "Delete all your saved preferences? This cannot be undone. Your decision history is kept.",
      )
    ) {
      return;
    }
    setProfileError(null);
    try {
      const response = await fetch("/api/profile", { method: "DELETE" });
      if (!response.ok) {
        throw new Error("Could not delete preferences. Please try again.");
      }
      setProfile(null);
      setHasProfile(false);
      setGeneralDraft(emptyGeneralDraft());
      setCatDraft(emptyCategoryDraft());
      setProfileNotice("Preferences deleted.");
      await loadSummary();
    } catch (e) {
      setProfileError(
        e instanceof Error ? e.message : "Could not delete preferences.",
      );
    }
  }

  async function decideProposal(
    id: string,
    decision: "confirmed" | "rejected",
    patch?: Record<string, unknown>,
  ): Promise<void> {
    if (decidingId) {
      return;
    }
    setDecidingId(id);
    setProposalsError(null);
    try {
      const response = await fetch("/api/memory/proposals/decide", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          patch === undefined ? { id, decision } : { id, decision, patch },
        ),
      });
      const data = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(data.error ?? "Could not save your choice.");
      }
      setProposals((prev) => prev.filter((p) => p.id !== id));
      setProposalCount((count) => Math.max(0, count - 1));
      setEditingId(null);
      setProposalsNotice(
        decision === "confirmed"
          ? "Saved to your preferences."
          : "Dismissed — we won't ask about this again.",
      );
      if (decision === "confirmed") {
        await loadSummary();
      }
    } catch (e) {
      setProposalsError(
        e instanceof Error ? e.message : "Could not save your choice.",
      );
    } finally {
      setDecidingId(null);
    }
  }

  function editPrefill(patch: Record<string, unknown>): {
    label: string;
    value: string;
  } | null {
    const brands = stringList(patch.preferredBrands);
    if (brands) {
      return { label: "Brands (comma-separated)", value: brands.join(", ") };
    }
    const avoided = stringList(patch.avoidedBrands);
    if (avoided) {
      return { label: "Brands (comma-separated)", value: avoided.join(", ") };
    }
    const budget = patch.budgetInr as { max?: unknown } | undefined;
    if (budget && typeof budget === "object" && typeof budget.max === "number") {
      return { label: "Maximum budget (₹)", value: String(budget.max) };
    }
    return null;
  }

  function confirmEdited(proposal: ProposalData): void {
    const patch = proposal.patch;
    if (stringList(patch.preferredBrands)) {
      const brands = parseCommaList(editValue);
      if (brands.length === 0) {
        setProposalsError("Enter at least one brand, or reject the suggestion.");
        return;
      }
      void decideProposal(proposal.id, "confirmed", {
        ...patch,
        preferredBrands: brands,
      });
      return;
    }
    if (stringList(patch.avoidedBrands)) {
      const brands = parseCommaList(editValue);
      if (brands.length === 0) {
        setProposalsError("Enter at least one brand, or reject the suggestion.");
        return;
      }
      void decideProposal(proposal.id, "confirmed", {
        ...patch,
        avoidedBrands: brands,
      });
      return;
    }
    const budget = patch.budgetInr as { max?: unknown } | undefined;
    if (budget && typeof budget === "object") {
      const max = Number(editValue.trim());
      if (!Number.isFinite(max) || max <= 0) {
        setProposalsError("Enter a maximum budget above ₹0.");
        return;
      }
      void decideProposal(proposal.id, "confirmed", {
        ...patch,
        budgetInr: { max },
      });
    }
  }

  async function saveCurrentDecision(): Promise<void> {
    if (
      !verdict ||
      !effectiveCategory ||
      !result ||
      saveState === "saving" ||
      saveState === "saved"
    ) {
      return;
    }
    setSaveState("saving");
    try {
      const top = verdict.ranked[0]?.product ?? null;
      const response = await fetch("/api/memory/decisions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: result.intent.query,
          category: effectiveCategory,
          ...(verdict.intent?.budgetInr
            ? { budgetInr: verdict.intent.budgetInr }
            : {}),
          topPick: top
            ? {
                productId: top.id,
                title: top.title,
                merchant: top.merchant,
                ...(top.priceInr != null ? { priceInr: top.priceInr } : {}),
              }
            : null,
          verdict: verdict.recommendation.verdict,
          ...(verdict.personalization?.applied &&
          verdict.personalization.applied.length > 0
            ? { personalizationApplied: verdict.personalization.applied }
            : {}),
        }),
      });
      const data = (await response.json()) as {
        decision?: { id: string };
        error?: string;
      };
      if (!response.ok || !data.decision) {
        throw new Error(data.error ?? "Could not save this decision.");
      }
      setSavedDecisionId(data.decision.id);
      setSaveState("saved");
    } catch {
      setSaveState("error");
    }
  }

  async function voteHelpful(value: boolean): Promise<void> {
    if (votingHelpful || helpfulVote !== null) {
      return;
    }
    setVotingHelpful(true);
    setFeedbackError(null);
    try {
      const response = await fetch("/api/memory/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(savedDecisionId ? { decisionId: savedDecisionId } : {}),
          helpful: value,
        }),
      });
      if (!response.ok) {
        throw new Error("Could not save your vote. Please try again.");
      }
      setHelpfulVote(value);
    } catch (e) {
      setFeedbackError(
        e instanceof Error ? e.message : "Could not save your vote.",
      );
    } finally {
      setVotingHelpful(false);
    }
  }

  async function submitFeedbackDetails(): Promise<void> {
    if (!verdict || feedbackSaving || feedbackDone) {
      return;
    }
    const findProduct = (id: string) =>
      verdict.ranked.find((item) => item.product.id === id)?.product ?? null;
    const preferred = preferId ? findProduct(preferId) : null;
    const rejected = rejectId ? findProduct(rejectId) : null;
    const purchased = purchasedId ? findProduct(purchasedId) : null;
    const reason = rejectReason.trim();
    if (!preferred && !rejected && !purchased && reason === "") {
      return;
    }
    setFeedbackSaving(true);
    setFeedbackError(null);
    try {
      const snapshot = (p: Product) => ({
        productId: p.id,
        title: p.title,
        merchant: p.merchant,
      });
      const response = await fetch("/api/memory/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(savedDecisionId ? { decisionId: savedDecisionId } : {}),
          ...(preferred ? { preferred: snapshot(preferred) } : {}),
          ...(rejected ? { rejected: snapshot(rejected) } : {}),
          ...(purchased ? { purchased: snapshot(purchased) } : {}),
          ...(reason !== "" ? { rejectionReason: reason } : {}),
        }),
      });
      if (!response.ok) {
        throw new Error("Could not save your feedback. Please try again.");
      }
      setFeedbackDone(true);
    } catch (e) {
      setFeedbackError(
        e instanceof Error ? e.message : "Could not save your feedback.",
      );
    } finally {
      setFeedbackSaving(false);
    }
  }

  function openWatches(): void {
    if (watchesOpen) {
      setWatchesOpen(false);
      return;
    }
    setPrefsOpen(false);
    setProposalsOpen(false);
    setRemindersOpen(false);
    setChatOpen(false);
    setOppsOpen(false);
    setWatchesOpen(true);
    setWatchesNotice(null);
    setWatchesError(null);
    void loadWatches();
    void loadAlerts();
    void loadMonitor();
    void loadSettings();
  }

  function openReminders(prefill?: Partial<ReminderDraft>): void {
    if (remindersOpen && !prefill) {
      setRemindersOpen(false);
      return;
    }
    setPrefsOpen(false);
    setProposalsOpen(false);
    setWatchesOpen(false);
    setChatOpen(false);
    setOppsOpen(false);
    setRemindersOpen(true);
    setRemindersNotice(null);
    setRemindersError(null);
    if (prefill) {
      setReminderDraft({
        id: null,
        title: "",
        remindAtLocal: toLocalInputValue(new Date(Date.now() + 7 * 86400000)),
        timezone: browserTimezone(),
        note: "",
        targetPrice: "",
        productId: null,
        url: null,
        merchant: null,
        watchId: null,
        ...prefill,
      });
    }
    void loadReminders();
  }

  async function loadWatches(): Promise<void> {
    setWatchesLoading(true);
    setWatchesError(null);
    try {
      const response = await fetch("/api/memory/watches");
      const data = (await response.json()) as {
        watches?: EnrichedWatch[];
        error?: string;
      };
      if (!response.ok) {
        throw new Error(data.error ?? "Could not load watchlist.");
      }
      setEnrichedWatches(data.watches ?? []);
    } catch (e) {
      setWatchesError(
        e instanceof Error ? e.message : "Could not load watchlist.",
      );
    } finally {
      setWatchesLoading(false);
    }
  }

  async function loadAlerts(): Promise<void> {
    try {
      const response = await fetch("/api/memory/alerts?limit=20");
      if (!response.ok) {
        return;
      }
      const data = (await response.json()) as { alerts: AlertData[] };
      setAlerts(data.alerts ?? []);
      setUnreadAlerts((data.alerts ?? []).filter((a) => !a.read).length);
    } catch {
      // Badge quietly stays stale.
    }
  }

  async function loadMonitor(): Promise<void> {
    try {
      const response = await fetch("/api/prices/monitor");
      if (!response.ok) {
        return;
      }
      const data = (await response.json()) as { monitoring: MonitorData };
      setMonitor(data.monitoring);
    } catch {
      // Status stays unknown.
    }
  }

  async function loadOpportunities(
    status: OppTab,
    category: "" | Category,
  ): Promise<void> {
    setOppLoading(true);
    setOppError(null);
    try {
      const params = new URLSearchParams({ status, limit: "50" });
      if (category) {
        params.set("category", category);
      }
      const response = await fetch(`/api/opportunities?${params.toString()}`);
      const data = (await response.json()) as {
        opportunities?: OpportunityData[];
        error?: string;
      };
      if (!response.ok) {
        throw new Error(data.error ?? "Could not load opportunities.");
      }
      setOpportunities(data.opportunities ?? []);
    } catch (e) {
      setOppError(
        e instanceof Error ? e.message : "Could not load opportunities.",
      );
    } finally {
      setOppLoading(false);
    }
  }

  async function refreshActiveOpps(): Promise<void> {
    try {
      const response = await fetch("/api/opportunities?status=active&limit=100");
      if (!response.ok) {
        return;
      }
      const data = (await response.json()) as {
        opportunities?: OpportunityData[];
      };
      setActiveOpps(data.opportunities ?? []);
    } catch {
      // Widget quietly stays stale.
    }
  }

  async function markOppRead(id: string): Promise<void> {
    setOppError(null);
    try {
      const response = await fetch("/api/opportunities/read", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: [id] }),
      });
      if (!response.ok) {
        throw new Error("Could not mark as read.");
      }
      await loadOpportunities(oppTab, oppCategory);
      await refreshActiveOpps();
    } catch (e) {
      setOppError(e instanceof Error ? e.message : "Could not mark as read.");
    }
  }

  async function markAllOppRead(): Promise<void> {
    setOppError(null);
    try {
      const response = await fetch("/api/opportunities/read", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: "all" }),
      });
      if (!response.ok) {
        throw new Error("Could not mark all read.");
      }
      await loadOpportunities(oppTab, oppCategory);
      await refreshActiveOpps();
    } catch (e) {
      setOppError(e instanceof Error ? e.message : "Could not mark all read.");
    }
  }

  async function dismissOpp(id: string): Promise<void> {
    setOppError(null);
    try {
      const response = await fetch("/api/opportunities/dismiss", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      if (!response.ok) {
        throw new Error("Could not dismiss.");
      }
      await loadOpportunities(oppTab, oppCategory);
      await refreshActiveOpps();
    } catch (e) {
      setOppError(e instanceof Error ? e.message : "Could not dismiss.");
    }
  }

  async function reevaluateOpp(id: string): Promise<void> {
    if (reevaluatingId) {
      return;
    }
    setReevaluatingId(id);
    setOppError(null);
    setOppNotice(null);
    try {
      const response = await fetch("/api/opportunities/re-evaluate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      const data = (await response.json()) as {
        status?: string;
        error?: string;
        created?: unknown[];
      };
      if (!response.ok) {
        throw new Error(data.error ?? "Re-evaluation failed.");
      }
      const created = data.created ?? [];
      setOppNotice(
        created.length > 0
          ? `Fresh check complete — ${created.length} new opportunity${created.length === 1 ? "" : "s"}.`
          : "Fresh check complete — no change worth a new card.",
      );
      await loadOpportunities(oppTab, oppCategory);
      await refreshActiveOpps();
    } catch (e) {
      setOppError(e instanceof Error ? e.message : "Re-evaluation failed.");
    } finally {
      setReevaluatingId(null);
    }
  }

  function remindAboutOpportunity(opp: OpportunityData): void {
    openReminders({
      title: opp.title,
      note: "",
      productId: opp.productId,
      url: opp.url,
      merchant: opp.merchant,
      watchId: opp.watchId ?? null,
      ...(opp.targetPriceInr != null
        ? { targetPrice: String(opp.targetPriceInr) }
        : {}),
    });
  }

  async function loadReminders(): Promise<void> {
    setRemindersLoading(true);
    setRemindersError(null);
    try {
      const response = await fetch("/api/reminders");
      const data = (await response.json()) as {
        reminders?: ReminderData[];
        error?: string;
      };
      if (!response.ok) {
        throw new Error(data.error ?? "Could not load reminders.");
      }
      setReminders(data.reminders ?? []);
    } catch (e) {
      setRemindersError(
        e instanceof Error ? e.message : "Could not load reminders.",
      );
    } finally {
      setRemindersLoading(false);
    }
  }

  function startReminderEdit(reminder: ReminderData): void {
    const parsed = new Date(reminder.remindAt);
    setRemindersError(null);
    setReminderDraft({
      id: reminder.id,
      title: reminder.title,
      remindAtLocal: Number.isFinite(parsed.getTime())
        ? toLocalInputValue(parsed)
        : "",
      timezone: reminder.timezone,
      note: reminder.note ?? "",
      targetPrice:
        reminder.targetPriceInr != null ? String(reminder.targetPriceInr) : "",
      productId: reminder.productId ?? null,
      url: reminder.url ?? null,
      merchant: reminder.merchant ?? null,
      watchId: reminder.watchId ?? null,
    });
  }

  async function saveReminderDraft(): Promise<void> {
    if (!reminderDraft || savingReminder) {
      return;
    }
    const title = reminderDraft.title.trim();
    if (!title) {
      setRemindersError("Give the reminder a title.");
      return;
    }
    const remindAt = new Date(reminderDraft.remindAtLocal);
    if (!Number.isFinite(remindAt.getTime())) {
      setRemindersError("Pick a valid date and time.");
      return;
    }
    let targetPriceInr: number | null = null;
    if (reminderDraft.targetPrice.trim()) {
      const parsed = Number(reminderDraft.targetPrice.trim());
      if (!Number.isFinite(parsed) || parsed <= 0) {
        setRemindersError("Target price must be above ₹0.");
        return;
      }
      targetPriceInr = parsed;
    }
    setSavingReminder(true);
    setRemindersError(null);
    setRemindersNotice(null);
    try {
      if (reminderDraft.id) {
        const response = await fetch("/api/reminders", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id: reminderDraft.id,
            title,
            remindAt: remindAt.toISOString(),
            timezone: reminderDraft.timezone.trim() || "UTC",
            note: reminderDraft.note.trim() || null,
            targetPriceInr,
          }),
        });
        const data = (await response.json()) as { error?: string };
        if (!response.ok) {
          throw new Error(data.error ?? "Could not update the reminder.");
        }
        setRemindersNotice("Reminder updated.");
      } else {
        const response = await fetch("/api/reminders", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title,
            remindAt: remindAt.toISOString(),
            timezone: reminderDraft.timezone.trim() || "UTC",
            ...(reminderDraft.note.trim()
              ? { note: reminderDraft.note.trim() }
              : {}),
            ...(targetPriceInr != null ? { targetPriceInr } : {}),
            ...(reminderDraft.productId
              ? { productId: reminderDraft.productId }
              : {}),
            ...(reminderDraft.url ? { url: reminderDraft.url } : {}),
            ...(reminderDraft.merchant
              ? { merchant: reminderDraft.merchant }
              : {}),
            ...(reminderDraft.watchId ? { watchId: reminderDraft.watchId } : {}),
          }),
        });
        const data = (await response.json()) as { error?: string };
        if (!response.ok) {
          throw new Error(data.error ?? "Could not save the reminder.");
        }
        setRemindersNotice("Reminder saved.");
      }
      setReminderDraft(null);
      await loadReminders();
    } catch (e) {
      setRemindersError(
        e instanceof Error ? e.message : "Could not save the reminder.",
      );
    } finally {
      setSavingReminder(false);
    }
  }

  async function deleteReminderById(id: string): Promise<void> {
    setRemindersError(null);
    try {
      const response = await fetch(
        `/api/reminders?id=${encodeURIComponent(id)}`,
        { method: "DELETE" },
      );
      if (!response.ok) {
        throw new Error("Could not delete the reminder.");
      }
      if (reminderDraft?.id === id) {
        setReminderDraft(null);
      }
      await loadReminders();
    } catch (e) {
      setRemindersError(
        e instanceof Error ? e.message : "Could not delete the reminder.",
      );
    }
  }

  async function setReminderStatus(
    id: string,
    status: "active" | "disabled",
  ): Promise<void> {
    setRemindersError(null);
    try {
      const response = await fetch("/api/reminders", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, status }),
      });
      if (!response.ok) {
        throw new Error("Could not update the reminder.");
      }
      await loadReminders();
    } catch (e) {
      setRemindersError(
        e instanceof Error ? e.message : "Could not update the reminder.",
      );
    }
  }

  async function loadSettings(): Promise<void> {
    try {
      const response = await fetch("/api/settings/notifications");
      if (!response.ok) {
        return;
      }
      const data = (await response.json()) as {
        settings: NotificationSettingsData;
      };
      setSettings(data.settings);
    } catch {
      // Settings stay unavailable.
    }
  }

  async function saveSettings(
    patch: Partial<NotificationSettingsData>,
  ): Promise<void> {
    if (settingsSaving) {
      return;
    }
    setSettingsSaving(true);
    setSettingsNotice(null);
    try {
      const response = await fetch("/api/settings/notifications", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const data = (await response.json()) as {
        settings?: NotificationSettingsData;
        error?: string;
      };
      if (!response.ok || !data.settings) {
        throw new Error(data.error ?? "Could not save settings.");
      }
      setSettings(data.settings);
      setSettingsNotice("Notification settings saved.");
    } catch (e) {
      setSettingsNotice(
        e instanceof Error ? e.message : "Could not save settings.",
      );
    } finally {
      setSettingsSaving(false);
    }
  }

  function openOpps(): void {
    if (oppsOpen) {
      setOppsOpen(false);
      return;
    }
    setPrefsOpen(false);
    setProposalsOpen(false);
    setWatchesOpen(false);
    setRemindersOpen(false);
    setChatOpen(false);
    setOppsOpen(true);
    setOppNotice(null);
    setOppError(null);
    void loadOpportunities(oppTab, oppCategory);
    void refreshActiveOpps();
  }

  function openChat(prefill?: {
    input: string;
    product: ChatProductHint | null;
  }): void {
    if (chatOpen && !prefill) {
      setChatOpen(false);
      return;
    }
    setPrefsOpen(false);
    setProposalsOpen(false);
    setWatchesOpen(false);
    setRemindersOpen(false);
    setOppsOpen(false);
    setChatOpen(true);
    setChatError(null);
    if (prefill) {
      setChatThread(null);
      setChatInput(prefill.input);
      setChatProduct(prefill.product);
    }
    void loadChatThreads();
  }

  function askAboutOpportunity(opp: OpportunityData): void {
    openChat({
      input: `Is ${opp.title} still a good deal?`,
      product: { productId: opp.productId, title: opp.title },
    });
  }

  async function loadChatThreads(): Promise<void> {
    setChatLoading(true);
    try {
      const response = await fetch("/api/chat/threads");
      if (!response.ok) {
        return;
      }
      const data = (await response.json()) as { threads: ChatThreadData[] };
      setChatThreads(data.threads ?? []);
    } catch {
      // Thread list quietly stays stale.
    } finally {
      setChatLoading(false);
    }
  }

  async function sendChat(): Promise<void> {
    const message = chatInput.trim();
    if (!message || chatSending) {
      return;
    }
    setChatSending(true);
    setChatError(null);
    setChatInput("");
    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message,
          ...(chatThread ? { threadId: chatThread.id } : {}),
          ...(chatProduct ? { productId: chatProduct.productId } : {}),
        }),
      });
      const data = (await response.json()) as {
        thread?: ChatThreadData;
        error?: string;
      };
      if (!response.ok || !data.thread) {
        throw new Error(data.error ?? "Could not send your message.");
      }
      setChatThread(data.thread);
      setChatThreads((prev) => {
        const rest = prev.filter((entry) => entry.id !== data.thread?.id);
        return data.thread ? [data.thread, ...rest] : rest;
      });
    } catch (e) {
      setChatError(e instanceof Error ? e.message : "Could not send.");
      setChatInput(message);
    } finally {
      setChatSending(false);
    }
  }

  async function deleteChatThreadById(id: string): Promise<void> {
    try {
      const response = await fetch(
        `/api/chat/threads?id=${encodeURIComponent(id)}`,
        { method: "DELETE" },
      );
      if (!response.ok) {
        throw new Error("Could not delete the conversation.");
      }
      setChatThreads((prev) => prev.filter((entry) => entry.id !== id));
      if (chatThread?.id === id) {
        setChatThread(null);
      }
    } catch (e) {
      setChatError(
        e instanceof Error ? e.message : "Could not delete the conversation.",
      );
    }
  }

  function startTrack(product: Product): void {
    setPrefsOpen(false);
    setProposalsOpen(false);
    setRemindersOpen(false);
    setChatOpen(false);
    setOppsOpen(false);
    setWatchesOpen(true);
    setWatchesNotice(null);
    setWatchesError(null);
    setTrackDraft({
      productId: product.id,
      url: product.url,
      title: product.title,
      merchant: product.merchant,
      sourceId: product.sourceId,
      currentPrice: product.priceInr ?? null,
      target: "",
      canWait: true,
    });
    void loadWatches();
    void loadAlerts();
    void loadMonitor();
    void loadSettings();
  }

  async function createWatch(): Promise<void> {
    if (!trackDraft || creatingWatch) {
      return;
    }
    const target = Number(trackDraft.target.trim());
    if (!Number.isFinite(target) || target <= 0) {
      setWatchesError("Enter a target price above ₹0.");
      return;
    }
    setCreatingWatch(true);
    setWatchesError(null);
    setWatchesNotice(null);
    try {
      const response = await fetch("/api/memory/watches", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          productId: trackDraft.productId,
          url: trackDraft.url,
          title: trackDraft.title,
          merchant: trackDraft.merchant,
          sourceId: trackDraft.sourceId,
          targetPrice: target,
          canWait: trackDraft.canWait,
        }),
      });
      const data = (await response.json()) as {
        error?: string;
        alert?: unknown;
        realismWarning?: string | null;
      };
      if (!response.ok) {
        throw new Error(data.error ?? "Could not track this product.");
      }
      setTrackDraft(null);
      setWatchesNotice(
        data.realismWarning ??
          (data.alert
            ? "Target already met — alert created."
            : "Watching this product."),
      );
      await loadWatches();
      await loadAlerts();
    } catch (e) {
      setWatchesError(
        e instanceof Error ? e.message : "Could not track this product.",
      );
    } finally {
      setCreatingWatch(false);
    }
  }

  async function saveWatchTarget(id: string): Promise<void> {
    const target = Number(editTarget.trim());
    if (!Number.isFinite(target) || target <= 0) {
      setWatchesError("Enter a target price above ₹0.");
      return;
    }
    setWatchesError(null);
    try {
      const response = await fetch("/api/memory/watches", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, targetPrice: target }),
      });
      if (!response.ok) {
        const data = (await response.json()) as { error?: string };
        throw new Error(data.error ?? "Could not update target.");
      }
      setEditingWatchId(null);
      setWatchesNotice("Target updated.");
      await loadWatches();
    } catch (e) {
      setWatchesError(
        e instanceof Error ? e.message : "Could not update target.",
      );
    }
  }

  async function toggleWatchActive(entry: EnrichedWatch): Promise<void> {
    setWatchesError(null);
    try {
      const response = await fetch("/api/memory/watches", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: entry.watch.id,
          active: !entry.watch.active,
        }),
      });
      if (!response.ok) {
        throw new Error("Could not update this watch.");
      }
      setWatchesNotice(
        entry.watch.active ? "Watch paused." : "Watch resumed.",
      );
      await loadWatches();
    } catch (e) {
      setWatchesError(
        e instanceof Error ? e.message : "Could not update this watch.",
      );
    }
  }

  async function removeWatch(id: string): Promise<void> {
    if (
      !window.confirm("Stop tracking this product? Past alerts are kept.")
    ) {
      return;
    }
    setWatchesError(null);
    try {
      const response = await fetch(
        `/api/memory/watches?id=${encodeURIComponent(id)}`,
        { method: "DELETE" },
      );
      if (!response.ok) {
        throw new Error("Could not remove this watch.");
      }
      setWatchesNotice("Watch removed.");
      await loadWatches();
    } catch (e) {
      setWatchesError(
        e instanceof Error ? e.message : "Could not remove this watch.",
      );
    }
  }

  async function checkWatchNow(id: string): Promise<void> {
    if (checkingId) {
      return;
    }
    setCheckingId(id);
    setWatchesError(null);
    setWatchesNotice(null);
    try {
      const response = await fetch("/api/memory/watches/check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      const data = (await response.json()) as {
        status: string;
        error?: string;
        observation?: { priceInr: number };
        alert?: { observedPrice: number } | null;
      };
      if (!response.ok) {
        throw new Error(data.error ?? "Check failed.");
      }
      if (data.status !== "ok") {
        setWatchesError(data.error ?? "Check failed.");
      } else if (data.alert) {
        setWatchesNotice(
          `Target met at ${formatInr(data.alert.observedPrice)} — alert created.`,
        );
      } else if (data.observation) {
        setWatchesNotice(
          `Checked: ${formatInr(data.observation.priceInr)}.`,
        );
      } else {
        setWatchesNotice("Checked.");
      }
      await loadWatches();
      await loadAlerts();
    } catch (e) {
      setWatchesError(e instanceof Error ? e.message : "Check failed.");
    } finally {
      setCheckingId(null);
    }
  }

  async function markAllAlertsRead(): Promise<void> {
    try {
      await fetch("/api/memory/alerts/read", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ all: true }),
      });
      await loadAlerts();
    } catch {
      // Badge quietly stays stale.
    }
  }

  async function fetchReviews(): Promise<void> {
    if (!verdict || !effectiveCategory || reviewsLoading) {
      return;
    }
    const targets = verdict.ranked.slice(0, 3);
    if (targets.length === 0) {
      return;
    }
    setReviewsLoading(true);
    setReviewsError(null);
    try {
      const response = await fetch("/api/reviews", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          products: targets.map((t) => ({
            id: t.product.id,
            title: t.product.title,
          })),
          category: effectiveCategory,
          requirements: verdict.requirements,
          rankedTotals: verdict.ranked.map((t) => ({
            id: t.product.id,
            total: t.score.total,
          })),
        }),
      });
      const data = (await response.json()) as ReviewsResponse & {
        error?: string;
      };
      if (!response.ok) {
        throw new Error(
          data.error ?? `review insights failed (${response.status})`,
        );
      }
      setReviews(data);
    } catch (e) {
      setReviewsError(
        e instanceof Error
          ? e.message
          : "Could not gather review insights. Please try again.",
      );
    } finally {
      setReviewsLoading(false);
    }
  }

  async function runSearch(next?: {
    allowOverBudget?: boolean;
  }): Promise<void> {
    if (
      !result ||
      !effectiveCategory ||
      !requirementsComplete ||
      stage === "searching" ||
      stage === "recommending"
    ) {
      return;
    }
    const over = next?.allowOverBudget ?? allowOverBudget;
    setAllowOverBudget(over);
    let phase: "search" | "recommend" = "search";
    clearDownstream();
    setStage("searching");
    try {
      const searchResponse = await fetch("/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: result.intent.query,
          category: effectiveCategory,
          disabled,
          allowOverBudget: over,
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
          requirements: reqs?.requirements,
          weights: normalizeWeights(weights),
          allowOverBudget: over,
          personalize: useProfile,
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
      case "INSUFFICIENT_EVIDENCE":
        return "bg-violet-300 text-violet-950";
      case "NEEDS_CLARIFICATION":
        return "bg-sky-300 text-sky-950";
      default:
        return "border border-white/15 bg-white/10 text-stone-200";
    }
  };

  const verdictLabel = (v: Recommendation["verdict"]): string =>
    v.replace(/_/g, " ");

  function watchStatusChip(entry: EnrichedWatch): {
    label: string;
    className: string;
  } {
    const base = "rounded-full border px-2 py-0.5 text-[11px] font-semibold";
    const { watch, latest, stats } = entry;
    if (!watch.active) {
      return {
        label: "Paused",
        className: `${base} border-white/10 bg-white/5 text-stone-400`,
      };
    }
    if (watch.lastCheck && watch.lastCheck.status !== "ok") {
      const label =
        watch.lastCheck.status === "unavailable"
          ? "Unavailable"
          : watch.lastCheck.status === "no-price"
            ? "No price found"
            : "Check failed";
      return {
        label,
        className: `${base} border-rose-300/30 bg-rose-300/10 text-rose-200`,
      };
    }
    if (latest && latest.priceInr <= watch.targetPrice) {
      return {
        label: "Target met",
        className: `${base} border-teal-300/30 bg-teal-300/10 text-teal-200`,
      };
    }
    if (!latest || stats.stale) {
      return {
        label: "No recent data",
        className: `${base} border-white/10 bg-white/5 text-stone-400`,
      };
    }
    return {
      label: "Watching",
      className: `${base} border-sky-300/30 bg-sky-300/10 text-sky-200`,
    };
  }

  const verdictProduct =
    verdict?.recommendation.productId != null
      ? cards.find((c) => c.product.id === verdict.recommendation.productId)?.product ?? null
      : null;

  function renderCategoryField(field: CategoryField): ReactNode {
    const label = CATEGORY_FIELD_LABELS[field];
    const value = catDraft[field];
    const set = (next: string) =>
      setCatDraft((prev) => ({ ...prev, [field]: next }));
    const inputClass =
      "mt-1 w-full rounded-lg border border-white/10 bg-white/5 p-2.5 text-sm text-stone-100 placeholder:text-stone-500 focus:border-teal-300/60 focus:ring-2 focus:ring-teal-300/20 focus:outline-none";
    if (field === "performanceLevel") {
      return (
        <label key={field} className="block text-xs text-stone-400">
          {label}
          <select
            value={value}
            onChange={(event) => set(event.target.value)}
            className={inputClass}
          >
            <option value="">Not set</option>
            <option value="basic">Basic</option>
            <option value="balanced">Balanced</option>
            <option value="high">High</option>
            <option value="workstation">Workstation</option>
          </select>
        </label>
      );
    }
    if (field === "portability") {
      return (
        <label key={field} className="block text-xs text-stone-400">
          {label}
          <select
            value={value}
            onChange={(event) => set(event.target.value)}
            className={inputClass}
          >
            <option value="">Not set</option>
            <option value="desk">Mostly desk-bound</option>
            <option value="balanced">Balanced</option>
            <option value="ultralight">Ultralight</option>
          </select>
        </label>
      );
    }
    const numeric = [
      "budgetMin",
      "budgetMax",
      "minRamGb",
      "minStorageGb",
      "batteryPriority",
      "warrantyPriority",
    ].includes(field);
    return (
      <label key={field} className="block text-xs text-stone-400">
        {label}
        <input
          type="text"
          inputMode={numeric ? "decimal" : "text"}
          value={value}
          onChange={(event) => set(event.target.value)}
          placeholder="Not set"
          className={inputClass}
        />
      </label>
    );
  }

  if (!authChecked) {
    return (
      <main className="relative mx-auto flex min-h-screen max-w-3xl flex-col items-center justify-center px-4 text-stone-500">
        <p className="flex items-center gap-2 text-sm">
          <span
            aria-hidden="true"
            className="h-4 w-4 rounded-full border-2 border-stone-500/30 border-t-stone-200 motion-safe:animate-spin"
          />
          Checking sign-in…
        </p>
      </main>
    );
  }

  const activeReminderCount = reminders.filter(
    (entry) => entry.status === "active",
  ).length;
  const drawerOnLeft = remindersOpen || chatOpen || oppsOpen;

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
          {authChecked &&
            (user ? (
              <div className="fixed top-3 right-3 z-30 flex items-center gap-1.5 rounded-full border border-white/15 bg-stone-950/70 py-1 pr-1.5 pl-1 shadow-lg backdrop-blur-xl sm:top-4 sm:right-4">
                <div className="relative flex h-7 w-7 items-center justify-center overflow-hidden rounded-full border border-white/15 bg-white/10 text-xs font-semibold text-teal-200">
                  {(user.name ?? user.email ?? "?").charAt(0).toUpperCase()}
                  {user.picture && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={user.picture}
                      alt=""
                      referrerPolicy="no-referrer"
                      onError={(event) => {
                        event.currentTarget.style.display = "none";
                      }}
                      className="absolute inset-0 h-full w-full object-cover"
                    />
                  )}
                </div>
                <div className="hidden text-right sm:block">
                  <p className="max-w-[9rem] truncate text-xs font-medium text-stone-200">
                    {user.name ?? user.email ?? "Signed in"}
                  </p>
                  {user.email && user.name && (
                    <p className="max-w-[9rem] truncate text-[11px] leading-tight text-stone-500">
                      {user.email}
                    </p>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => void signOut()}
                  className="rounded-md border border-white/15 bg-white/5 px-2 py-1 text-[11px] font-semibold text-stone-300 transition hover:border-white/30 hover:text-stone-100"
                >
                  Sign out
                </button>
              </div>
            ) : (
              <Link
                href="/login"
                className="fixed top-3 right-3 z-30 rounded-lg border border-white/15 bg-stone-950/70 px-4 py-2 text-sm font-semibold text-stone-200 shadow-lg backdrop-blur-xl transition hover:border-teal-300/50 hover:text-teal-200 sm:top-4 sm:right-4"
              >
                Sign in
              </Link>
            ))}
        <h1 className="mt-3 font-serif text-4xl leading-tight text-stone-50 sm:text-5xl">
          Buy smarter, with evidence.
        </h1>
        <p className="mt-3 max-w-xl text-base leading-relaxed text-stone-400">
          Describe what you want. Wisora finds real options across trusted
          Indian stores, compares them, and recommends with reasons —
          never guesses.
        </p>
      </header>
      {user &&
        activeOpps.length > 0 &&
        !oppsOpen &&
        (() => {
          const position =
            ((widgetIndex % activeOpps.length) + activeOpps.length) %
            activeOpps.length;
          const current = activeOpps[position];
          if (!current) {
            return null;
          }
          const step = (delta: number) => (event: React.SyntheticEvent) => {
            event.stopPropagation();
            setWidgetIndex((index) => index + delta);
          };
          return (
            <div
              role="button"
              tabIndex={0}
              aria-label={`${activeOpps.length} active opportunit${activeOpps.length === 1 ? "y" : "ies"}. Open alerts list.`}
              onClick={() => openOpps()}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  openOpps();
                }
              }}
              onMouseEnter={() => setWidgetPaused(true)}
              onMouseLeave={() => setWidgetPaused(false)}
              onFocus={() => setWidgetPaused(true)}
              onBlur={() => setWidgetPaused(false)}
              className="fixed top-3 left-0 z-30 w-52 cursor-pointer rounded-r-xl border border-l-0 border-white/15 bg-stone-950/85 p-2 shadow-lg backdrop-blur-xl transition hover:border-teal-300/50 sm:top-4"
            >
              <div className="flex items-center gap-2">
                <span className="text-[11px] font-semibold tracking-wide text-teal-300 uppercase">
                  Alerts
                </span>
                <span className="ml-auto text-[11px] text-stone-500">
                  {position + 1}/{activeOpps.length}
                </span>
                {activeOpps.length > 1 && (
                  <span className="flex gap-0.5">
                    <button
                      type="button"
                      aria-label="Previous alert"
                      onClick={step(-1)}
                      className="rounded px-1 text-xs text-stone-500 hover:text-stone-200"
                    >
                      ‹
                    </button>
                    <button
                      type="button"
                      aria-label="Next alert"
                      onClick={step(1)}
                      className="rounded px-1 text-xs text-stone-500 hover:text-stone-200"
                    >
                      ›
                    </button>
                  </span>
                )}
              </div>
              <p
                title={current.title}
                className="mt-1 truncate text-xs font-medium text-stone-100"
              >
                {current.title}
              </p>
              <p className="mt-0.5 flex items-center gap-1.5 text-xs">
                <span
                  className={`rounded-full border px-1.5 py-px text-[10px] font-semibold ${oppKindChip(current.kind)}`}
                >
                  {OPP_KIND_LABELS[current.kind]}
                </span>
                {current.currentPriceInr != null && (
                  <span className="font-semibold text-stone-200">
                    {formatInr(current.currentPriceInr)}
                  </span>
                )}
              </p>
            </div>
          );
        })()}
      {user && (
        <div className="fixed top-1/2 right-0 z-50 flex max-h-[calc(100dvh-5rem)] -translate-y-1/2 flex-col gap-2 overflow-y-auto overscroll-contain py-1">
          <button
            type="button"
            onClick={openPrefs}
            aria-expanded={prefsOpen}
            aria-label="Preferences"
            className={
              prefsOpen
                ? "rounded-l-lg border border-r-0 border-teal-300/50 bg-teal-300/10 px-3 py-6 shadow-lg backdrop-blur-xl"
                : "rounded-l-lg border border-r-0 border-white/15 bg-stone-950/90 px-3 py-6 shadow-lg backdrop-blur-xl transition hover:border-teal-300/50"
            }
          >
            <span className="[writing-mode:vertical-rl] rotate-180 text-sm font-semibold tracking-wide text-stone-200">
              Preferences
            </span>
          </button>
          <button
            type="button"
            onClick={openProposals}
            aria-expanded={proposalsOpen}
            aria-label={
              proposalCount > 0
                ? `Suggestions, ${proposalCount} pending`
                : "Suggestions"
            }
            className={
              proposalsOpen
                ? "rounded-l-lg border border-r-0 border-teal-300/50 bg-teal-300/10 px-3 py-6 shadow-lg backdrop-blur-xl"
                : "rounded-l-lg border border-r-0 border-white/15 bg-stone-950/90 px-3 py-6 shadow-lg backdrop-blur-xl transition hover:border-teal-300/50"
            }
          >
            <span className="[writing-mode:vertical-rl] rotate-180 text-sm font-semibold tracking-wide text-stone-200">
              {proposalCount > 0 ? `Suggestions (${proposalCount})` : "Suggestions"}
            </span>
          </button>
          <button
            type="button"
            onClick={openWatches}
            aria-expanded={watchesOpen}
            aria-label={
              unreadAlerts > 0
                ? `Watchlist, ${unreadAlerts} unread alerts`
                : "Watchlist"
            }
            className={
              watchesOpen
                ? "rounded-l-lg border border-r-0 border-teal-300/50 bg-teal-300/10 px-3 py-6 shadow-lg backdrop-blur-xl"
                : "rounded-l-lg border border-r-0 border-white/15 bg-stone-950/90 px-3 py-6 shadow-lg backdrop-blur-xl transition hover:border-teal-300/50"
            }
          >
            <span className="[writing-mode:vertical-rl] rotate-180 text-sm font-semibold tracking-wide text-stone-200">
              {unreadAlerts > 0 ? `Watchlist (${unreadAlerts})` : "Watchlist"}
            </span>
          </button>
        </div>
      )}
      {user && (
        <div className="fixed top-1/2 left-0 z-50 flex max-h-[calc(100dvh-5rem)] -translate-y-1/2 flex-col gap-2 overflow-y-auto overscroll-contain py-1">
          <button
            type="button"
            onClick={() => openOpps()}
            aria-expanded={oppsOpen}
            aria-label={
              activeOpps.length > 0
                ? `Opportunities, ${activeOpps.length} active`
                : "Opportunities"
            }
            className={
              oppsOpen
                ? "rounded-r-lg border border-l-0 border-teal-300/50 bg-teal-300/10 px-3 py-6 shadow-lg backdrop-blur-xl"
                : "rounded-r-lg border border-l-0 border-white/15 bg-stone-950/90 px-3 py-6 shadow-lg backdrop-blur-xl transition hover:border-teal-300/50"
            }
          >
            <span className="[writing-mode:vertical-rl] rotate-180 text-sm font-semibold tracking-wide text-stone-200">
              {activeOpps.length > 0
                ? `Alerts (${activeOpps.length})`
                : "Alerts"}
            </span>
          </button>
          <button
            type="button"
            onClick={() => openReminders()}
            aria-expanded={remindersOpen}
            aria-label={
              activeReminderCount > 0
                ? `Reminders, ${activeReminderCount} active`
                : "Reminders"
            }
            className={
              remindersOpen
                ? "rounded-r-lg border border-l-0 border-teal-300/50 bg-teal-300/10 px-3 py-6 shadow-lg backdrop-blur-xl"
                : "rounded-r-lg border border-l-0 border-white/15 bg-stone-950/90 px-3 py-6 shadow-lg backdrop-blur-xl transition hover:border-teal-300/50"
            }
          >
            <span className="[writing-mode:vertical-rl] rotate-180 text-sm font-semibold tracking-wide text-stone-200">
              {activeReminderCount > 0
                ? `Reminders (${activeReminderCount})`
                : "Reminders"}
            </span>
          </button>
          <button
            type="button"
            onClick={() => openChat()}
            aria-expanded={chatOpen}
            aria-label="Chat with Wisora"
            className={
              chatOpen
                ? "rounded-r-lg border border-l-0 border-teal-300/50 bg-teal-300/10 px-3 py-6 shadow-lg backdrop-blur-xl"
                : "rounded-r-lg border border-l-0 border-white/15 bg-stone-950/90 px-3 py-6 shadow-lg backdrop-blur-xl transition hover:border-teal-300/50"
            }
          >
            <span className="[writing-mode:vertical-rl] rotate-180 text-sm font-semibold tracking-wide text-stone-200">
              Chat
            </span>
          </button>
        </div>
      )}

      {(prefsOpen ||
        proposalsOpen ||
        watchesOpen ||
        remindersOpen ||
        chatOpen ||
        oppsOpen) && (
        <button
          type="button"
          aria-label="Close panel"
          onClick={() => {
            setPrefsOpen(false);
            setProposalsOpen(false);
            setWatchesOpen(false);
            setRemindersOpen(false);
            setChatOpen(false);
            setOppsOpen(false);
          }}
          className="fixed inset-0 z-40 h-full w-full cursor-default bg-black/60"
        />
      )}
      {(prefsOpen ||
        proposalsOpen ||
        watchesOpen ||
        remindersOpen ||
        chatOpen ||
        oppsOpen) && (
        <section
          aria-label={
            prefsOpen
              ? "Preferences"
              : proposalsOpen
                ? "Suggestions"
                : watchesOpen
                  ? "Watchlist"
                  : remindersOpen
                    ? "Reminders"
                    : oppsOpen
                      ? "Opportunities"
                      : "Chat"
          }
          role="dialog"
          aria-modal="true"
          className={
            drawerOnLeft
              ? "fixed top-0 left-0 z-40 h-full w-full max-w-lg overflow-y-auto border-r border-white/10 bg-stone-950/95 p-5 pl-12 shadow-2xl backdrop-blur-xl motion-safe:animate-[drawer-in-left_0.25s_ease-out]"
              : "fixed top-0 right-0 z-40 h-full w-full max-w-lg overflow-y-auto border-l border-white/10 bg-stone-950/95 p-5 pr-12 shadow-2xl backdrop-blur-xl motion-safe:animate-[drawer-in_0.25s_ease-out]"
          }
        >
          {prefsOpen ? (
            <div>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="text-base font-semibold text-stone-100">
                    Your preferences
                  </h2>
                  <p className="mt-1 text-xs text-stone-500">
                    Saved preferences personalize future recommendations.
                    Your current request always wins over anything saved.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setPrefsOpen(false)}
                  className="rounded-md border border-white/15 bg-white/5 px-2.5 py-1 text-xs font-semibold text-stone-300 transition hover:border-white/30 hover:text-stone-100"
                >
                  Close
                </button>
              </div>
              {summaryLoading ? (
                <p className="mt-4 text-sm text-stone-500">Loading…</p>
              ) : (
                <>
                  <div className="mt-4">
                    <h3 className="text-sm font-semibold text-stone-200">
                      General
                    </h3>
                    {profile && (
                      <p className="mt-1 text-xs text-stone-500">
                        Saved {formatSavedDate(profile.general.updatedAt)} ·{" "}
                        {provenanceLabel(profile.general.provenance)}
                      </p>
                    )}
                    <div className="mt-3 grid gap-3 sm:grid-cols-3">
                      <label className="block text-xs text-stone-400">
                        Currency
                        <input
                          type="text"
                          value={generalDraft.currency}
                          onChange={(event) =>
                            setGeneralDraft((prev) => ({
                              ...prev,
                              currency: event.target.value,
                            }))
                          }
                          placeholder="INR"
                          maxLength={3}
                          className="mt-1 w-full rounded-lg border border-white/10 bg-white/5 p-2.5 text-sm text-stone-100 uppercase placeholder:text-stone-500 focus:border-teal-300/60 focus:ring-2 focus:ring-teal-300/20 focus:outline-none"
                        />
                      </label>
                      <label className="block text-xs text-stone-400">
                        Locale
                        <input
                          type="text"
                          value={generalDraft.locale}
                          onChange={(event) =>
                            setGeneralDraft((prev) => ({
                              ...prev,
                              locale: event.target.value,
                            }))
                          }
                          placeholder="en-IN"
                          className="mt-1 w-full rounded-lg border border-white/10 bg-white/5 p-2.5 text-sm text-stone-100 placeholder:text-stone-500 focus:border-teal-300/60 focus:ring-2 focus:ring-teal-300/20 focus:outline-none"
                        />
                      </label>
                      <label className="block text-xs text-stone-400">
                        Decide by
                        <select
                          value={generalDraft.decisionPriority}
                          onChange={(event) =>
                            setGeneralDraft((prev) => ({
                              ...prev,
                              decisionPriority: event.target.value,
                            }))
                          }
                          className="mt-1 w-full rounded-lg border border-white/10 bg-white/5 p-2.5 text-sm text-stone-100 focus:border-teal-300/60 focus:ring-2 focus:ring-teal-300/20 focus:outline-none"
                        >
                          {DECISION_PRIORITIES.map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.label}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>
                    <div className="mt-3">
                      <p className="text-xs text-stone-400">
                        Categories you shop
                      </p>
                      <div className="mt-1.5 flex flex-wrap gap-2">
                        {CATEGORIES.map((c) => {
                          const active =
                            generalDraft.categories.includes(c.id);
                          return (
                            <button
                              key={c.id}
                              type="button"
                              aria-pressed={active}
                              onClick={() =>
                                setGeneralDraft((prev) => ({
                                  ...prev,
                                  categories: active
                                    ? prev.categories.filter(
                                        (id) => id !== c.id,
                                      )
                                    : [...prev.categories, c.id],
                                }))
                              }
                              className={
                                active
                                  ? "rounded-full bg-teal-300 px-3 py-1.5 text-xs font-semibold text-teal-950"
                                  : "rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-stone-300 hover:border-white/30"
                              }
                            >
                              {c.label}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                    <div className="mt-3 grid gap-3 sm:grid-cols-3">
                      <label className="block text-xs text-stone-400">
                        Preferred brands (comma-separated)
                        <input
                          type="text"
                          value={generalDraft.preferredBrands}
                          onChange={(event) =>
                            setGeneralDraft((prev) => ({
                              ...prev,
                              preferredBrands: event.target.value,
                            }))
                          }
                          placeholder="Sony, Bose"
                          className="mt-1 w-full rounded-lg border border-white/10 bg-white/5 p-2.5 text-sm text-stone-100 placeholder:text-stone-500 focus:border-teal-300/60 focus:ring-2 focus:ring-teal-300/20 focus:outline-none"
                        />
                      </label>
                      <label className="block text-xs text-stone-400">
                        Avoided brands (comma-separated)
                        <input
                          type="text"
                          value={generalDraft.avoidedBrands}
                          onChange={(event) =>
                            setGeneralDraft((prev) => ({
                              ...prev,
                              avoidedBrands: event.target.value,
                            }))
                          }
                          placeholder="Acme"
                          className="mt-1 w-full rounded-lg border border-white/10 bg-white/5 p-2.5 text-sm text-stone-100 placeholder:text-stone-500 focus:border-teal-300/60 focus:ring-2 focus:ring-teal-300/20 focus:outline-none"
                        />
                      </label>
                      <label className="block text-xs text-stone-400">
                        Preferred stores (comma-separated)
                        <input
                          type="text"
                          value={generalDraft.preferredMerchants}
                          onChange={(event) =>
                            setGeneralDraft((prev) => ({
                              ...prev,
                              preferredMerchants: event.target.value,
                            }))
                          }
                          placeholder="Amazon India, Flipkart"
                          className="mt-1 w-full rounded-lg border border-white/10 bg-white/5 p-2.5 text-sm text-stone-100 placeholder:text-stone-500 focus:border-teal-300/60 focus:ring-2 focus:ring-teal-300/20 focus:outline-none"
                        />
                      </label>
                    </div>
                    <div className="mt-3 flex flex-wrap items-center gap-3">
                      <button
                        type="button"
                        onClick={() => void saveGeneral()}
                        disabled={savingGeneral}
                        className="rounded-lg bg-white px-4 py-2 text-sm font-semibold text-stone-950 transition hover:bg-teal-200 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {savingGeneral ? "Saving…" : "Save general"}
                      </button>
                      {profileNotice && (
                        <span className="text-xs text-teal-200">
                          {profileNotice}
                        </span>
                      )}
                    </div>
                    {profileError && (
                      <p className="mt-2 rounded-lg border border-red-400/30 bg-red-500/10 p-2.5 text-xs text-red-200">
                        {profileError}
                      </p>
                    )}
                  </div>

                  <div className="mt-6 border-t border-white/10 pt-4">
                    <h3 className="text-sm font-semibold text-stone-200">
                      Category preferences
                    </h3>
                    <div
                      className="mt-2 flex flex-wrap gap-2"
                      role="group"
                      aria-label="Preference category"
                    >
                      {CATEGORIES.map((c) => (
                        <button
                          key={c.id}
                          type="button"
                          aria-pressed={catTab === c.id}
                          onClick={() => switchCatTab(c.id)}
                          className={
                            catTab === c.id
                              ? "rounded-full bg-teal-300 px-3 py-1.5 text-xs font-semibold text-teal-950"
                              : "rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-stone-300 hover:border-white/30"
                          }
                        >
                          {c.label}
                        </button>
                      ))}
                    </div>
                    {profile?.categories[catTab] && (
                      <p className="mt-2 text-xs text-stone-500">
                        Saved{" "}
                        {formatSavedDate(
                          (profile.categories[catTab] as StoredSection<CategoryValue>)
                            .updatedAt,
                        )}{" "}
                        ·{" "}
                        {provenanceLabel(
                          (profile.categories[catTab] as StoredSection<CategoryValue>)
                            .provenance,
                        )}
                      </p>
                    )}
                    <div className="mt-3 grid gap-3 sm:grid-cols-2">
                      {CATEGORY_FIELDS[catTab].map((field) =>
                        renderCategoryField(field),
                      )}
                    </div>
                    <div className="mt-3 flex flex-wrap items-center gap-3">
                      <button
                        type="button"
                        onClick={() => void saveCategory()}
                        disabled={savingCategory}
                        className="rounded-lg bg-white px-4 py-2 text-sm font-semibold text-stone-950 transition hover:bg-teal-200 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {savingCategory
                          ? "Saving…"
                          : `Save ${categoryLabel(catTab).toLowerCase()}`}
                      </button>
                      {catNotice && (
                        <span className="text-xs text-teal-200">{catNotice}</span>
                      )}
                    </div>
                    {catError && (
                      <p className="mt-2 rounded-lg border border-red-400/30 bg-red-500/10 p-2.5 text-xs text-red-200">
                        {catError}
                      </p>
                    )}
                  </div>

                  <div className="mt-6 border-t border-white/10 pt-4">
                    <h3 className="text-sm font-semibold text-stone-200">
                      Your saved data
                    </h3>
                    {summaryError ? (
                      <p className="mt-2 text-xs text-red-200">{summaryError}</p>
                    ) : summary ? (
                      <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-stone-400 sm:grid-cols-3">
                        <div className="flex justify-between gap-2">
                          <dt>Preferences</dt>
                          <dd className="text-stone-200">
                            {summary.hasProfile ? "saved" : "none yet"}
                          </dd>
                        </div>
                        <div className="flex justify-between gap-2">
                          <dt>Decisions</dt>
                          <dd className="text-stone-200">{summary.decisions}</dd>
                        </div>
                        <div className="flex justify-between gap-2">
                          <dt>Feedback</dt>
                          <dd className="text-stone-200">{summary.feedback}</dd>
                        </div>
                        <div className="flex justify-between gap-2">
                          <dt>Saved products</dt>
                          <dd className="text-stone-200">
                            {summary.savedProducts}
                          </dd>
                        </div>
                        <div className="flex justify-between gap-2">
                          <dt>Comparisons</dt>
                          <dd className="text-stone-200">
                            {summary.savedComparisons}
                          </dd>
                        </div>
                        <div className="flex justify-between gap-2">
                          <dt>Suggestions</dt>
                          <dd className="text-stone-200">
                            {summary.proposalsPending} pending
                          </dd>
                        </div>
                      </dl>
                    ) : (
                      <p className="mt-2 text-xs text-stone-500">Loading…</p>
                    )}
                    <div className="mt-3 flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => void clearHistory()}
                        className="rounded-lg border border-white/15 bg-white/5 px-3 py-1.5 text-xs font-semibold text-stone-300 transition hover:border-white/30 hover:text-stone-100"
                      >
                        Clear decision history
                      </button>
                      <button
                        type="button"
                        onClick={() => void clearProfile()}
                        className="rounded-lg border border-rose-300/30 bg-rose-400/5 px-3 py-1.5 text-xs font-semibold text-rose-200 transition hover:border-rose-300/60"
                      >
                        Delete all preferences
                      </button>
                    </div>
                  </div>
                </>
              )}
            </div>
          ) : proposalsOpen ? (
            <div>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="text-base font-semibold text-stone-100">
                    Suggestions for you
                  </h2>
                  <p className="mt-1 text-xs text-stone-500">
                    Patterns Wisora noticed in your decisions. Nothing is
                    saved until you confirm it.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setProposalsOpen(false)}
                  className="rounded-md border border-white/15 bg-white/5 px-2.5 py-1 text-xs font-semibold text-stone-300 transition hover:border-white/30 hover:text-stone-100"
                >
                  Close
                </button>
              </div>
              {proposalsLoading ? (
                <p className="mt-4 text-sm text-stone-500">Loading…</p>
              ) : proposalsError ? (
                <p className="mt-4 rounded-lg border border-red-400/30 bg-red-500/10 p-3 text-sm text-red-200">
                  {proposalsError}
                </p>
              ) : proposals.length === 0 ? (
                <p className="mt-4 text-sm text-stone-400">
                  No suggestions right now. Save decisions, and use “Tell us
                  more” to mark picks you prefer or reject — Wisora will
                  propose matching preferences here for your approval.
                  Budget patterns take a couple of similar searches.
                </p>
              ) : (
                <ul className="mt-4 space-y-3">
                  {proposals.map((proposal) => {
                    const editable = editPrefill(proposal.patch);
                    const busy = decidingId === proposal.id;
                    return (
                      <li
                        key={proposal.id}
                        className="rounded-xl border border-white/10 bg-white/[0.03] p-4"
                      >
                        <p className="text-sm font-medium text-stone-100">
                          {proposal.reason}
                        </p>
                        <ul className="mt-1.5 space-y-0.5 text-sm text-stone-300">
                          {describeProposalPatch(proposal.patch).map((line) => (
                            <li key={line}>· {line}</li>
                          ))}
                        </ul>
                        <p className="mt-1.5 text-xs text-stone-500">
                          {proposal.kind === "category" && proposal.category
                            ? `${categoryLabel(proposal.category)} · `
                            : ""}
                          Based on {proposal.evidence.length} past decision
                          {proposal.evidence.length === 1 ? "" : "s"}
                        </p>
                        {editingId === proposal.id && editable ? (
                          <div className="mt-3">
                            <label className="block text-xs text-stone-400">
                              {editable.label}
                              <input
                                type="text"
                                value={editValue}
                                onChange={(event) =>
                                  setEditValue(event.target.value)
                                }
                                className="mt-1 w-full rounded-lg border border-white/10 bg-white/5 p-2.5 text-sm text-stone-100 placeholder:text-stone-500 focus:border-teal-300/60 focus:ring-2 focus:ring-teal-300/20 focus:outline-none"
                              />
                            </label>
                            <div className="mt-2 flex flex-wrap gap-2">
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() => confirmEdited(proposal)}
                                className="rounded-lg bg-white px-3 py-1.5 text-xs font-semibold text-stone-950 transition hover:bg-teal-200 disabled:cursor-not-allowed disabled:opacity-50"
                              >
                                {busy ? "Saving…" : "Save edited"}
                              </button>
                              <button
                                type="button"
                                onClick={() => setEditingId(null)}
                                className="rounded-lg border border-white/15 bg-white/5 px-3 py-1.5 text-xs font-semibold text-stone-300 transition hover:border-white/30 hover:text-stone-100"
                              >
                                Cancel
                              </button>
                            </div>
                          </div>
                        ) : (
                          <div className="mt-3 flex flex-wrap gap-2">
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() =>
                                void decideProposal(proposal.id, "confirmed")
                              }
                              className="rounded-lg bg-white px-3 py-1.5 text-xs font-semibold text-stone-950 transition hover:bg-teal-200 disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              {busy ? "Saving…" : "Confirm"}
                            </button>
                            {editable && (
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() => {
                                  setEditingId(proposal.id);
                                  setEditValue(editable.value);
                                  setProposalsError(null);
                                }}
                                className="rounded-lg border border-white/15 bg-white/5 px-3 py-1.5 text-xs font-semibold text-stone-300 transition hover:border-white/30 hover:text-stone-100"
                              >
                                Edit
                              </button>
                            )}
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() =>
                                void decideProposal(proposal.id, "rejected")
                              }
                              className="rounded-lg border border-white/15 bg-white/5 px-3 py-1.5 text-xs font-semibold text-stone-300 transition hover:border-white/30 hover:text-stone-100"
                            >
                              Dismiss
                            </button>
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
              {proposalsNotice && (
                <p className="mt-3 text-xs text-teal-200">{proposalsNotice}</p>
              )}
            </div>
          ) : watchesOpen ? (
            <div>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="text-base font-semibold text-stone-100">
                    Watchlist
                  </h2>
                  <p className="mt-1 text-xs text-stone-500">
                    Track prices toward a target. Checks run automatically
                    while the server runs — or tap Check now anytime.
                  </p>
                  {monitor && (
                    <p className="mt-1 text-xs text-stone-500">
                      {monitor.active
                        ? `Auto-checks on · every ${monitor.intervalMinutes} min`
                        : "Auto-checks off in this session"}
                      {" · "}
                      {monitor.emailConfigured
                        ? "email alerts on"
                        : "email alerts off"}
                    </p>
                  )}
                  {monitor?.lastRun && (
                    <p className="mt-1 text-xs text-stone-500">
                      Last check {formatRelative(monitor.lastRun.finishedAt, nowMs)} ·{" "}
                      {monitor.lastRun.checked} checked ·{" "}
                      {monitor.lastRun.opportunities} opportunit
                      {monitor.lastRun.opportunities === 1 ? "y" : "ies"} ·{" "}
                      {monitor.lastRun.remindersFired} reminder
                      {monitor.lastRun.remindersFired === 1 ? "" : "s"} fired ·{" "}
                      {monitor.lastRun.emails} emailed
                    </p>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => setWatchesOpen(false)}
                  className="rounded-md border border-white/15 bg-white/5 px-2.5 py-1 text-xs font-semibold text-stone-300 transition hover:border-white/30 hover:text-stone-100"
                >
                  Close
                </button>
              </div>
              {trackDraft && (
                <div className="mt-4 rounded-xl border border-teal-300/30 bg-teal-300/5 p-3">
                  <p
                    className="truncate text-sm font-medium text-stone-100"
                    title={trackDraft.title}
                  >
                    {trackDraft.title}
                  </p>
                  <p className="mt-0.5 text-xs text-stone-500">
                    {trackDraft.merchant}
                    {trackDraft.currentPrice != null
                      ? ` · now ${formatInr(trackDraft.currentPrice)}`
                      : ""}
                  </p>
                  <div className="mt-2 flex flex-wrap items-end gap-2">
                    <label className="block text-xs text-stone-400">
                      Target price (₹)
                      <input
                        type="text"
                        inputMode="decimal"
                        value={trackDraft.target}
                        onChange={(event) =>
                          setTrackDraft((prev) =>
                            prev
                              ? { ...prev, target: event.target.value }
                              : prev,
                          )
                        }
                        placeholder="e.g. 40000"
                        className="mt-1 w-32 rounded-lg border border-white/10 bg-white/5 p-2 text-sm text-stone-100 placeholder:text-stone-500 focus:border-teal-300/60 focus:ring-2 focus:ring-teal-300/20 focus:outline-none"
                      />
                    </label>
                    <label className="flex cursor-pointer items-center gap-1.5 pb-2 text-xs text-stone-400">
                      <input
                        type="checkbox"
                        checked={trackDraft.canWait}
                        onChange={() =>
                          setTrackDraft((prev) =>
                            prev ? { ...prev, canWait: !prev.canWait } : prev,
                          )
                        }
                        className="h-4 w-4 accent-teal-300"
                      />
                      I can wait
                    </label>
                    <button
                      type="button"
                      onClick={() => void createWatch()}
                      disabled={creatingWatch}
                      className="rounded-lg bg-white px-3 py-1.5 text-xs font-semibold text-stone-950 transition hover:bg-teal-200 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {creatingWatch ? "Tracking…" : "Track"}
                    </button>
                    <button
                      type="button"
                      onClick={() => setTrackDraft(null)}
                      className="rounded-lg border border-white/15 bg-white/5 px-3 py-1.5 text-xs font-semibold text-stone-300 transition hover:border-white/30 hover:text-stone-100"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
              {watchesLoading ? (
                <p className="mt-4 text-sm text-stone-500">Loading…</p>
              ) : watchesError ? (
                <p className="mt-4 rounded-lg border border-red-400/30 bg-red-500/10 p-3 text-sm text-red-200">
                  {watchesError}
                </p>
              ) : enrichedWatches.length === 0 ? (
                <p className="mt-4 text-sm text-stone-400">
                  Nothing tracked yet. Tap “Track price” on any product card
                  to watch it here.
                </p>
              ) : (
                <ul className="mt-4 space-y-3">
                  {enrichedWatches.map((entry) => {
                    const chip = watchStatusChip(entry);
                    const busy = checkingId === entry.watch.id;
                    return (
                      <li
                        key={entry.watch.id}
                        className="rounded-xl border border-white/10 bg-white/[0.03] p-3"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <a
                              href={entry.watch.url}
                              target="_blank"
                              rel="noreferrer"
                              title={entry.watch.title}
                              className="block truncate text-sm font-medium text-stone-100 hover:text-teal-200 hover:underline"
                            >
                              {entry.watch.title}
                            </a>
                            <p className="mt-0.5 text-xs text-stone-500">
                              {entry.watch.merchant} · target{" "}
                              {formatInr(entry.watch.targetPrice)}
                              {entry.latest
                                ? ` · now ${formatInr(entry.latest.priceInr)}`
                                : " · no data yet"}
                            </p>
                            {entry.stats.count >= 2 &&
                              entry.stats.min &&
                              entry.stats.max && (
                                <p className="mt-0.5 text-xs text-stone-500">
                                  Low {formatInr(entry.stats.min.priceInr)} ·
                                  high {formatInr(entry.stats.max.priceInr)} ·{" "}
                                  {entry.stats.count} checks in{" "}
                                  {entry.stats.windowDays}d
                                </p>
                              )}
                            {entry.watch.lastCheck && (
                              <p className="mt-0.5 text-xs text-stone-500">
                                Last checked{" "}
                                {formatSavedDate(entry.watch.lastCheck.at)}
                                {entry.watch.lastCheck.status !== "ok" &&
                                entry.watch.lastCheck.error
                                  ? ` · ${entry.watch.lastCheck.error}`
                                  : ""}
                              </p>
                            )}
                          </div>
                          <div className="flex shrink-0 flex-col items-end gap-1">
                            <span className={chip.className}>{chip.label}</span>
                            {entry.unreadAlerts > 0 && (
                              <span className="rounded-full bg-teal-300 px-1.5 py-px text-[10px] font-semibold text-teal-950">
                                {entry.unreadAlerts} new
                              </span>
                            )}
                          </div>
                        </div>
                        {editingWatchId === entry.watch.id ? (
                          <div className="mt-2 flex flex-wrap items-end gap-2">
                            <label className="block text-xs text-stone-400">
                              Target price (₹)
                              <input
                                type="text"
                                inputMode="decimal"
                                value={editTarget}
                                onChange={(event) =>
                                  setEditTarget(event.target.value)
                                }
                                className="mt-1 w-32 rounded-lg border border-white/10 bg-white/5 p-2 text-sm text-stone-100 placeholder:text-stone-500 focus:border-teal-300/60 focus:ring-2 focus:ring-teal-300/20 focus:outline-none"
                              />
                            </label>
                            <button
                              type="button"
                              onClick={() => void saveWatchTarget(entry.watch.id)}
                              className="rounded-lg bg-white px-3 py-1.5 text-xs font-semibold text-stone-950 transition hover:bg-teal-200"
                            >
                              Save
                            </button>
                            <button
                              type="button"
                              onClick={() => setEditingWatchId(null)}
                              className="rounded-lg border border-white/15 bg-white/5 px-3 py-1.5 text-xs font-semibold text-stone-300 transition hover:border-white/30 hover:text-stone-100"
                            >
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <div className="mt-2 flex flex-wrap gap-2">
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => void checkWatchNow(entry.watch.id)}
                              className="rounded-lg bg-white px-3 py-1.5 text-xs font-semibold text-stone-950 transition hover:bg-teal-200 disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              {busy ? "Checking…" : "Check now"}
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setEditingWatchId(entry.watch.id);
                                setEditTarget(String(entry.watch.targetPrice));
                                setWatchesError(null);
                              }}
                              className="rounded-lg border border-white/15 bg-white/5 px-3 py-1.5 text-xs font-semibold text-stone-300 transition hover:border-white/30 hover:text-stone-100"
                            >
                              Edit target
                            </button>
                            <button
                              type="button"
                              onClick={() => void toggleWatchActive(entry)}
                              className="rounded-lg border border-white/15 bg-white/5 px-3 py-1.5 text-xs font-semibold text-stone-300 transition hover:border-white/30 hover:text-stone-100"
                            >
                              {entry.watch.active ? "Pause" : "Resume"}
                            </button>
                            <button
                              type="button"
                              onClick={() => void removeWatch(entry.watch.id)}
                              className="rounded-lg border border-white/15 bg-white/5 px-3 py-1.5 text-xs font-semibold text-stone-300 transition hover:border-white/30 hover:text-stone-100"
                            >
                              Remove
                            </button>
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
              {watchesNotice && (
                <p className="mt-3 text-xs text-teal-200">{watchesNotice}</p>
              )}
              <div className="mt-6 border-t border-white/10 pt-4">
                <div className="flex items-center justify-between gap-3">
                  <h3 className="text-sm font-semibold text-stone-200">
                    Alerts
                  </h3>
                  {unreadAlerts > 0 && (
                    <button
                      type="button"
                      onClick={() => void markAllAlertsRead()}
                      className="text-xs text-stone-500 hover:text-stone-200 hover:underline"
                    >
                      Mark all read
                    </button>
                  )}
                </div>
                {alerts.length === 0 ? (
                  <p className="mt-2 text-xs text-stone-500">
                    No alerts yet. You&apos;ll be notified here (and by email,
                    if configured) when a target is met.
                  </p>
                ) : (
                  <ul className="mt-2 space-y-2">
                    {alerts.map((alert) => (
                      <li
                        key={alert.id}
                        className={
                          alert.read
                            ? "rounded-xl border border-white/10 bg-white/[0.02] p-3"
                            : "rounded-xl border border-teal-300/30 bg-teal-300/5 p-3"
                        }
                      >
                        <a
                          href={alert.url}
                          target="_blank"
                          rel="noreferrer"
                          title={alert.title}
                          className="block truncate text-sm font-medium text-stone-100 hover:text-teal-200 hover:underline"
                        >
                          {alert.title}
                        </a>
                        <p className="mt-0.5 text-xs text-stone-400">
                          {formatInr(alert.observedPrice)} · target{" "}
                          {formatInr(alert.targetPrice)} ·{" "}
                          {formatSavedDate(alert.observedAt)}
                        </p>
                        <p className="mt-0.5 text-xs text-stone-500">
                          {alert.email?.sent
                            ? "Emailed ✓"
                            : alert.email?.attempted
                              ? `Email failed${alert.email.error ? `: ${alert.email.error}` : ""}`
                              : "In-app only"}
                        </p>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div className="mt-6">
                <h3 className="text-sm font-semibold text-stone-200">
                  Notifications
                </h3>
                <p className="mt-1 text-xs text-stone-500">
                  Control proactive cards and alert emails. Changes apply to
                  new events.
                </p>
                {settings ? (
                  <div className="mt-2 space-y-2">
                    <label className="flex cursor-pointer items-center gap-2 text-sm text-stone-300">
                      <input
                        type="checkbox"
                        checked={settings.proactiveEnabled}
                        disabled={settingsSaving}
                        onChange={(event) =>
                          void saveSettings({
                            proactiveEnabled: event.target.checked,
                          })
                        }
                        className="h-4 w-4 accent-teal-300"
                      />
                      Proactive opportunities
                    </label>
                    <label className="flex cursor-pointer items-center gap-2 text-sm text-stone-300">
                      <input
                        type="checkbox"
                        checked={settings.priceEmails}
                        disabled={settingsSaving}
                        onChange={(event) =>
                          void saveSettings({
                            priceEmails: event.target.checked,
                          })
                        }
                        className="h-4 w-4 accent-teal-300"
                      />
                      Price alert emails
                    </label>
                    <label className="flex cursor-pointer items-center gap-2 text-sm text-stone-300">
                      <input
                        type="checkbox"
                        checked={settings.availabilityEmails}
                        disabled={settingsSaving}
                        onChange={(event) =>
                          void saveSettings({
                            availabilityEmails: event.target.checked,
                          })
                        }
                        className="h-4 w-4 accent-teal-300"
                      />
                      Availability emails
                    </label>
                    <label className="flex cursor-pointer items-center gap-2 text-sm text-stone-300">
                      <input
                        type="checkbox"
                        checked={settings.reminderEmails}
                        disabled={settingsSaving}
                        onChange={(event) =>
                          void saveSettings({
                            reminderEmails: event.target.checked,
                          })
                        }
                        className="h-4 w-4 accent-teal-300"
                      />
                      Reminder emails
                    </label>
                    <p className="text-xs text-stone-400">
                      Every trigger sends an email while its type stays on.
                    </p>
                    {settingsNotice && (
                      <p className="text-xs text-teal-300">{settingsNotice}</p>
                    )}
                  </div>
                ) : (
                  <p className="mt-2 text-xs text-stone-500">Loading…</p>
                )}
              </div>
            </div>
          ) : remindersOpen ? (
            <div>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="text-base font-semibold text-stone-100">
                    Reminders
                  </h2>
                  <p className="mt-1 text-xs text-stone-500">
                    One-time nudges to revisit a decision. A reminder never
                    predicts a price — it just brings you back.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setRemindersOpen(false)}
                  className="rounded-md border border-white/15 bg-white/5 px-2.5 py-1 text-xs font-semibold text-stone-300 transition hover:border-white/30 hover:text-stone-100"
                >
                  Close
                </button>
              </div>
              {remindersNotice && (
                <p className="mt-3 text-sm text-teal-300">{remindersNotice}</p>
              )}
              {remindersError && (
                <p className="mt-3 rounded-lg border border-red-400/30 bg-red-500/10 p-3 text-sm text-red-200">
                  {remindersError}
                </p>
              )}
              {!reminderDraft && (
                <button
                  type="button"
                  onClick={() => openReminders({})}
                  className="mt-3 rounded-lg border border-white/15 bg-white/5 px-3 py-1.5 text-xs font-semibold text-stone-200 transition hover:border-teal-300/40 hover:text-teal-200"
                >
                  + New reminder
                </button>
              )}
              {reminderDraft && (
                <div className="mt-3 space-y-2 rounded-xl border border-white/10 bg-white/[0.03] p-3">
                  <p className="text-xs font-semibold text-stone-300">
                    {reminderDraft.id ? "Edit reminder" : "New reminder"}
                  </p>
                  {reminderDraft.merchant && (
                    <p className="truncate text-xs text-stone-500">
                      {reminderDraft.merchant}
                      {reminderDraft.url ? " · linked product" : ""}
                    </p>
                  )}
                  <label className="block text-xs text-stone-400">
                    Title
                    <input
                      type="text"
                      value={reminderDraft.title}
                      onChange={(event) =>
                        setReminderDraft((prev) =>
                          prev
                            ? { ...prev, title: event.target.value }
                            : prev,
                        )
                      }
                      placeholder="e.g. Revisit the laptop shortlist"
                      className="mt-1 w-full rounded-lg border border-white/10 bg-white/5 p-2 text-sm text-stone-100 placeholder:text-stone-500 focus:border-teal-300/60 focus:ring-2 focus:ring-teal-300/20 focus:outline-none"
                    />
                  </label>
                  <div className="flex flex-wrap gap-2">
                    <label className="block flex-1 text-xs text-stone-400">
                      Date &amp; time
                      <input
                        type="datetime-local"
                        value={reminderDraft.remindAtLocal}
                        onChange={(event) =>
                          setReminderDraft((prev) =>
                            prev
                              ? { ...prev, remindAtLocal: event.target.value }
                              : prev,
                          )
                        }
                        className="mt-1 w-full rounded-lg border border-white/10 bg-white/5 p-2 text-sm text-stone-100 focus:border-teal-300/60 focus:ring-2 focus:ring-teal-300/20 focus:outline-none"
                      />
                    </label>
                    <label className="block w-36 text-xs text-stone-400">
                      Timezone
                      <input
                        type="text"
                        value={reminderDraft.timezone}
                        onChange={(event) =>
                          setReminderDraft((prev) =>
                            prev
                              ? { ...prev, timezone: event.target.value }
                              : prev,
                          )
                        }
                        placeholder="Asia/Kolkata"
                        className="mt-1 w-full rounded-lg border border-white/10 bg-white/5 p-2 text-sm text-stone-100 placeholder:text-stone-500 focus:border-teal-300/60 focus:ring-2 focus:ring-teal-300/20 focus:outline-none"
                      />
                    </label>
                  </div>
                  <label className="block text-xs text-stone-400">
                    Note (optional)
                    <input
                      type="text"
                      value={reminderDraft.note}
                      onChange={(event) =>
                        setReminderDraft((prev) =>
                          prev ? { ...prev, note: event.target.value } : prev,
                        )
                      }
                      placeholder="Why revisit?"
                      className="mt-1 w-full rounded-lg border border-white/10 bg-white/5 p-2 text-sm text-stone-100 placeholder:text-stone-500 focus:border-teal-300/60 focus:ring-2 focus:ring-teal-300/20 focus:outline-none"
                    />
                  </label>
                  <label className="block text-xs text-stone-400">
                    Also fire at or below ₹ (optional)
                    <input
                      type="text"
                      inputMode="decimal"
                      value={reminderDraft.targetPrice}
                      onChange={(event) =>
                        setReminderDraft((prev) =>
                          prev
                            ? { ...prev, targetPrice: event.target.value }
                            : prev,
                        )
                      }
                      placeholder="e.g. 65000"
                      className="mt-1 w-32 rounded-lg border border-white/10 bg-white/5 p-2 text-sm text-stone-100 placeholder:text-stone-500 focus:border-teal-300/60 focus:ring-2 focus:ring-teal-300/20 focus:outline-none"
                    />
                  </label>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => void saveReminderDraft()}
                      disabled={savingReminder}
                      className="rounded-lg bg-white px-4 py-1.5 text-xs font-semibold text-stone-950 transition hover:bg-teal-200 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {savingReminder
                        ? "Saving…"
                        : reminderDraft.id
                          ? "Save changes"
                          : "Save reminder"}
                    </button>
                    <button
                      type="button"
                      onClick={() => setReminderDraft(null)}
                      className="rounded-lg border border-white/15 bg-white/5 px-4 py-1.5 text-xs font-semibold text-stone-300 transition hover:border-white/30 hover:text-stone-100"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
              <div className="mt-4">
                <h3 className="text-sm font-semibold text-stone-200">
                  Upcoming
                </h3>
                {remindersLoading ? (
                  <p className="mt-2 text-xs text-stone-500">Loading…</p>
                ) : (
                  (() => {
                    const upcoming = reminders
                      .filter((entry) => entry.status !== "done")
                      .sort((a, b) =>
                        a.remindAt < b.remindAt
                          ? -1
                          : a.remindAt > b.remindAt
                            ? 1
                            : 0,
                      );
                    if (upcoming.length === 0) {
                      return (
                        <p className="mt-2 text-xs text-stone-500">
                          No upcoming reminders. Create one above, or tap
                          “Remind me” on any opportunity.
                        </p>
                      );
                    }
                    return (
                      <ul className="mt-2 space-y-2">
                        {upcoming.map((entry) => (
                          <li
                            key={entry.id}
                            className="rounded-xl border border-white/10 bg-white/[0.02] p-3"
                          >
                            <p className="text-sm font-medium text-stone-100">
                              {entry.title}
                            </p>
                            <p className="mt-0.5 text-xs text-stone-500">
                              {formatSavedDate(entry.remindAt)}
                              {entry.targetPriceInr != null
                                ? ` · fires at ${formatInr(entry.targetPriceInr)} or below`
                                : ""}
                              {entry.status === "disabled" ? " · paused" : ""}
                            </p>
                            {entry.note && (
                              <p className="mt-0.5 text-xs text-stone-400">
                                {entry.note}
                              </p>
                            )}
                            <div className="mt-1.5 flex flex-wrap gap-2">
                              <button
                                type="button"
                                onClick={() => startReminderEdit(entry)}
                                className="text-xs text-stone-500 hover:text-stone-200 hover:underline"
                              >
                                Edit
                              </button>
                              <button
                                type="button"
                                onClick={() =>
                                  void setReminderStatus(
                                    entry.id,
                                    entry.status === "disabled"
                                      ? "active"
                                      : "disabled",
                                  )
                                }
                                className="text-xs text-stone-500 hover:text-stone-200 hover:underline"
                              >
                                {entry.status === "disabled"
                                  ? "Resume"
                                  : "Pause"}
                              </button>
                              <button
                                type="button"
                                onClick={() => void deleteReminderById(entry.id)}
                                className="text-xs text-stone-500 hover:text-rose-300 hover:underline"
                              >
                                Delete
                              </button>
                            </div>
                          </li>
                        ))}
                      </ul>
                    );
                  })()
                )}
              </div>
              {reminders.some((entry) => entry.status === "done") && (
                <div className="mt-4">
                  <h3 className="text-sm font-semibold text-stone-200">
                    Completed
                  </h3>
                  <ul className="mt-2 space-y-2">
                    {reminders
                      .filter((entry) => entry.status === "done")
                      .map((entry) => (
                        <li
                          key={entry.id}
                          className="rounded-xl border border-white/10 bg-white/[0.02] p-3 opacity-70"
                        >
                          <p className="text-sm text-stone-300">
                            {entry.title}
                          </p>
                          <p className="mt-0.5 text-xs text-stone-500">
                            Fired{" "}
                            {entry.firedAt
                              ? formatRelative(entry.firedAt, nowMs)
                              : ""}
                            {entry.firedBecause === "target"
                              ? " · target met"
                              : ""}
                          </p>
                          <div className="mt-1.5 flex flex-wrap gap-2">
                            <button
                              type="button"
                              onClick={() =>
                                void setReminderStatus(entry.id, "active")
                              }
                              className="text-xs text-stone-500 hover:text-stone-200 hover:underline"
                            >
                              Re-activate
                            </button>
                            <button
                              type="button"
                              onClick={() => void deleteReminderById(entry.id)}
                              className="text-xs text-stone-500 hover:text-rose-300 hover:underline"
                            >
                              Delete
                            </button>
                          </div>
                        </li>
                      ))}
                  </ul>
                </div>
              )}
            </div>
          ) : oppsOpen ? (
            <div>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="text-base font-semibold text-stone-100">
                    Opportunities for you
                  </h2>
                  <p className="mt-1 text-xs text-stone-500">
                    Target hits, price moves, and restocks on tracked
                    products.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setOppsOpen(false)}
                  className="rounded-md border border-white/15 bg-white/5 px-2.5 py-1 text-xs font-semibold text-stone-300 transition hover:border-white/30 hover:text-stone-100"
                >
                  Close
                </button>
              </div>
              <div
                className="mt-3 flex items-center gap-1"
                role="group"
                aria-label="Opportunity status"
              >
                {(["active", "read", "dismissed"] as const).map((tab) => (
                  <button
                    key={tab}
                    type="button"
                    onClick={() => {
                      setOppTab(tab);
                      void loadOpportunities(tab, oppCategory);
                    }}
                    aria-pressed={oppTab === tab}
                    className={
                      oppTab === tab
                        ? "rounded-full border border-teal-300/60 bg-teal-300/15 px-3 py-1 text-xs font-semibold text-teal-200 capitalize"
                        : "rounded-full border border-white/15 bg-white/5 px-3 py-1 text-xs text-stone-400 capitalize transition hover:border-teal-300/40 hover:text-teal-200"
                    }
                  >
                    {tab === "active" && activeOpps.length > 0
                      ? `Active (${activeOpps.length})`
                      : tab}
                  </button>
                ))}
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <label className="text-xs text-stone-500">
                  Category{" "}
                  <select
                    value={oppCategory}
                    onChange={(event) => {
                      const next = event.target.value as "" | Category;
                      setOppCategory(next);
                      void loadOpportunities(oppTab, next);
                    }}
                    className="ml-1 rounded-lg border border-white/10 bg-stone-950 p-1.5 text-xs text-stone-200 focus:border-teal-300/60 focus:outline-none"
                  >
                    <option value="">All</option>
                    {CATEGORIES.map((entry) => (
                      <option key={entry.id} value={entry.id}>
                        {entry.label}
                      </option>
                    ))}
                  </select>
                </label>
                {oppTab === "active" && opportunities.length > 0 && (
                  <button
                    type="button"
                    onClick={() => void markAllOppRead()}
                    className="ml-auto text-xs text-stone-500 hover:text-stone-200 hover:underline"
                  >
                    Mark all read
                  </button>
                )}
              </div>
              {oppNotice && (
                <p className="mt-3 text-sm text-teal-300">{oppNotice}</p>
              )}
              {oppError && (
                <p className="mt-3 rounded-lg border border-red-400/30 bg-red-500/10 p-3 text-sm text-red-200">
                  {oppError}{" "}
                  <button
                    type="button"
                    onClick={() => void loadOpportunities(oppTab, oppCategory)}
                    className="underline hover:text-red-100"
                  >
                    Retry
                  </button>
                </p>
              )}
              {oppLoading ? (
                <p className="mt-3 text-sm text-stone-500">Loading…</p>
              ) : opportunities.length === 0 ? (
                <div className="mt-3 rounded-xl border border-white/10 bg-white/[0.02] p-4">
                  <p className="text-sm text-stone-300">
                    {oppTab === "active"
                      ? "No opportunities right now."
                      : oppTab === "read"
                        ? "Nothing marked read yet."
                        : "Nothing dismissed."}
                  </p>
                  {oppTab === "active" && (
                    <p className="mt-1 text-xs text-stone-500">
                      Track products from the Watchlist and Wisora will flag
                      target hits, big price moves, and restocks here.
                    </p>
                  )}
                </div>
              ) : (
                <ul className="mt-3 space-y-3">
                  {opportunities.map((opp) => {
                    const stale = isStaleEvidence(
                      opp.evidence.observedAt,
                      nowMs,
                    );
                    const expanded = expandedOppId === opp.id;
                    return (
                      <li
                        key={opp.id}
                        className="rounded-xl border border-white/10 bg-white/[0.02] p-4"
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <span
                            className={`rounded-full border px-2.5 py-0.5 text-xs font-semibold ${oppKindChip(opp.kind)}`}
                          >
                            {OPP_KIND_LABELS[opp.kind]}
                          </span>
                          {opp.category && (
                            <span className="text-xs text-stone-500">
                              {categoryLabel(opp.category)}
                            </span>
                          )}
                          <span className="ml-auto text-xs text-stone-500">
                            {formatRelative(opp.evidence.observedAt, nowMs)}
                          </span>
                        </div>
                        <a
                          href={opp.url}
                          target="_blank"
                          rel="noreferrer"
                          title={opp.title}
                          className="mt-1.5 block truncate font-medium text-stone-50 hover:text-teal-200 hover:underline"
                        >
                          {opp.title}
                        </a>
                        <p className="text-xs text-stone-500">{opp.merchant}</p>
                        {(opp.currentPriceInr != null ||
                          opp.targetPriceInr != null) && (
                          <p className="mt-1 text-sm text-stone-200">
                            {opp.currentPriceInr != null && (
                              <span className="font-semibold">
                                {formatInr(opp.currentPriceInr)}
                              </span>
                            )}
                            {opp.previousPriceInr != null && (
                              <span className="ml-2 text-xs text-stone-500 line-through">
                                {formatInr(opp.previousPriceInr)}
                              </span>
                            )}
                            {opp.targetPriceInr != null && (
                              <span className="ml-2 text-xs text-stone-400">
                                target {formatInr(opp.targetPriceInr)}
                              </span>
                            )}
                          </p>
                        )}
                        <p className="mt-1 text-sm leading-relaxed text-stone-300">
                          {opp.reason}
                        </p>
                        {opp.decisionContext && (
                          <p className="mt-1 text-xs text-stone-400">
                            {opp.decisionContext} Re-check to see if it still
                            holds.
                          </p>
                        )}
                        {opp.email?.sent && (
                          <p className="mt-0.5 text-xs text-stone-500">
                            Emailed ✓
                          </p>
                        )}
                        {opp.email?.attempted && !opp.email.sent && (
                          <p className="mt-0.5 text-xs text-stone-500">
                            Email failed
                            {opp.email.error ? `: ${opp.email.error}` : ""}
                          </p>
                        )}
                        {stale && (
                          <p className="mt-1 text-xs text-amber-200/80">
                            Evidence is over a week old — re-check before
                            acting.
                          </p>
                        )}
                        {opp.relevance && opp.relevance.reasons.length > 0 && (
                          <div className="mt-1.5">
                            <button
                              type="button"
                              onClick={() =>
                                setExpandedOppId(expanded ? null : opp.id)
                              }
                              aria-expanded={expanded}
                              className="text-xs text-stone-500 hover:text-stone-200 hover:underline"
                            >
                              {expanded ? "Hide why this" : "Why this?"}
                            </button>
                            {expanded && (
                              <ul className="mt-1 space-y-0.5 text-xs text-stone-400">
                                {opp.relevance.reasons.map((reason) => (
                                  <li key={reason}>• {reason}</li>
                                ))}
                              </ul>
                            )}
                          </div>
                        )}
                        <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
                          <a
                            href={opp.url}
                            target="_blank"
                            rel="noreferrer"
                            className="text-xs font-medium text-teal-300 hover:underline"
                          >
                            Open listing →
                          </a>
                          {opp.watchId && (
                            <button
                              type="button"
                              onClick={() => void reevaluateOpp(opp.id)}
                              disabled={reevaluatingId === opp.id}
                              className="text-xs font-medium text-stone-400 hover:text-stone-200 hover:underline disabled:opacity-50"
                            >
                              {reevaluatingId === opp.id
                                ? "Re-checking…"
                                : "Re-check now"}
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => remindAboutOpportunity(opp)}
                            className="text-xs font-medium text-stone-400 hover:text-stone-200 hover:underline"
                          >
                            Remind me
                          </button>
                          <button
                            type="button"
                            onClick={() => askAboutOpportunity(opp)}
                            className="text-xs font-medium text-stone-400 hover:text-stone-200 hover:underline"
                          >
                            Ask about this
                          </button>
                          {opp.status === "active" && (
                            <button
                              type="button"
                              onClick={() => void markOppRead(opp.id)}
                              className="text-xs text-stone-500 hover:text-stone-200 hover:underline"
                            >
                              Mark read
                            </button>
                          )}
                          {opp.status !== "dismissed" && (
                            <button
                              type="button"
                              onClick={() => void dismissOpp(opp.id)}
                              className="text-xs text-stone-500 hover:text-rose-300 hover:underline"
                            >
                              Dismiss
                            </button>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          ) : (
            <div className="flex h-full flex-col">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="text-base font-semibold text-stone-100">
                    Chat with Wisora
                  </h2>
                  <p className="mt-1 text-xs text-stone-500">
                    Follow-ups about tracked products, prices, and past
                    decisions — answered from your saved data.
                  </p>
                </div>
                <div className="flex gap-2">
                  {chatThread && (
                    <button
                      type="button"
                      onClick={() => {
                        setChatThread(null);
                        setChatInput("");
                        setChatProduct(null);
                      }}
                      className="rounded-md border border-white/15 bg-white/5 px-2.5 py-1 text-xs font-semibold text-stone-300 transition hover:border-white/30 hover:text-stone-100"
                    >
                      New chat
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setChatOpen(false)}
                    className="rounded-md border border-white/15 bg-white/5 px-2.5 py-1 text-xs font-semibold text-stone-300 transition hover:border-white/30 hover:text-stone-100"
                  >
                    Close
                  </button>
                </div>
              </div>
              {chatError && (
                <p className="mt-3 rounded-lg border border-red-400/30 bg-red-500/10 p-3 text-sm text-red-200">
                  {chatError}
                </p>
              )}
              {chatThread ? (
                <>
                  <button
                    type="button"
                    onClick={() => {
                      setChatThread(null);
                      setChatProduct(null);
                    }}
                    className="mt-2 self-start text-xs text-stone-500 hover:text-stone-200 hover:underline"
                  >
                    ← All conversations
                  </button>
                  <div
                    className="mt-2 flex-1 space-y-3 overflow-y-auto"
                    aria-live="polite"
                  >
                    {chatThread.messages.map((message) => (
                      <div
                        key={message.id}
                        className={
                          message.role === "user"
                            ? "ml-8 rounded-xl border border-teal-300/25 bg-teal-300/5 p-3"
                            : "mr-8 rounded-xl border border-white/10 bg-white/[0.02] p-3"
                        }
                      >
                        <p className="text-sm leading-relaxed break-words whitespace-pre-wrap text-stone-200">
                          {message.text}
                        </p>
                        {message.sources && message.sources.length > 0 && (
                          <div className="mt-1.5 flex flex-wrap gap-2">
                            {message.sources.map((source) =>
                              source.url ? (
                                <a
                                  key={source.label}
                                  href={source.url}
                                  target="_blank"
                                  rel="noreferrer"
                                  title={source.label}
                                  className="max-w-full truncate text-xs text-teal-300 hover:underline"
                                >
                                  {source.label} →
                                </a>
                              ) : (
                                <span
                                  key={source.label}
                                  className="text-xs text-stone-500"
                                >
                                  {source.label}
                                </span>
                              ),
                            )}
                          </div>
                        )}
                      </div>
                    ))}
                    {chatSending && (
                      <p className="text-xs text-stone-500">Thinking…</p>
                    )}
                    <div ref={chatEndRef} />
                  </div>
                </>
              ) : (
                <div className="mt-3 flex-1 overflow-y-auto">
                  {chatLoading ? (
                    <p className="text-xs text-stone-500">Loading…</p>
                  ) : chatThreads.length === 0 ? (
                    <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
                      <p className="text-sm text-stone-300">
                        No conversations yet.
                      </p>
                      <p className="mt-1 text-xs text-stone-500">
                        Try “What am I tracking?”, “Is the Lenovo still a good
                        deal?”, or “Compare my shortlist”.
                      </p>
                    </div>
                  ) : (
                    <ul className="space-y-2">
                      {chatThreads.map((thread) => (
                        <li
                          key={thread.id}
                          className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.02] p-3"
                        >
                          <button
                            type="button"
                            onClick={() => {
                              setChatThread(thread);
                              setChatProduct(null);
                            }}
                            className="min-w-0 flex-1 text-left"
                          >
                            <span className="block truncate text-sm font-medium text-stone-100 hover:text-teal-200">
                              {thread.title}
                            </span>
                            <span className="text-xs text-stone-500">
                              {thread.messages.length} message
                              {thread.messages.length === 1 ? "" : "s"} ·{" "}
                              {formatRelative(thread.updatedAt, nowMs)}
                            </span>
                          </button>
                          <button
                            type="button"
                            onClick={() => void deleteChatThreadById(thread.id)}
                            aria-label={`Delete ${thread.title}`}
                            className="shrink-0 text-xs text-stone-500 hover:text-rose-300 hover:underline"
                          >
                            Delete
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
              {chatProduct && (
                <div className="mt-2 flex items-center gap-2">
                  <span
                    title={chatProduct.title}
                    className="max-w-full truncate rounded-full border border-teal-300/30 bg-teal-300/10 px-2.5 py-0.5 text-xs text-teal-200"
                  >
                    About: {chatProduct.title}
                  </span>
                  <button
                    type="button"
                    onClick={() => setChatProduct(null)}
                    className="shrink-0 text-xs text-stone-500 hover:text-stone-200 hover:underline"
                  >
                    Clear
                  </button>
                </div>
              )}
              <form
                className="mt-2 flex gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  void sendChat();
                }}
              >
                <input
                  type="text"
                  value={chatInput}
                  onChange={(event) => setChatInput(event.target.value)}
                  placeholder="Ask about your tracked products…"
                  aria-label="Chat message"
                  maxLength={2000}
                  className="min-w-0 flex-1 rounded-lg border border-white/10 bg-white/5 p-2.5 text-sm text-stone-100 placeholder:text-stone-500 focus:border-teal-300/60 focus:ring-2 focus:ring-teal-300/20 focus:outline-none"
                />
                <button
                  type="submit"
                  disabled={chatSending || chatInput.trim().length === 0}
                  className="shrink-0 rounded-lg bg-white px-4 py-2 text-sm font-semibold text-stone-950 transition hover:bg-teal-200 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {chatSending ? "…" : "Send"}
                </button>
              </form>
            </div>
          )}
        </section>
      )}

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
            {user && historyEntries.length > 0 && (
              <button
                type="button"
                onClick={() => setHistoryOpen((open) => !open)}
                aria-expanded={historyOpen}
                className="rounded-lg border border-white/15 bg-white/5 px-4 py-2.5 text-sm font-semibold text-stone-200 backdrop-blur transition hover:border-teal-300/50 hover:text-teal-200"
              >
                History ({historyEntries.length})
              </button>
            )}
            <span className="text-xs text-stone-500">
              Search runs against live sources only — no mock data.
            </span>
          </div>
        </form>

        {user && historyOpen && historyEntries.length > 0 && (
          <section
            aria-label="Previous searches"
            className="glass mt-4 rounded-2xl p-5"
          >
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-base font-semibold text-stone-100">
                Previous searches
              </h2>
              <button
                type="button"
                onClick={deleteAllHistory}
                className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-medium text-stone-300 transition hover:border-white/20 hover:text-stone-100"
              >
                Clear all
              </button>
            </div>
            <ul className="mt-3 space-y-2">
              {historyEntries.map((entry) => (
                <li
                  key={entry.id}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm"
                >
                  <button
                    type="button"
                    onClick={() => restoreHistory(entry)}
                    title="Restore this search and its results"
                    className="min-w-0 flex-1 truncate text-left font-medium text-stone-100 hover:text-teal-200"
                  >
                    {entry.query}
                  </button>
                  {entry.verdict && (
                    <span className="rounded-full border border-teal-300/25 bg-teal-300/10 px-2 py-0.5 text-xs font-semibold text-teal-200">
                      {entry.verdict}
                    </span>
                  )}
                  {entry.topPick && (
                    <span className="w-full truncate text-xs text-stone-400">
                      Top pick: {entry.topPick}
                    </span>
                  )}
                  <span className="text-xs text-stone-500">
                    {formatSavedDate(entry.savedAt)}
                  </span>
                  <button
                    type="button"
                    onClick={() => deleteHistoryEntry(entry.id)}
                    aria-label={`Remove "${entry.query}" from history`}
                    className="rounded-md border border-white/10 bg-white/5 px-2 py-1 text-xs font-medium text-stone-400 transition hover:border-white/20 hover:text-stone-100"
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
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
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-base font-semibold text-stone-100">
                What we understood
              </h2>
              <button
                type="button"
                onClick={clearResults}
                className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-medium text-stone-300 transition hover:border-white/20 hover:text-stone-100"
              >
                Clear results
              </button>
            </div>
            <dl className="mt-3 space-y-2 text-sm">
              <div className="flex flex-wrap gap-2">
                <dt className="font-medium text-stone-300">Category:</dt>
                <dd>
                  <span className="rounded-full border border-teal-300/25 bg-teal-300/10 px-2.5 py-0.5 font-semibold text-teal-200">
                    {categoryLabel(result.intent.category)}
                  </span>{" "}
                  <span className="text-xs text-stone-500">
                    ({result.intent.categoryConfidence} confidence
                    {result.llmUsed ? ", interpreted with Muse" : ", rule-based"})
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

            <div className="mt-4">
              {reqsLoading && (
                <p className="text-sm text-stone-500">
                  Understanding requirements…
                </p>
              )}
              {reqsError && !reqs && (
                <div className="mt-2 flex flex-wrap items-center gap-3 rounded-xl border border-amber-300/25 bg-amber-400/5 p-3">
                  <p className="text-sm text-amber-200">{reqsError}</p>
                  <button
                    type="button"
                    onClick={() => void retryRequirements()}
                    disabled={reqsLoading}
                    className="rounded-lg bg-white px-4 py-1.5 text-sm font-semibold text-stone-950 transition hover:bg-amber-200 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Retry
                  </button>
                </div>
              )}
              {reqs &&
                (reqs.requirements.useContext != null ||
                  reqs.requirements.must.length > 0 ||
                  reqs.requirements.want.length > 0 ||
                  reqs.requirements.exclude.length > 0) && (
                  <div>
                    <h3 className="text-sm font-medium text-stone-200">
                      Requirements
                    </h3>
                    {reqs.requirements.useContext && (
                      <p className="mt-1 text-sm text-stone-400">
                        Use: {reqs.requirements.useContext}
                      </p>
                    )}
                    <ul className="mt-2 flex flex-wrap gap-1.5 text-xs">
                      {reqs.requirements.must.map((r) => (
                        <li
                          key={r.key}
                          className="rounded-full border border-teal-300/30 bg-teal-300/10 px-2.5 py-1 text-teal-200"
                        >
                          Must: {r.label}
                        </li>
                      ))}
                      {reqs.requirements.want.map((r) => (
                        <li
                          key={r.key}
                          className="rounded-full border border-sky-300/30 bg-sky-300/10 px-2.5 py-1 text-sky-200"
                        >
                          Want: {r.label}
                        </li>
                      ))}
                      {reqs.requirements.exclude.map((r) => (
                        <li
                          key={r.key}
                          className="rounded-full border border-rose-300/30 bg-rose-300/10 px-2.5 py-1 text-rose-200"
                        >
                          Avoid: {r.label}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              {reqs && reqs.questions.length > 0 && (
                <div className="mt-3 rounded-xl border border-sky-300/25 bg-sky-400/5 p-4">
                  <h3 className="text-sm font-semibold text-sky-200">
                    Quick questions
                  </h3>
                  {reqs.questions.map((q) => (
                    <div key={q.id} className="mt-3">
                      <p className="text-sm font-medium text-stone-200">
                        {q.prompt}
                      </p>
                      {q.options ? (
                        <div className="mt-2 flex flex-wrap gap-2">
                          {q.options.map((opt) => {
                            const active = answers[q.id] === opt;
                            return (
                              <button
                                key={opt}
                                type="button"
                                aria-pressed={active}
                                onClick={() =>
                                  setAnswers((prev) => ({
                                    ...prev,
                                    [q.id]: opt,
                                  }))
                                }
                                className={
                                  active
                                    ? "rounded-full bg-sky-300 px-3 py-1.5 text-xs font-semibold text-sky-950"
                                    : "rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-stone-300 hover:border-white/30"
                                }
                              >
                                {opt}
                              </button>
                            );
                          })}
                        </div>
                      ) : (
                        <input
                          type="text"
                          value={answers[q.id] ?? ""}
                          onChange={(event) =>
                            setAnswers((prev) => ({
                              ...prev,
                              [q.id]: event.target.value,
                            }))
                          }
                          placeholder="Type your answer"
                          className="mt-2 w-full rounded-lg border border-white/10 bg-white/5 p-2.5 text-sm text-stone-100 placeholder:text-stone-500 focus:border-sky-300/60 focus:ring-2 focus:ring-sky-300/20 focus:outline-none"
                        />
                      )}
                    </div>
                  ))}
                  <button
                    type="button"
                    onClick={() => void submitAnswers()}
                    disabled={
                      answering ||
                      reqs.questions.some(
                        (q) => !(answers[q.id] ?? "").trim(),
                      )
                    }
                    className="mt-4 rounded-lg bg-white px-4 py-2 text-sm font-semibold text-stone-950 transition hover:bg-sky-200 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {answering ? "Updating…" : "Update requirements"}
                  </button>
                </div>
              )}
            </div>

            <div className="mt-5 border-t border-white/10 pt-4">
              <button
                type="button"
                onClick={() => void runSearch()}
                disabled={
                  stage === "searching" ||
                  stage === "recommending" ||
                  enabledCount === 0 ||
                  !requirementsComplete
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
              {!requirementsComplete && enabledCount > 0 && (
                <p className="mt-2 text-xs text-stone-500">
                  {reqsLoading || answering
                    ? "Understanding requirements…"
                    : reqs == null
                      ? "Waiting for requirement understanding…"
                      : "Answer the quick questions above to enable search."}
                </p>
              )}
              {hasProfile && (
                <label className="mt-2 flex cursor-pointer items-center gap-2 text-xs text-stone-400">
                  <input
                    type="checkbox"
                    checked={useProfile}
                    onChange={() => setUseProfile((v) => !v)}
                    className="h-4 w-4 accent-teal-300"
                  />
                  Use my saved preferences for this search
                </label>
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
            <div className="mt-3 rounded-xl border border-white/10 bg-white/[0.03] p-3">
              <p className="text-sm text-stone-300">
                Evidence confidence:{" "}
                <strong className="text-stone-100">
                  {verdict.confidence.score}/100 ({verdict.confidence.level})
                </strong>
              </p>
              <div
                className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-white/10"
                role="img"
                aria-label={`Evidence confidence ${verdict.confidence.score} out of 100`}
              >
                <div
                  className="h-full rounded-full bg-teal-300"
                  style={{ width: `${verdict.confidence.score}%` }}
                />
              </div>
              {verdict.confidence.gaps.length > 0 && (
                <ul className="mt-2 list-disc space-y-0.5 pl-5 text-xs text-stone-500">
                  {verdict.confidence.gaps.map((gap) => (
                    <li key={gap}>{gap}</li>
                  ))}
                </ul>
              )}
            </div>
            {verdict.runnerUpDiff.length > 0 && (
              <div className="mt-3">
                <h3 className="text-sm font-semibold text-stone-200">
                  Why this won
                </h3>
                <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-stone-400">
                  {verdict.runnerUpDiff.map((d) => (
                    <li key={d}>{d}</li>
                  ))}
                </ul>
              </div>
            )}
            {verdict.personalization?.enabled ? (
              <div className="mt-3 rounded-xl border border-teal-300/25 bg-teal-300/5 p-3">
                <h3 className="text-sm font-semibold text-teal-200">
                  Personalized for you
                </h3>
                {verdict.personalization.applied.length > 0 ? (
                  <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs text-stone-300">
                    {verdict.personalization.applied.map((note) => (
                      <li key={note}>{note}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-1 text-xs text-stone-400">
                    Your profile was checked; nothing in it applied to this
                    query.
                  </p>
                )}
                {verdict.personalization.skipped.length > 0 && (
                  <details className="mt-1.5">
                    <summary className="cursor-pointer text-xs text-stone-500">
                      {verdict.personalization.skipped.length} saved{" "}
                      {verdict.personalization.skipped.length === 1
                        ? "preference"
                        : "preferences"}{" "}
                      not used
                    </summary>
                    <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs text-stone-500">
                      {verdict.personalization.skipped.map((note) => (
                        <li key={note}>{note}</li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
            ) : (
              verdict.personalization?.reason === "no-profile" && (
                <div className="mt-3 flex flex-wrap items-center gap-3 rounded-xl border border-white/10 bg-white/[0.03] p-3">
                  <p className="text-xs text-stone-400">
                    Save your preferences once, and future recommendations
                    will reflect them.
                  </p>
                  <button
                    type="button"
                    onClick={openPrefs}
                    className="rounded-lg border border-white/15 bg-white/5 px-3 py-1.5 text-xs font-semibold text-stone-200 transition hover:border-teal-300/50 hover:text-teal-200"
                  >
                    Set preferences
                  </button>
                </div>
              )
            )}
            <div className="mt-3 rounded-xl border border-white/10 bg-white/[0.03] p-3">
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => void saveCurrentDecision()}
                  disabled={saveState === "saving" || saveState === "saved"}
                  className="rounded-lg border border-white/15 bg-white/5 px-3 py-1.5 text-xs font-semibold text-stone-200 transition hover:border-teal-300/50 hover:text-teal-200 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {saveState === "saved"
                    ? "Saved ✓"
                    : saveState === "saving"
                      ? "Saving…"
                      : saveState === "error"
                        ? "Save failed — retry"
                        : "Save this decision"}
                </button>
                <div
                  className="flex items-center gap-1.5"
                  role="group"
                  aria-label="Was this helpful?"
                >
                  <span className="text-xs text-stone-500">Helpful?</span>
                  <button
                    type="button"
                    aria-pressed={helpfulVote === true}
                    disabled={helpfulVote !== null || votingHelpful}
                    onClick={() => void voteHelpful(true)}
                    className={
                      helpfulVote === true
                        ? "rounded-md bg-teal-300 px-2.5 py-1 text-xs font-semibold text-teal-950"
                        : "rounded-md border border-white/15 bg-white/5 px-2.5 py-1 text-xs font-semibold text-stone-300 transition hover:border-white/30 hover:text-stone-100 disabled:cursor-not-allowed disabled:opacity-50"
                    }
                  >
                    Yes
                  </button>
                  <button
                    type="button"
                    aria-pressed={helpfulVote === false}
                    disabled={helpfulVote !== null || votingHelpful}
                    onClick={() => void voteHelpful(false)}
                    className={
                      helpfulVote === false
                        ? "rounded-md bg-teal-300 px-2.5 py-1 text-xs font-semibold text-teal-950"
                        : "rounded-md border border-white/15 bg-white/5 px-2.5 py-1 text-xs font-semibold text-stone-300 transition hover:border-white/30 hover:text-stone-100 disabled:cursor-not-allowed disabled:opacity-50"
                    }
                  >
                    No
                  </button>
                </div>
                {helpfulVote !== null && (
                  <span className="text-xs text-teal-200">
                    Thanks for the feedback.
                  </span>
                )}
              </div>
              {feedbackDone ? (
                <p className="mt-2 text-xs text-teal-200">
                  Thanks — recorded. Patterns in your feedback may surface as
                  suggestions.
                </p>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => setFeedbackOpen((v) => !v)}
                    aria-expanded={feedbackOpen}
                    className="mt-2 text-xs text-stone-500 hover:text-stone-200 hover:underline"
                  >
                    {feedbackOpen ? "Hide details" : "Tell us more"}
                  </button>
                  {feedbackOpen && (
                    <div className="mt-2">
                      <div className="grid gap-2 sm:grid-cols-3">
                        {(
                          [
                            ["You prefer", preferId, setPreferId],
                            ["Not for you", rejectId, setRejectId],
                            ["You bought", purchasedId, setPurchasedId],
                          ] as const
                        ).map(([label, value, setValue]) => (
                          <label
                            key={label}
                            className="block text-xs text-stone-400"
                          >
                            {label}
                            <select
                              value={value}
                              onChange={(event) =>
                                setValue(event.target.value)
                              }
                              className="mt-1 w-full rounded-lg border border-white/10 bg-white/5 p-2 text-xs text-stone-100 focus:border-teal-300/60 focus:ring-2 focus:ring-teal-300/20 focus:outline-none"
                            >
                              <option value="">—</option>
                              {verdict.ranked.slice(0, 5).map((item, i) => (
                                <option key={item.product.id} value={item.product.id}>
                                  #{i + 1} {item.product.title}
                                </option>
                              ))}
                            </select>
                          </label>
                        ))}
                      </div>
                      <label className="mt-2 block text-xs text-stone-400">
                        Why not? (optional)
                        <input
                          type="text"
                          value={rejectReason}
                          onChange={(event) =>
                            setRejectReason(event.target.value)
                          }
                          placeholder="e.g. overpriced for the features"
                          maxLength={500}
                          className="mt-1 w-full rounded-lg border border-white/10 bg-white/5 p-2 text-xs text-stone-100 placeholder:text-stone-500 focus:border-teal-300/60 focus:ring-2 focus:ring-teal-300/20 focus:outline-none"
                        />
                      </label>
                      <button
                        type="button"
                        onClick={() => void submitFeedbackDetails()}
                        disabled={
                          feedbackSaving ||
                          (!preferId &&
                            !rejectId &&
                            !purchasedId &&
                            rejectReason.trim() === "")
                        }
                        className="mt-2 rounded-lg bg-white px-3 py-1.5 text-xs font-semibold text-stone-950 transition hover:bg-teal-200 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {feedbackSaving ? "Saving…" : "Submit feedback"}
                      </button>
                    </div>
                  )}
                </>
              )}
              {feedbackError && (
                <p className="mt-2 text-xs text-red-200">{feedbackError}</p>
              )}
            </div>
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
            {(verdict.excludedByBudget > 0 || allowOverBudget) && (
              <label className="mt-3 flex cursor-pointer items-center gap-2.5 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-sm transition hover:border-white/25">
                <input
                  type="checkbox"
                  checked={allowOverBudget}
                  disabled={
                    stage === "searching" || stage === "recommending"
                  }
                  onChange={() =>
                    void runSearch({ allowOverBudget: !allowOverBudget })
                  }
                  className="h-4 w-4 accent-teal-300"
                />
                <span className="text-stone-300">
                  Include near-budget options (up to 25% over) — searches
                  again with the wider budget
                </span>
              </label>
            )}
            {verdict.excluded.length > 0 && (
              <details className="mt-3 rounded-xl border border-white/10 bg-white/[0.03] p-4">
                <summary className="cursor-pointer text-sm font-medium text-stone-300">
                  {verdict.excluded.length} option
                  {verdict.excluded.length === 1 ? "" : "s"} excluded — why?
                </summary>
                <ul className="mt-2 space-y-2 text-sm">
                  {verdict.excluded.map((entry) => (
                    <li key={entry.productId}>
                      <p className="text-stone-200">
                        {entry.title}{" "}
                        <span className="text-xs text-stone-500">
                          · {entry.merchant}
                        </span>
                      </p>
                      <ul className="list-disc space-y-0.5 pl-5 text-stone-500">
                        {entry.reasons.map((reason) => (
                          <li key={reason}>{reason}</li>
                        ))}
                      </ul>
                    </li>
                  ))}
                </ul>
              </details>
            )}
            <details className="glass mt-3 rounded-xl p-4">
              <summary className="cursor-pointer text-sm font-semibold text-stone-200">
                Adjust scoring weights
              </summary>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                {(Object.keys(weights) as Array<keyof typeof weights>).map(
                  (key) => (
                    <label key={key} className="block text-xs text-stone-400">
                      <span className="flex justify-between">
                        <span>{WEIGHT_LABELS[key]}</span>
                        <span className="text-stone-200">{weights[key]}</span>
                      </span>
                      <input
                        type="range"
                        min={0}
                        max={100}
                        value={weights[key]}
                        onChange={(event) =>
                          setWeights((prev) => ({
                            ...prev,
                            [key]: Number(event.target.value),
                          }))
                        }
                        className="w-full accent-teal-300"
                      />
                    </label>
                  ),
                )}
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={() => void recalc()}
                  disabled={recalcLoading}
                  className="rounded-lg bg-white px-4 py-2 text-sm font-semibold text-stone-950 transition hover:bg-teal-200 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {recalcLoading ? "Recalculating…" : "Recalculate scores"}
                </button>
                <span className="text-xs text-stone-500">
                  Weights are scaled to sum to 100. No new search needed.
                </span>
              </div>
            </details>

            <div className="mt-3 flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={() => void fetchReviews()}
                disabled={reviewsLoading || cards.length === 0}
                className="rounded-lg border border-white/15 bg-white/5 px-4 py-2 text-sm font-semibold text-stone-200 backdrop-blur transition hover:border-teal-300/50 hover:text-teal-200 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {reviewsLoading ? (
                  <span className="flex items-center gap-2">
                    <span
                      aria-hidden="true"
                      className="h-4 w-4 rounded-full border-2 border-stone-200/30 border-t-stone-200 motion-safe:animate-spin"
                    />
                    Gathering review insights…
                  </span>
                ) : reviews ? (
                  "Refresh review insights"
                ) : (
                  "Get review insights"
                )}
              </button>
              <span className="text-xs text-stone-500">
                Top {Math.min(3, cards.length)} picks · separate search over
                review sources
              </span>
            </div>
            {reviewsError && (
              <p className="mt-2 rounded-lg border border-red-400/30 bg-red-500/10 p-3 text-sm text-red-200 backdrop-blur">
                {reviewsError}
              </p>
            )}
            {reviews?.warnings.map((warning) => (
              <p key={warning} className="mt-1 text-xs text-amber-200/80">
                {warning}
              </p>
            ))}
            {reviews && reviews.rankImpact.length > 0 && (
              <div className="mt-2 rounded-xl border border-violet-300/25 bg-violet-400/5 p-3">
                <p className="text-sm font-semibold text-violet-200">
                  Review evidence would reorder the ranking
                </p>
                <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs text-stone-400">
                  {reviews.rankImpact.map((note) => (
                    <li key={note}>{note}</li>
                  ))}
                </ul>
              </div>
            )}

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
                        Review signal
                      </th>
                      {compareItems.map(({ product }) => {
                        const itemReport =
                          reviews?.reports.find(
                            (r) => r.productId === product.id,
                          ) ?? null;
                        return (
                          <td key={product.id} className="p-3 text-stone-400">
                            {!itemReport
                              ? "—"
                              : itemReport.adjustment.unknownDimension
                                ? "Unknown"
                                : `${itemReport.adjustment.delta > 0 ? "+" : ""}${itemReport.adjustment.delta} · ${itemReport.quality.distinctSources} sources`}
                          </td>
                        );
                      })}
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
                {cards.map(({ product: p, score, analysis }, index) => {
                  const pros = (score?.reasons ?? []).filter(
                    (r) => r.sentiment === "pro",
                  );
                  const cons = (score?.reasons ?? []).filter(
                    (r) => r.sentiment === "con",
                  );
                  const checked = compareIds.includes(p.id);
                  const compareDisabled =
                    !checked && compareIds.length >= MAX_COMPARE;
                  const report =
                    reviews?.reports.find((r) => r.productId === p.id) ?? null;
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
                          {(() => {
                            const insight = insights[p.id];
                            if (
                              !insight ||
                              insight.stats.count < 2 ||
                              !insight.stats.min ||
                              !insight.stats.max
                            ) {
                              return null;
                            }
                            return (
                              <p className="mt-0.5 text-xs text-stone-500">
                                Tracked: low{" "}
                                {formatInr(insight.stats.min.priceInr)} · high{" "}
                                {formatInr(insight.stats.max.priceInr)} ·{" "}
                                {insight.stats.count} checks
                                {insight.stats.changeVsPrevious
                                  ? ` · ${insight.stats.changeVsPrevious.absoluteInr <= 0 ? "↓" : "↑"}${formatInr(Math.abs(insight.stats.changeVsPrevious.absoluteInr))} last move`
                                  : ""}
                              </p>
                            );
                          })()}
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
                        <div className="flex shrink-0 flex-col items-end gap-2">
                          <label className="flex cursor-pointer items-start gap-1.5 text-xs text-stone-400">
                            <input
                              type="checkbox"
                              checked={checked}
                              disabled={compareDisabled}
                              onChange={() => toggleCompare(p.id)}
                              className="mt-0.5 h-4 w-4 accent-teal-300 disabled:cursor-not-allowed"
                            />
                            Compare
                          </label>
                          <button
                            type="button"
                            onClick={() => startTrack(p)}
                            className="rounded-lg border border-white/15 bg-white/5 px-2.5 py-1 text-xs font-semibold text-stone-300 transition hover:border-teal-300/40 hover:text-teal-200"
                          >
                            Track price
                          </button>
                        </div>
                      </div>
                      {p.snippet && (
                        <p className="mt-2 line-clamp-3 text-sm text-stone-500">
                          {p.snippet}
                        </p>
                      )}
                      {score && <BreakdownBars score={score} />}
                      {analysis.checks.length > 0 && (
                        <ul className="mt-2 flex flex-wrap gap-1.5 text-xs">
                          {analysis.checks.map((check) => (
                            <li
                              key={check.key}
                              title={`${check.kind}: ${check.status}${check.key.startsWith("profile:") ? " · from your saved preferences" : ""}`}
                              className={
                                check.status === "met"
                                  ? "rounded-full border border-teal-300/30 bg-teal-300/10 px-2 py-0.5 text-teal-200"
                                  : check.status === "not-met"
                                    ? "rounded-full border border-rose-300/30 bg-rose-300/10 px-2 py-0.5 text-rose-200"
                                    : "rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-stone-400"
                              }
                            >
                              {check.status === "met"
                                ? "✓"
                                : check.status === "not-met"
                                  ? "✗"
                                  : "?"}{" "}
                              {check.label}
                            </li>
                          ))}
                        </ul>
                      )}
                      {analysis.evidence?.price.status === "conflicting" && (
                        <p className="mt-2 text-xs text-rose-300">
                          ⚠ {analysis.evidence.price.detail}
                        </p>
                      )}
                      {analysis.evidence?.rating.status === "conflicting" && (
                        <p className="mt-1 text-xs text-rose-300">
                          ⚠ {analysis.evidence.rating.detail}
                        </p>
                      )}
                      {analysis.evidence?.stale && (
                        <p className="mt-1 text-xs text-amber-200/80">
                          Listing data may be stale — verify on the
                          retailer&apos;s page.
                        </p>
                      )}
                      {report && (
                        <div className="mt-2 rounded-lg border border-white/10 bg-white/[0.03] p-3">
                          <p className="text-xs font-semibold text-stone-200">
                            Review insights{" "}
                            <span className="font-normal text-stone-500">
                              · {report.quality.distinctSources} distinct
                              source
                              {report.quality.distinctSources === 1 ? "" : "s"}{" "}
                              · evidence {report.quality.level}
                              {report.adjustedTotal != null && score
                                ? ` · score ${score.total} → ${report.adjustedTotal}`
                                : ""}
                            </span>
                          </p>
                          {report.insights.length === 0 ? (
                            <p className="mt-1 text-xs text-stone-500">
                              No recurring themes confirmed.
                            </p>
                          ) : (
                            <>
                              {report.insights.filter(
                                (i) => i.sentiment === "positive",
                              ).length > 0 && (
                                <ul className="mt-1.5 space-y-1 text-xs">
                                  {report.insights
                                    .filter((i) => i.sentiment === "positive")
                                    .map((i) => (
                                      <li
                                        key={`${i.theme}-positive`}
                                        className="text-teal-300"
                                      >
                                        + {i.theme}{" "}
                                        <span className="text-stone-500">
                                          ({i.distinctSources} sources ·{" "}
                                          {i.quality})
                                        </span>
                                      </li>
                                    ))}
                                </ul>
                              )}
                              {report.insights.filter(
                                (i) => i.sentiment === "negative",
                              ).length > 0 && (
                                <ul className="mt-1.5 space-y-1 text-xs">
                                  {report.insights
                                    .filter((i) => i.sentiment === "negative")
                                    .map((i) => (
                                      <li
                                        key={`${i.theme}-negative`}
                                        className="text-rose-300"
                                      >
                                        – {i.theme}{" "}
                                        <span className="text-stone-500">
                                          ({i.distinctSources} sources ·{" "}
                                          {i.quality})
                                        </span>
                                      </li>
                                    ))}
                                </ul>
                              )}
                            </>
                          )}
                          {report.contradictions.map((c) => (
                            <p
                              key={c.topic}
                              className="mt-1.5 text-xs text-amber-200/80"
                            >
                              ⚠ {c.note}
                            </p>
                          ))}
                          {report.adjustment.unknownDimension ? (
                            <p className="mt-1 text-xs text-stone-500">
                              Review signal: unknown — not enough corroborated
                              evidence to adjust the score.
                            </p>
                          ) : (
                            report.adjustment.delta !== 0 && (
                              <p className="mt-1 text-xs text-stone-400">
                                Score impact{" "}
                                {report.adjustment.delta > 0 ? "+" : ""}
                                {report.adjustment.delta}:{" "}
                                {report.adjustment.reasons[0]}
                              </p>
                            )
                          )}
                          {report.limitations.slice(0, 2).map((limitation) => (
                            <p
                              key={limitation}
                              className="mt-1 text-xs text-stone-500"
                            >
                              {limitation}
                            </p>
                          ))}
                          {report.records.filter(
                            (r) =>
                              !r.duplicateOf && r.relevance !== "irrelevant",
                          ).length > 0 && (
                            <ul className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-xs">
                              {report.records
                                .filter(
                                  (r) =>
                                    !r.duplicateOf &&
                                    r.relevance !== "irrelevant",
                                )
                                .slice(0, 4)
                                .map((r) => (
                                  <li key={r.id}>
                                    <a
                                      href={r.url}
                                      target="_blank"
                                      rel="noreferrer"
                                      className="text-sky-300 hover:underline"
                                    >
                                      {r.sourceName} · {r.relevance} ·{" "}
                                      {new Date(
                                        r.retrievedAt,
                                      ).toLocaleDateString("en-IN")}
                                    </a>
                                  </li>
                                ))}
                            </ul>
                          )}
                          <p className="mt-1.5 text-[11px] text-stone-600">
                            AI-grouped observations from linked sources — not
                            verified specifications.
                          </p>
                        </div>
                      )}
                      {(pros.length > 0 || cons.length > 0) && (
                        <ul className="mt-2 space-y-1 text-sm">
                          {pros.slice(0, 2).map((r) => (
                            <li key={r.text} className="text-teal-300">
                              + {r.text}
                              {r.source === "profile" && (
                                <span className="ml-1.5 rounded-full border border-teal-300/30 bg-teal-300/10 px-1.5 py-px align-middle text-[10px] font-semibold text-teal-200">
                                  saved
                                </span>
                              )}
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
