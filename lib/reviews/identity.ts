import { contentTokens } from "../text/tokens";
import type { Relevance } from "./types";

export interface ProductIdentity {
  /** Normalized alphanumeric model codes, e.g. "wh1000xm5", "12r". */
  modelTokens: string[];
  /** Longer content words for overlap fallback, e.g. "headphones". */
  nameTokens: string[];
}

const SPEC_TOKEN_RE = /^\d+(gb|mb|tb|inch|mp|mah|w|g|kg|h|hr|hrs|hz)$/;
// Bare connectivity generations and years carry no identity.
const GENERIC_TOKEN_RE = /^(4g|5g|20\d\d)$/;

function normalizeToken(token: string): string {
  return token.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function extractIdentity(title: string): ProductIdentity {
  const modelTokens: string[] = [];
  for (const raw of title.toLowerCase().split(/[^a-z0-9]+/)) {
    if (
      raw.length >= 3 &&
      /\d/.test(raw) &&
      /[a-z]/.test(raw) &&
      !SPEC_TOKEN_RE.test(raw) &&
      !GENERIC_TOKEN_RE.test(raw)
    ) {
      const normalized = normalizeToken(raw);
      if (normalized && !modelTokens.includes(normalized)) {
        modelTokens.push(normalized);
      }
    }
  }
  const nameTokens = [...contentTokens(title)]
    .filter((token) => token.length >= 4 && !modelTokens.includes(token))
    .slice(0, 10);
  return { modelTokens: modelTokens.slice(0, 6), nameTokens };
}

function tokenMatches(haystack: string, token: string): boolean {
  const lower = haystack.toLowerCase();
  if (lower.includes(token)) {
    return true;
  }
  // Separator-stripped match for codes like "wh-1000xm5", but only for
  // longer tokens where cross-word false positives are unlikely.
  if (token.length >= 5) {
    const stripped = lower.replace(/[^a-z0-9]/g, "");
    return stripped.includes(token);
  }
  return false;
}

export interface RelevanceInput {
  title: string;
  url: string;
  text: string;
}

export function gradeRelevance(
  identity: ProductIdentity,
  competingModels: string[],
  record: RelevanceInput,
): Relevance {
  const titleZone = `${record.title} ${record.url}`;
  const oursInTitle = identity.modelTokens.some((t) =>
    tokenMatches(titleZone, t),
  );
  const oursInText = identity.modelTokens.some((t) =>
    tokenMatches(record.text, t),
  );
  const rivalInTitle = competingModels.some((t) =>
    tokenMatches(record.title, t),
  );

  if (oursInTitle && !rivalInTitle) {
    return "exact";
  }
  if (oursInTitle && rivalInTitle) {
    // Comparison piece covering our model alongside another.
    return "likely";
  }
  if (oursInText && !rivalInTitle) {
    return "likely";
  }
  if (rivalInTitle) {
    return "irrelevant";
  }

  const haystack = `${record.title} ${record.text}`.toLowerCase();
  const overlap =
    identity.nameTokens.length === 0
      ? 0
      : identity.nameTokens.filter((t) => haystack.includes(t)).length /
        identity.nameTokens.length;
  if (identity.modelTokens.length === 0) {
    // No model code to anchor on (common in fashion): strong name overlap
    // is the best signal available.
    return overlap >= 0.6 ? "likely" : "uncertain";
  }
  if (overlap < 0.25 && record.text.length > 500) {
    return "irrelevant";
  }
  return "uncertain";
}
