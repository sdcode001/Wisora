import { createHash } from "node:crypto";
import { z } from "zod";
import { CategorySchema, type Category } from "../../config/sources";
import { CATEGORY_LABELS } from "../requirements/types";
import { formatInr } from "../text/format";
import { contentTokens } from "../text/tokens";
import {
  applyCategoryPatch,
  applyGeneralPatch,
  GeneralPreferencesPatchSchema,
  parseCategoryPatch,
  type CategoryPreferencesPatch,
  type GeneralPreferencesPatch,
  type UserProfile,
} from "./profile";
import type { DecisionRecord, Feedback, FeedbackProduct } from "./records";

/** Detection thresholds (v1 heuristics — every proposal needs confirmation). */
export const MIN_BRAND_SIGNALS = 1;
export const MIN_BUDGET_DECISIONS = 2;
/** Observed budget maximums within this ratio count as one pattern. */
export const BUDGET_BAND_RATIO = 1.25;

export const ProposalStatusSchema = z.enum([
  "pending",
  "confirmed",
  "rejected",
]);
export type ProposalStatus = z.infer<typeof ProposalStatusSchema>;

export const ProposalKindSchema = z.enum(["general", "category"]);
export type ProposalKind = z.infer<typeof ProposalKindSchema>;

const ProposalBase = z.object({
  id: z.string().min(1).max(64),
  createdAt: z.string().min(1),
  status: ProposalStatusSchema,
  decidedAt: z.string().min(1).optional(),
  kind: ProposalKindSchema,
  category: CategorySchema.optional(),
  patch: z.record(z.string(), z.unknown()),
  reason: z.string().trim().min(1).max(300),
  evidence: z.array(z.string().min(1).max(64)).max(10),
  fingerprint: z.string().min(1).max(64),
});

/** Validate a proposal patch against its kind (and category, if any). */
export function parseProposalPatch(
  kind: ProposalKind,
  category: Category | undefined,
  patch: unknown,
): GeneralPreferencesPatch | CategoryPreferencesPatch | null {
  if (kind === "general") {
    const parsed = GeneralPreferencesPatchSchema.safeParse(patch);
    return parsed.success ? parsed.data : null;
  }
  if (!category) {
    return null;
  }
  const parsed = parseCategoryPatch(category, patch);
  return parsed.success ? parsed.data : null;
}

export const ProposalSchema = ProposalBase.refine(
  (proposal) =>
    proposal.kind !== "category" || proposal.category !== undefined,
  { message: "category proposals require a category" },
)
  .refine(
    (proposal) =>
      proposal.kind !== "general" || proposal.category === undefined,
    { message: "general proposals must not carry a category" },
  )
  .refine(
    (proposal) =>
      parseProposalPatch(proposal.kind, proposal.category, proposal.patch) !==
      null,
    { message: "patch does not match the proposal kind" },
  );
export type Proposal = z.infer<typeof ProposalSchema>;

/** Detection output; the store stamps id/createdAt/status on save. */
export interface NewProposal {
  kind: ProposalKind;
  category?: Category;
  patch: Record<string, unknown>;
  reason: string;
  evidence: string[];
  fingerprint: string;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(
      ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0),
    );
    return `{${entries
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * Identity of a proposal's content. Confirmed/rejected proposals keep
 * their fingerprints so detection never re-proposes a decided question.
 */
export function fingerprintFor(
  kind: ProposalKind,
  category: Category | undefined,
  patch: Record<string, unknown>,
): string {
  return createHash("sha256")
    .update(`${kind}:${category ?? "-"}:${stableStringify(patch)}`, "utf8")
    .digest("hex")
    .slice(0, 32);
}

export class ProposalError extends Error {}

/**
 * Apply a (possibly user-edited) proposal patch to a profile, stamping
 * provenance "confirmed". Pure; throws ProposalError on invalid patches.
 */
export function applyProposal(
  profile: UserProfile,
  proposal: Pick<Proposal, "kind" | "category" | "patch">,
  editedPatch?: unknown,
  now: string = new Date().toISOString(),
): UserProfile {
  const raw = editedPatch !== undefined ? editedPatch : proposal.patch;
  const parsed = parseProposalPatch(proposal.kind, proposal.category, raw);
  if (!parsed || Object.keys(parsed).length === 0) {
    throw new ProposalError("Proposal patch is invalid or empty.");
  }
  if (proposal.kind === "general") {
    return {
      ...profile,
      general: {
        value: applyGeneralPatch(
          profile.general.value,
          parsed as GeneralPreferencesPatch,
        ),
        updatedAt: now,
        provenance: "confirmed",
      },
    };
  }
  const category = proposal.category;
  if (!category) {
    throw new ProposalError("Category proposal is missing its category.");
  }
  const categories = { ...profile.categories };
  categories[category] = {
    value: applyCategoryPatch(
      profile.categories[category]?.value,
      category,
      parsed as CategoryPreferencesPatch,
    ),
    updatedAt: now,
    provenance: "confirmed",
  };
  return { ...profile, categories };
}

/**
 * Heuristic brand guess: the first word of a listing title when it looks
 * like a name (capitalized, 3+ alphanumerics). Wrong guesses are safe —
 * proposals always need user confirmation before they stick.
 */
function brandWord(title: string): string | null {
  const first = title.trim().split(/\s+/)[0] ?? "";
  if (!/^[A-Z]/.test(first)) {
    return null;
  }
  const cleaned = first.replace(/[^A-Za-z0-9]/g, "");
  // Reuse listing token rules: stopwords and short fragments never count.
  if (contentTokens(cleaned).size === 0) {
    return null;
  }
  return cleaned;
}

function countBrand(
  counts: Map<string, { display: string; ids: string[] }>,
  product: FeedbackProduct | null | undefined,
  feedbackId: string,
): void {
  if (!product) {
    return;
  }
  const word = brandWord(product.title);
  if (!word) {
    return;
  }
  const key = word.toLowerCase();
  const entry = counts.get(key) ?? { display: word, ids: [] };
  entry.ids.push(feedbackId);
  counts.set(key, entry);
}

export interface DetectionInput {
  profile: UserProfile;
  decisions: DecisionRecord[];
  feedback: Feedback[];
  existing: Proposal[];
}

/**
 * Find candidate preferences worth asking about. Never writes to the
 * profile and never resurfaces a decided proposal: callers persist the
 * returned pendings and let the user confirm, edit, or reject each one.
 */
export function detectProposals(input: DetectionInput): NewProposal[] {
  const out: NewProposal[] = [];
  const seen = new Set(input.existing.map((proposal) => proposal.fingerprint));
  const general = input.profile.general.value;
  const preferredLower = new Set(
    general.preferredBrands.map((brand) => brand.toLowerCase()),
  );
  const avoidedLower = new Set(
    general.avoidedBrands.map((brand) => brand.toLowerCase()),
  );

  const propose = (
    kind: ProposalKind,
    category: Category | undefined,
    patch: Record<string, unknown>,
    reason: string,
    evidence: string[],
  ): void => {
    const fingerprint = fingerprintFor(kind, category, patch);
    if (seen.has(fingerprint)) {
      return;
    }
    seen.add(fingerprint);
    out.push({
      kind,
      ...(category ? { category } : {}),
      patch,
      reason,
      evidence: evidence.slice(0, 10),
      fingerprint,
    });
  };

  const preferCounts = new Map<string, { display: string; ids: string[] }>();
  const avoidCounts = new Map<string, { display: string; ids: string[] }>();
  for (const item of input.feedback) {
    countBrand(preferCounts, item.preferred, item.id);
    countBrand(preferCounts, item.purchased, item.id);
    countBrand(avoidCounts, item.rejected, item.id);
  }
  for (const [key, info] of preferCounts) {
    if (
      info.ids.length >= MIN_BRAND_SIGNALS &&
      !preferredLower.has(key) &&
      !avoidedLower.has(key)
    ) {
      propose(
        "general",
        undefined,
        { preferredBrands: [...general.preferredBrands, info.display] },
        `You preferred ${info.display} in ${info.ids.length} recent decision${info.ids.length === 1 ? "" : "s"}.`,
        info.ids,
      );
    }
  }
  for (const [key, info] of avoidCounts) {
    if (
      info.ids.length >= MIN_BRAND_SIGNALS &&
      !avoidedLower.has(key) &&
      !preferredLower.has(key)
    ) {
      propose(
        "general",
        undefined,
        { avoidedBrands: [...general.avoidedBrands, info.display] },
        `You rejected ${info.display} in ${info.ids.length} recent decision${info.ids.length === 1 ? "" : "s"}.`,
        info.ids,
      );
    }
  }

  const budgetsByCategory = new Map<Category, { max: number; id: string }[]>();
  for (const decision of input.decisions) {
    if (decision.budgetInr?.max != null) {
      const entries = budgetsByCategory.get(decision.category) ?? [];
      entries.push({ max: decision.budgetInr.max, id: decision.id });
      budgetsByCategory.set(decision.category, entries);
    }
  }
  for (const [category, entries] of budgetsByCategory) {
    if (input.profile.categories[category]?.value.budgetInr != null) {
      continue;
    }
    if (entries.length < MIN_BUDGET_DECISIONS) {
      continue;
    }
    const maxes = entries.map((entry) => entry.max);
    const low = Math.min(...maxes);
    const high = Math.max(...maxes);
    if (high / low > BUDGET_BAND_RATIO) {
      continue;
    }
    const label = CATEGORY_LABELS[category].toLowerCase();
    propose(
      "category",
      category,
      { budgetInr: { max: high } },
      `Your recent ${label} searches budget up to ${formatInr(high)}.`,
      entries.map((entry) => entry.id),
    );
  }

  return out;
}
