import type { Category } from "../../config/sources";
import { sessionUserFromRequest } from "../auth/require-session";
import type { Intent } from "../intent/types";
import {
  DEFAULT_WEIGHTS,
  normalizeWeights,
  type RawWeights,
  type ScoreWeights,
} from "../recommend/weights";
import {
  CATEGORY_LABELS,
  RequirementSchema,
  type Requirement,
  type RequirementSet,
} from "../requirements/types";
import { formatInr } from "../text/format";
import { contentTokens } from "../text/tokens";
import { FileMemoryStore, StoredDataError } from "./file-store";
import {
  PROFILE_KEY_PREFIX,
  type CategoryPreferences,
  type DecisionPriority,
  type UserProfile,
} from "./profile";
import type { MemoryStore } from "./store";

/**
 * Importance for profile-sourced wants. Deliberately below the 0.5 default
 * for current-request wants so a saved preference nudges the ranking but
 * can never drown out explicit instructions.
 */
export const STORED_WANT_IMPORTANCE = 0.3;

const DECISION_PRIORITY_WEIGHTS: Record<DecisionPriority, RawWeights> = {
  // Price fit dominates; relevance keeps results on-topic.
  "lowest-price": { price: 50, relevance: 25, evidence: 15, wants: 10 },
  "best-value": { ...DEFAULT_WEIGHTS },
  // Requirement coverage (which carries performance wants) dominates.
  performance: { price: 30, relevance: 40, evidence: 15, wants: 15 },
  // Verified evidence dominates; price matters less.
  durability: { price: 30, relevance: 25, evidence: 30, wants: 15 },
  // Price matters least; stated preferences matter most.
  premium: { price: 25, relevance: 30, evidence: 25, wants: 20 },
};

const DECISION_PRIORITY_LABELS: Record<DecisionPriority, string> = {
  "lowest-price": "lowest price",
  "best-value": "best value",
  performance: "performance",
  durability: "durability",
  premium: "premium quality",
};

/** Scoring weights derived from a saved decision priority (sums to 100). */
export function weightPresetFor(priority: DecisionPriority): ScoreWeights {
  return normalizeWeights(DECISION_PRIORITY_WEIGHTS[priority]);
}

export type PersonalizationDisabledReason =
  | "signed-out"
  | "opted-out"
  | "no-profile"
  | "unreadable";

export interface PersonalizationReport {
  enabled: boolean;
  reason?: PersonalizationDisabledReason;
  /** Human-readable notes: what was applied, and which conflicts resolved how. */
  applied: string[];
  /** Saved preferences that exist but had no effect, with reasons. */
  skipped: string[];
  budgetSource: "query" | "profile" | "none";
  weightsSource: "request" | "profile" | "default";
}

export interface PersonalizationInput {
  profile: UserProfile;
  category: Category;
  intent: Intent;
  requirements: RequirementSet;
  weightsProvided: boolean;
}

export interface PersonalizationResult {
  intent: Intent;
  requirements: RequirementSet;
  /** Weight preset, or null when request/default weights should be used. */
  preset: ScoreWeights | null;
  report: PersonalizationReport;
}

/** Slug budget: longest key base is `profile:brand-prefer:` (21 chars),
 *  keys cap at 60, and dedupe suffixes add up to ~4. */
function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30);
  return slug || "item";
}

function tokensCoverAll(name: string, haystack: Set<string>): boolean {
  const tokens = contentTokens(name);
  return tokens.size > 0 && [...tokens].every((token) => haystack.has(token));
}

function categoryWants(
  prefs: CategoryPreferences,
  makeKey: (base: string) => string,
): { wants: Requirement[]; skipped: string[] } {
  const wants: Requirement[] = [];
  const skipped: string[] = [];
  const label = CATEGORY_LABELS[prefs.category].toLowerCase();
  const add = (keyBase: string, text: string): void => {
    wants.push(
      RequirementSchema.parse({
        key: makeKey(`${PROFILE_KEY_PREFIX}${keyBase}`),
        label: text,
        kind: "want",
        importance: STORED_WANT_IMPORTANCE,
      }),
    );
  };
  // Stored budgets are handled by the budget step, not here.
  switch (prefs.category) {
    case "electronics":
      if (prefs.useCase) {
        add("electronics:use-case", prefs.useCase);
      }
      // RAM needs component scoping ("16GB RAM"): a bare "16GB" would also
      // match a 512GB drive. Storage is safe unscoped: RAM-sized numbers
      // can never reach a storage-sized minimum.
      if (prefs.minRamGb != null) {
        add("electronics:min-ram", `${prefs.minRamGb}GB RAM minimum`);
      }
      if (prefs.minStorageGb != null) {
        add("electronics:min-storage", `${prefs.minStorageGb}GB minimum`);
      }
      if (prefs.performanceLevel) {
        skipped.push(
          `Saved ${label} performance level (${prefs.performanceLevel}) has no listing equivalent yet.`,
        );
      }
      if (prefs.batteryPriority != null) {
        skipped.push(
          `Saved ${label} battery priority (${prefs.batteryPriority}) has no scoring effect yet.`,
        );
      }
      if (prefs.portability) {
        skipped.push(
          `Saved ${label} portability (${prefs.portability}) has no listing equivalent yet.`,
        );
      }
      if (prefs.warrantyPriority != null) {
        skipped.push(
          `Saved ${label} warranty priority (${prefs.warrantyPriority}) has no scoring effect yet.`,
        );
      }
      if (prefs.notes) {
        skipped.push(`Saved ${label} notes aren't used for matching.`);
      }
      break;
    case "fashion":
      if (prefs.sizes && prefs.sizes.length > 0) {
        skipped.push(
          `Saved ${label} sizes (${prefs.sizes.join(", ")}) aren't used for matching yet.`,
        );
      }
      prefs.styles?.forEach((style, index) =>
        add(`fashion:style-${index}`, style),
      );
      prefs.materials?.forEach((material, index) =>
        add(`fashion:material-${index}`, material),
      );
      if (prefs.notes) {
        skipped.push(`Saved ${label} notes aren't used for matching.`);
      }
      break;
    case "footwear":
      if (prefs.sizes && prefs.sizes.length > 0) {
        skipped.push(
          `Saved ${label} sizes (${prefs.sizes.join(", ")}) aren't used for matching yet.`,
        );
      }
      if (prefs.useCase) {
        add("footwear:use-case", prefs.useCase);
      }
      if (prefs.notes) {
        skipped.push(`Saved ${label} notes aren't used for matching.`);
      }
      break;
    case "beauty":
      prefs.concerns?.forEach((concern, index) =>
        add(`beauty:concern-${index}`, concern),
      );
      if (prefs.notes) {
        skipped.push(`Saved ${label} notes aren't used for matching.`);
      }
      break;
    case "home-kitchen":
      if (prefs.useCase) {
        add("home-kitchen:use-case", prefs.useCase);
      }
      if (prefs.notes) {
        skipped.push(`Saved ${label} notes aren't used for matching.`);
      }
      break;
    case "general":
      if (prefs.notes) {
        skipped.push(`Saved ${label} notes aren't used for matching.`);
      }
      break;
  }
  return { wants, skipped };
}

/**
 * Merge a saved profile into the current request. Pure: no session or
 * storage access (see resolvePersonalization for the wired version).
 *
 * Precedence: current explicit instructions always win for this request.
 * Stored budgets only fill an unstated budget (never relax one), stored
 * details become low-importance wants, avoided brands become exclusions,
 * and every conflict is reported rather than applied silently.
 */
export function personalizeRequest(
  input: PersonalizationInput,
): PersonalizationResult {
  const { profile, category, intent, requirements } = input;
  const general = profile.general.value;
  const catLabel = CATEGORY_LABELS[category].toLowerCase();
  const applied: string[] = [];
  const skipped: string[] = [];
  const wants: Requirement[] = [];
  const excludes: Requirement[] = [];

  const usedKeys = new Set(
    [...requirements.must, ...requirements.want, ...requirements.exclude].map(
      (req) => req.key,
    ),
  );
  const makeKey = (base: string): string => {
    let key = base;
    let counter = 2;
    while (usedKeys.has(key)) {
      key = `${base}-${counter}`;
      counter += 1;
    }
    usedKeys.add(key);
    return key;
  };

  // --- Budget: stored maximum fills an unstated budget, nothing more.
  let effectiveIntent = intent;
  let budgetSource: PersonalizationReport["budgetSource"] =
    intent.budgetInr?.max != null ? "query" : "none";
  const storedBudget = profile.categories[category]?.value.budgetInr;
  const queryMax = intent.budgetInr?.max;
  if (queryMax == null && storedBudget?.max != null) {
    effectiveIntent = {
      ...intent,
      budgetInr: {
        ...(intent.budgetInr?.min != null
          ? { min: intent.budgetInr.min }
          : storedBudget.min != null
            ? { min: storedBudget.min }
            : {}),
        max: storedBudget.max,
      },
    };
    budgetSource = "profile";
    applied.push(
      `Saved ${catLabel} budget applied (up to ${formatInr(storedBudget.max)}).`,
    );
  } else if (
    queryMax != null &&
    storedBudget?.max != null &&
    storedBudget.max !== queryMax
  ) {
    applied.push(
      `Query budget (up to ${formatInr(queryMax)}) used instead of your saved ${catLabel} budget (up to ${formatInr(storedBudget.max)}).`,
    );
  } else if (
    queryMax == null &&
    storedBudget?.max == null &&
    storedBudget?.min != null
  ) {
    skipped.push(
      `Saved ${catLabel} minimum (${formatInr(storedBudget.min)}) has no effect — only maximum budgets are applied.`,
    );
  }

  // --- Brands and merchants. Conflict detection runs against the
  // --- current request only (pre-merge), so the query always wins.
  const queryTokens = contentTokens(
    [
      intent.query,
      intent.searchTerms,
      ...requirements.must.map((req) => req.label),
      ...requirements.want.map((req) => req.label),
    ].join(" "),
  );
  const excludeTokens = contentTokens(
    requirements.exclude.map((req) => req.label).join(" "),
  );
  const avoidedLower = new Set(
    general.avoidedBrands.map((brand) => brand.toLowerCase()),
  );
  const preferredLower = new Set(
    general.preferredBrands.map((brand) => brand.toLowerCase()),
  );
  const brandConflicts: string[] = [];
  const appliedPrefer: string[] = [];
  for (const brand of general.preferredBrands) {
    if (contentTokens(brand).size === 0) {
      skipped.push(
        `Saved brand "${brand}" is too short to match listings reliably.`,
      );
      continue;
    }
    if (avoidedLower.has(brand.toLowerCase())) {
      continue; // Contradiction is reported once, on the avoid side.
    }
    if (tokensCoverAll(brand, excludeTokens)) {
      brandConflicts.push(
        `Skipped saved preference for ${brand}: excluded in this query.`,
      );
      continue;
    }
    wants.push(
      RequirementSchema.parse({
        key: makeKey(`${PROFILE_KEY_PREFIX}brand-prefer:${slugify(brand)}`),
        label: brand,
        kind: "want",
        importance: STORED_WANT_IMPORTANCE,
      }),
    );
    appliedPrefer.push(brand);
  }
  const appliedAvoid: string[] = [];
  for (const brand of general.avoidedBrands) {
    if (contentTokens(brand).size === 0) {
      skipped.push(
        `Saved brand "${brand}" is too short to match listings reliably.`,
      );
      continue;
    }
    if (tokensCoverAll(brand, queryTokens)) {
      brandConflicts.push(
        `Kept ${brand}: your query explicitly asks for it.`,
      );
      continue;
    }
    excludes.push(
      RequirementSchema.parse({
        key: makeKey(`${PROFILE_KEY_PREFIX}brand-avoid:${slugify(brand)}`),
        label: brand,
        kind: "exclude",
      }),
    );
    appliedAvoid.push(brand);
    if (preferredLower.has(brand.toLowerCase())) {
      brandConflicts.push(
        `${brand} is both preferred and avoided in your profile — avoiding it.`,
      );
    }
  }
  if (appliedPrefer.length > 0) {
    applied.push(
      `Preferred brands from your profile: ${appliedPrefer.join(", ")}.`,
    );
  }
  if (appliedAvoid.length > 0) {
    applied.push(
      `Avoided brands from your profile: ${appliedAvoid.join(", ")}.`,
    );
  }
  applied.push(...brandConflicts);

  const appliedMerchants: string[] = [];
  for (const merchant of general.preferredMerchants) {
    if (contentTokens(merchant).size === 0) {
      skipped.push(
        `Saved merchant "${merchant}" is too short to match listings reliably.`,
      );
      continue;
    }
    wants.push(
      RequirementSchema.parse({
        key: makeKey(`${PROFILE_KEY_PREFIX}merchant:${slugify(merchant)}`),
        label: merchant,
        kind: "want",
        importance: STORED_WANT_IMPORTANCE,
      }),
    );
    appliedMerchants.push(merchant);
  }
  if (appliedMerchants.length > 0) {
    applied.push(
      `Preferred merchants from your profile: ${appliedMerchants.join(", ")}.`,
    );
  }

  // --- Category details.
  const catPrefs = profile.categories[category]?.value;
  if (catPrefs) {
    const { wants: categoryWantList, skipped: categorySkipped } =
      categoryWants(catPrefs, makeKey);
    wants.push(...categoryWantList);
    for (const want of categoryWantList) {
      applied.push(`Saved ${catLabel} preference applied: ${want.label}.`);
    }
    skipped.push(...categorySkipped);
  }

  // --- Decision priority becomes a weight preset, unless the request
  // --- carries explicit weights (current instructions win).
  const priority = general.decisionPriority;
  const preset =
    !input.weightsProvided && priority ? weightPresetFor(priority) : null;
  if (preset && priority) {
    applied.push(
      `Scoring tuned for ${DECISION_PRIORITY_LABELS[priority]} (saved preference).`,
    );
  }

  return {
    intent: effectiveIntent,
    requirements: {
      ...requirements,
      want: [...requirements.want, ...wants],
      exclude: [...requirements.exclude, ...excludes],
    },
    preset,
    report: {
      enabled: true,
      applied,
      skipped,
      budgetSource,
      weightsSource: preset ? "profile" : "default",
    },
  };
}

export interface PersonalizationRequest {
  intent: Intent;
  requirements: RequirementSet;
  category: Category;
  weightsProvided: boolean;
  personalize: boolean;
}

export interface ResolvedPersonalization extends PersonalizationResult {
  warning: string | null;
}

/**
 * Session- and storage-aware wrapper around personalizeRequest. Never
 * throws for missing users or unreadable profiles: anonymous and
 * opted-out requests get an honest disabled report, and an unreadable
 * profile degrades to unpersonalized with a warning.
 */
export async function resolvePersonalization(
  request: Request,
  opts: PersonalizationRequest,
  store: MemoryStore = new FileMemoryStore(),
): Promise<ResolvedPersonalization> {
  const disabled = (
    reason: PersonalizationDisabledReason,
    warning: string | null = null,
  ): ResolvedPersonalization => ({
    intent: opts.intent,
    requirements: opts.requirements,
    preset: null,
    report: {
      enabled: false,
      reason,
      applied: [],
      skipped: [],
      budgetSource: opts.intent.budgetInr?.max != null ? "query" : "none",
      weightsSource: "default",
    },
    warning,
  });
  if (!opts.personalize) {
    return disabled("opted-out");
  }
  const user = sessionUserFromRequest(request);
  if (!user) {
    return disabled("signed-out");
  }
  let profile;
  try {
    profile = await store.getProfile(user.sub);
  } catch (error) {
    if (error instanceof StoredDataError) {
      return disabled(
        "unreadable",
        "Saved preferences couldn't be read; continuing without them.",
      );
    }
    throw error;
  }
  if (!profile) {
    return disabled("no-profile");
  }
  return {
    ...personalizeRequest({
      profile,
      category: opts.category,
      intent: opts.intent,
      requirements: opts.requirements,
      weightsProvided: opts.weightsProvided,
    }),
    warning: null,
  };
}
