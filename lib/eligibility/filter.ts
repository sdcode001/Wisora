import type { Intent } from "../intent/types";
import type { Product } from "../products/schema";
import type {
  Requirement,
  RequirementKind,
  RequirementSet,
} from "../requirements/types";
import { formatInr } from "../text/format";
import { contentTokens } from "../text/tokens";

export type RequirementCheckStatus = "met" | "not-met" | "unknown";

export interface RequirementCheck {
  key: string;
  label: string;
  kind: RequirementKind;
  status: RequirementCheckStatus;
}

export interface ExcludedProduct {
  productId: string;
  title: string;
  merchant: string;
  reasons: string[];
}

export interface EligibilityResult {
  eligible: Product[];
  excluded: ExcludedProduct[];
  checks: Record<string, RequirementCheck[]>;
}

export const OVER_BUDGET_TOLERANCE = 1.25;

interface SpecNumber {
  value: number;
  dimension: string;
}

const SPEC_NUMBER_RE =
  /(\d+(?:\.\d+)?)\s*(tb|gb|mb|inch|inches|in\b|″|"|ghz|mhz|mp|mah|watts?|w\b|kg|g\b)/gi;

const COMPONENT_WORDS = [
  "ram",
  "memory",
  "rom",
  "storage",
  "ssd",
  "hdd",
  "display",
  "screen",
  "battery",
  "camera",
  "processor",
  "cpu",
  "gpu",
];

function normalizeSpec(value: number, unit: string): SpecNumber | null {
  const u = unit.toLowerCase();
  if (u === "tb") {
    return { value: value * 1024 * 1024, dimension: "storage" };
  }
  if (u === "gb") {
    return { value: value * 1024, dimension: "storage" };
  }
  if (u === "mb") {
    return { value, dimension: "storage" };
  }
  if (u === "inch" || u === "inches" || u === "in" || u === "″" || u === '"') {
    return { value, dimension: "display" };
  }
  if (u === "ghz") {
    return { value: value * 1000, dimension: "clock" };
  }
  if (u === "mhz") {
    return { value, dimension: "clock" };
  }
  if (u === "mp") {
    return { value, dimension: "camera" };
  }
  if (u === "mah") {
    return { value, dimension: "battery" };
  }
  if (u === "watt" || u === "watts" || u === "w") {
    return { value, dimension: "power" };
  }
  if (u === "kg") {
    return { value: value * 1000, dimension: "mass" };
  }
  if (u === "g") {
    return { value, dimension: "mass" };
  }
  return null;
}

function specNumbersIn(text: string): SpecNumber[] {
  const out: SpecNumber[] = [];
  SPEC_NUMBER_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SPEC_NUMBER_RE.exec(text)) !== null && out.length < 20) {
    const normalized = normalizeSpec(
      Number.parseFloat(match[1] ?? "NaN"),
      match[2] ?? "",
    );
    if (normalized && Number.isFinite(normalized.value)) {
      out.push(normalized);
    }
  }
  return out;
}

function numbersNearWord(
  text: string,
  word: string,
  radius = 20,
): SpecNumber[] {
  const out: SpecNumber[] = [];
  const re = new RegExp(`\\b${word}s?\\b`, "gi");
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null && out.length < 20) {
    const start = Math.max(0, (match.index ?? 0) - radius);
    const end = (match.index ?? 0) + match[0].length + radius;
    out.push(...specNumbersIn(text.slice(start, end)));
  }
  return out;
}

export function matchRequirement(
  req: Requirement,
  productText: string,
): RequirementCheckStatus {
  const reqNumbers = specNumbersIn(req.label);
  if (reqNumbers.length > 0) {
    // Numeric requirements use minimum semantics: any same-dimension value
    // at or above the requirement satisfies it.
    const target = reqNumbers[0] as SpecNumber;
    const component =
      COMPONENT_WORDS.find((word) =>
        new RegExp(`\\b${word}s?\\b`, "i").test(req.label),
      ) ?? null;
    const candidates = (
      component
        ? numbersNearWord(productText, component)
        : specNumbersIn(productText)
    ).filter((n) => n.dimension === target.dimension);
    if (candidates.length === 0) {
      return "unknown";
    }
    return candidates.some((n) => n.value >= target.value)
      ? "met"
      : "not-met";
  }
  const tokens = contentTokens(req.label);
  if (tokens.size === 0) {
    return "unknown";
  }
  const haystack = contentTokens(productText);
  for (const token of tokens) {
    if (!haystack.has(token)) {
      return "unknown";
    }
  }
  return "met";
}

export interface FilterOptions {
  allowOverBudget?: boolean;
}

export function filterEligible(
  products: Product[],
  requirements: RequirementSet,
  intent: Intent,
  options: FilterOptions = {},
): EligibilityResult {
  const eligible: Product[] = [];
  const excluded: ExcludedProduct[] = [];
  const checks: Record<string, RequirementCheck[]> = {};
  const max = intent.budgetInr?.max;
  const all = [
    ...requirements.must,
    ...requirements.want,
    ...requirements.exclude,
  ];
  for (const product of products) {
    const text = `${product.title} ${product.snippet}`;
    const productChecks = all.map((req) => ({
      key: req.key,
      label: req.label,
      kind: req.kind,
      status: matchRequirement(req, text),
    }));
    checks[product.id] = productChecks;
    const reasons: string[] = [];
    if (max != null && product.priceInr != null) {
      const withinTolerance =
        options.allowOverBudget === true &&
        product.priceInr <= max * OVER_BUDGET_TOLERANCE;
      if (product.priceInr > max && !withinTolerance) {
        reasons.push(
          `Over budget: ${formatInr(product.priceInr)} exceeds ${formatInr(max)} maximum`,
        );
      }
    }
    for (const check of productChecks) {
      if (check.kind === "exclude" && check.status === "met") {
        reasons.push(`Excluded feature present: ${check.label}`);
      }
      if (check.kind === "must" && check.status === "not-met") {
        reasons.push(`Fails requirement: ${check.label}`);
      }
    }
    if (reasons.length > 0) {
      excluded.push({
        productId: product.id,
        title: product.title,
        merchant: product.merchant,
        reasons,
      });
    } else {
      eligible.push(product);
    }
  }
  return { eligible, excluded, checks };
}
