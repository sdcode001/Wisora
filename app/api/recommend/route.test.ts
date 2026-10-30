import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  createSession,
  SESSION_COOKIE,
} from "../../../lib/auth/session";
import { FileMemoryStore } from "../../../lib/memory/file-store";
import {
  applyCategoryPatch,
  applyGeneralPatch,
  createDefaultProfile,
} from "../../../lib/memory/profile";
import { POST } from "./route";

delete process.env.META_API_KEY;
delete process.env.TAVILY_API_KEY;

// Price auto-recording writes to the data dir — keep every test isolated.
beforeEach(async () => {
  process.env.WISORA_DATA_DIR = await mkdtemp(
    path.join(tmpdir(), "wisora-recommend-"),
  );
});

const req = (body: unknown): Request =>
  new Request("http://localhost/api/recommend", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const ALL_DISABLED = {
  "amazon-in": true,
  flipkart: true,
  shopclues: true,
  snapdeal: true,
  myntra: true,
  ajio: true,
  "tata-cliq": true,
  "nykaa-fashion": true,
  "newme-fashion": true,
};

const FRESH = new Date().toISOString();

const INTENT = {
  query: "laptop under 50000",
  category: "electronics",
  categoryConfidence: "high",
  searchTerms: "laptop",
  budgetInr: { max: 50000 },
};

const REQUIREMENTS = {
  category: "electronics",
  must: [],
  want: [],
  exclude: [],
  unanswered: [],
};

const PRODUCT = {
  id: "p1",
  sourceId: "amazon-in",
  title: "Test Laptop 16GB",
  url: "https://www.amazon.in/dp/B0TEST1",
  merchant: "Amazon India",
  snippet: "A test laptop.",
  priceInr: 45000,
  priceEvidence: "repeated",
  rating: { value: 4.3, count: 1200, seenAt: FRESH },
  score: 40,
  retrievedAt: FRESH,
};

const STATUS = {
  sourceId: "amazon-in",
  ok: true,
  resultCount: 1,
  searchedAt: FRESH,
};

test("rejects invalid bodies", async () => {
  const response = await POST(req({}));
  expect(response.status).toBe(400);
});

test("recommends from provided products without live calls", async () => {
  const response = await POST(
    req({
      query: "laptop under 50000",
      intent: INTENT,
      requirements: REQUIREMENTS,
      products: [PRODUCT],
      statuses: [STATUS],
      searchedAt: FRESH,
    }),
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    ranked: Array<{ analysis: { checks: unknown[]; evidence: unknown } }>;
    recommendation: { verdict: string };
    reasoningUsed: string;
    requirements: { category: string };
    confidence: { level: string };
    excludedByBudget: number;
    excluded: unknown[];
    statuses: unknown[];
  };
  expect(body.recommendation.verdict).toBe("BUY");
  expect(body.reasoningUsed).toBe("rules");
  expect(body.requirements.category).toBe("electronics");
  expect(body.ranked).toHaveLength(1);
  expect(body.ranked[0]?.analysis.checks).toEqual([]);
  expect(body.ranked[0]?.analysis.evidence).not.toBeNull();
  expect(body.confidence.level).toBe("high");
  expect(body.excludedByBudget).toBe(0);
  expect(body.statuses).toHaveLength(1);
});

test("over-budget products ask for clarification", async () => {
  const response = await POST(
    req({
      query: "laptop under 50000",
      intent: INTENT,
      requirements: REQUIREMENTS,
      products: [{ ...PRODUCT, priceInr: 80000 }],
      statuses: [STATUS],
      searchedAt: FRESH,
    }),
  );
  const body = (await response.json()) as {
    recommendation: { verdict: string };
    excludedByBudget: number;
    excluded: Array<{ reasons: string[] }>;
    warnings: string[];
  };
  expect(body.recommendation.verdict).toBe("NEEDS_CLARIFICATION");
  expect(body.excludedByBudget).toBe(1);
  expect(body.excluded[0]?.reasons[0]).toContain("Over budget");
  expect(body.warnings.some((w) => w.includes("excluded"))).toBe(true);
});

test("invalid weights fall back to defaults with a warning", async () => {
  const response = await POST(
    req({
      query: "laptop under 50000",
      intent: INTENT,
      requirements: REQUIREMENTS,
      weights: { price: 50, relevance: 50, evidence: 50, wants: 50 },
      products: [PRODUCT],
      statuses: [STATUS],
      searchedAt: FRESH,
    }),
  );
  const body = (await response.json()) as {
    recommendation: { verdict: string };
    warnings: string[];
  };
  expect(response.status).toBe(200);
  expect(body.recommendation.verdict).toBe("BUY");
  expect(body.warnings.some((w) => w.includes("weights"))).toBe(true);
});

test("all sources disabled means no-sources, not a search", async () => {
  const response = await POST(
    req({ query: "laptop", disabled: ALL_DISABLED }),
  );
  expect(response.status).toBe(400);
  const body = (await response.json()) as { code: string };
  expect(body.code).toBe("no-sources");
});

test("partial disable without products needs the search key", async () => {
  const response = await POST(
    req({ query: "laptop", disabled: { "amazon-in": true } }),
  );
  expect(response.status).toBe(503);
  const body = (await response.json()) as { code: string };
  expect(body.code).toBe("missing-tavily-key");
});

// --- Personalization (Phase 4, slice 2) ---

const SAVED_SECRET = process.env.SESSION_SECRET;
const SAVED_DATA_DIR = process.env.WISORA_DATA_DIR;

afterEach(() => {
  if (SAVED_SECRET === undefined) {
    delete process.env.SESSION_SECRET;
  } else {
    process.env.SESSION_SECRET = SAVED_SECRET;
  }
  if (SAVED_DATA_DIR === undefined) {
    delete process.env.WISORA_DATA_DIR;
  } else {
    process.env.WISORA_DATA_DIR = SAVED_DATA_DIR;
  }
});

const USER = {
  sub: "user-1",
  name: "Test User",
  email: "test@example.com",
  picture: null,
};

interface PersonalizationBody {
  personalization: {
    enabled: boolean;
    reason?: string;
    applied: string[];
    skipped: string[];
    budgetSource: string;
    weightsSource: string;
  };
  ranked: Array<{
    product: { id: string };
    score: {
      reasons: Array<{ text: string; source?: string }>;
    };
    analysis: { checks: Array<{ key: string }> };
  }>;
  excluded: Array<{ reasons: string[] }>;
  excludedByBudget: number;
  warnings: string[];
  intent: { budgetInr?: { min?: number; max?: number } };
}

async function saveProfile(
  patch: (profile: ReturnType<typeof createDefaultProfile>) => void,
): Promise<string> {
  process.env.SESSION_SECRET = "test-secret";
  const dir = await mkdtemp(path.join(tmpdir(), "wisora-recommend-"));
  process.env.WISORA_DATA_DIR = dir;
  const profile = createDefaultProfile(USER.sub);
  patch(profile);
  await new FileMemoryStore().saveProfile(profile);
  return dir;
}

function authedReq(body: unknown): Request {
  const token = createSession(USER, "test-secret");
  return new Request("http://localhost/api/recommend", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      cookie: `${SESSION_COOKIE}=${token}`,
    },
    body: JSON.stringify(body),
  });
}

function withElectronicsBudget(max: number) {
  return (profile: ReturnType<typeof createDefaultProfile>): void => {
    profile.categories.electronics = {
      value: applyCategoryPatch(undefined, "electronics", {
        budgetInr: { max },
      }),
      updatedAt: FRESH,
      provenance: "explicit",
    };
  };
}

const NO_BUDGET_INTENT = { ...INTENT, budgetInr: undefined };

test("anonymous requests report personalization as signed-out", async () => {
  const response = await POST(
    req({
      query: "laptop under 50000",
      intent: INTENT,
      requirements: REQUIREMENTS,
      products: [PRODUCT],
      statuses: [STATUS],
      searchedAt: FRESH,
    }),
  );
  const body = (await response.json()) as PersonalizationBody;
  expect(body.personalization.enabled).toBe(false);
  expect(body.personalization.reason).toBe("signed-out");
});

test("signed-in users without a profile report no-profile", async () => {
  process.env.SESSION_SECRET = "test-secret";
  process.env.WISORA_DATA_DIR = await mkdtemp(
    path.join(tmpdir(), "wisora-recommend-"),
  );
  const response = await POST(
    authedReq({
      query: "laptop under 50000",
      intent: INTENT,
      requirements: REQUIREMENTS,
      products: [PRODUCT],
      statuses: [STATUS],
      searchedAt: FRESH,
    }),
  );
  const body = (await response.json()) as PersonalizationBody;
  expect(body.personalization.enabled).toBe(false);
  expect(body.personalization.reason).toBe("no-profile");
});

test("a saved budget applies when the query states none", async () => {
  await saveProfile(withElectronicsBudget(50000));
  const response = await POST(
    authedReq({
      query: "laptop for coding",
      intent: NO_BUDGET_INTENT,
      requirements: REQUIREMENTS,
      products: [PRODUCT],
      statuses: [STATUS],
      searchedAt: FRESH,
    }),
  );
  const body = (await response.json()) as PersonalizationBody;
  expect(body.personalization.enabled).toBe(true);
  expect(body.personalization.budgetSource).toBe("profile");
  expect(body.personalization.applied).toContain(
    "Saved electronics budget applied (up to ₹50,000).",
  );
  expect(body.intent.budgetInr).toEqual({ max: 50000 });
  expect(body.ranked).toHaveLength(1);
  expect(body.excludedByBudget).toBe(0);
});

test("a saved budget excludes over-budget options", async () => {
  await saveProfile(withElectronicsBudget(50000));
  const response = await POST(
    authedReq({
      query: "laptop for coding",
      intent: NO_BUDGET_INTENT,
      requirements: REQUIREMENTS,
      products: [{ ...PRODUCT, priceInr: 80000 }],
      statuses: [STATUS],
      searchedAt: FRESH,
    }),
  );
  const body = (await response.json()) as PersonalizationBody;
  expect(body.personalization.budgetSource).toBe("profile");
  expect(body.excludedByBudget).toBe(1);
  expect(body.excluded[0]?.reasons[0]).toContain("Over budget");
});

test("personalize:false ignores the saved profile for one query", async () => {
  await saveProfile(withElectronicsBudget(50000));
  const response = await POST(
    authedReq({
      query: "laptop for coding",
      intent: NO_BUDGET_INTENT,
      requirements: REQUIREMENTS,
      personalize: false,
      products: [{ ...PRODUCT, priceInr: 80000 }],
      statuses: [STATUS],
      searchedAt: FRESH,
    }),
  );
  const body = (await response.json()) as PersonalizationBody;
  expect(body.personalization.enabled).toBe(false);
  expect(body.personalization.reason).toBe("opted-out");
  expect(body.excludedByBudget).toBe(0);
  expect(body.ranked).toHaveLength(1);
});

test("a preferred brand boosts matching products with attribution", async () => {
  await saveProfile((profile) => {
    profile.general.value = applyGeneralPatch(profile.general.value, {
      preferredBrands: ["Sony"],
    });
  });
  const plain = { ...PRODUCT, id: "p1", title: "Test Laptop 16GB" };
  const sony = {
    ...PRODUCT,
    id: "p2",
    title: "Sony Test Laptop 16GB",
    url: "https://www.amazon.in/dp/B0TEST2",
  };
  const response = await POST(
    authedReq({
      query: "laptop under 50000",
      intent: INTENT,
      requirements: REQUIREMENTS,
      products: [plain, sony],
      statuses: [STATUS],
      searchedAt: FRESH,
    }),
  );
  const body = (await response.json()) as PersonalizationBody;
  expect(body.ranked).toHaveLength(2);
  expect(body.ranked[0]?.product.id).toBe("p2");
  const reasons = body.ranked[0]?.score.reasons ?? [];
  expect(
    reasons.some(
      (reason) =>
        reason.source === "profile" && reason.text.includes("Sony"),
    ),
  ).toBe(true);
  const checks = body.ranked[0]?.analysis.checks ?? [];
  expect(checks.some((check) => check.key.startsWith("profile:"))).toBe(true);
});

test("an avoided brand excludes matching products", async () => {
  await saveProfile((profile) => {
    profile.general.value = applyGeneralPatch(profile.general.value, {
      avoidedBrands: ["Sony"],
    });
  });
  const plain = { ...PRODUCT, id: "p1", title: "Test Laptop 16GB" };
  const sony = {
    ...PRODUCT,
    id: "p2",
    title: "Sony Test Laptop 16GB",
    url: "https://www.amazon.in/dp/B0TEST2",
  };
  const response = await POST(
    authedReq({
      query: "laptop under 50000",
      intent: INTENT,
      requirements: REQUIREMENTS,
      products: [plain, sony],
      statuses: [STATUS],
      searchedAt: FRESH,
    }),
  );
  const body = (await response.json()) as PersonalizationBody;
  expect(body.ranked).toHaveLength(1);
  expect(body.ranked[0]?.product.id).toBe("p1");
  expect(body.excluded).toHaveLength(1);
  expect(body.excluded[0]?.reasons[0]).toContain("Sony");
});

test("a saved decision priority tunes scoring unless overridden", async () => {
  await saveProfile((profile) => {
    profile.general.value = applyGeneralPatch(profile.general.value, {
      decisionPriority: "lowest-price",
    });
  });
  const base = {
    query: "laptop under 50000",
    intent: INTENT,
    requirements: REQUIREMENTS,
    products: [PRODUCT],
    statuses: [STATUS],
    searchedAt: FRESH,
  };
  const preset = (await (
    await POST(authedReq(base))
  ).json()) as PersonalizationBody;
  expect(preset.personalization.weightsSource).toBe("profile");
  expect(preset.personalization.applied).toContain(
    "Scoring tuned for lowest price (saved preference).",
  );
  const overridden = (await (
    await POST(
      authedReq({
        ...base,
        weights: { price: 25, relevance: 25, evidence: 25, wants: 25 },
      }),
    )
  ).json()) as PersonalizationBody;
  expect(overridden.personalization.weightsSource).toBe("request");
  expect(
    overridden.personalization.applied.some((note) =>
      note.includes("Scoring tuned"),
    ),
  ).toBe(false);
});

test("an unreadable profile degrades gracefully with a warning", async () => {
  const dir = await saveProfile(() => {});
  const entries = await readdir(path.join(dir, "users"));
  const userDir = entries[0] ?? expect.unreachable("expected a user dir");
  await writeFile(
    path.join(dir, "users", userDir, "profile.json"),
    JSON.stringify({ version: 99, userSub: USER.sub }),
    "utf8",
  );
  const response = await POST(
    authedReq({
      query: "laptop for coding",
      intent: NO_BUDGET_INTENT,
      requirements: REQUIREMENTS,
      products: [PRODUCT],
      statuses: [STATUS],
      searchedAt: FRESH,
    }),
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as PersonalizationBody;
  expect(body.personalization.enabled).toBe(false);
  expect(body.personalization.reason).toBe("unreadable");
  expect(
    body.warnings.some((warning) => warning.includes("couldn't be read")),
  ).toBe(true);
  expect(body.ranked).toHaveLength(1);
});

// --- Price auto-recording (Phase 5) ---

test("recommendations record prices and evaluate watches", async () => {
  process.env.SESSION_SECRET = "test-secret";
  process.env.WISORA_DATA_DIR = await mkdtemp(
    path.join(tmpdir(), "wisora-recommend-"),
  );
  const store = new FileMemoryStore();
  await store.saveWatch("user-1", {
    productId: "p1",
    url: PRODUCT.url,
    title: PRODUCT.title,
    merchant: PRODUCT.merchant,
    targetPrice: 46000,
    currency: "INR",
    active: true,
    canWait: true,
  });
  const response = await POST(
    authedReq({
      query: "laptop under 50000",
      intent: INTENT,
      requirements: REQUIREMENTS,
      products: [PRODUCT],
      statuses: [STATUS],
      searchedAt: FRESH,
    }),
  );
  expect(response.status).toBe(200);
  expect(await store.listObservations("p1")).toHaveLength(1);
  const alerts = await store.listAlerts("user-1");
  expect(alerts).toHaveLength(1);
  expect(alerts[0]?.observedPrice).toBe(45000);
  const body = (await response.json()) as { warnings: string[] };
  expect(body.warnings.some((warning) => warning.includes("price alert"))).toBe(
    true,
  );
});
