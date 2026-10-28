import { z } from "zod";
import type { ConflictRecord, Product } from "../products/schema";
import { isProductUrl } from "../search/adapter";

export const EvidenceStatusSchema = z.enum([
  "verified",
  "observed",
  "missing",
  "conflicting",
]);
export type EvidenceStatus = z.infer<typeof EvidenceStatusSchema>;

export interface EvidenceSource {
  url: string;
  retrievedAt: string;
}

export interface AttributeEvidence {
  status: EvidenceStatus;
  detail?: string;
  sources: EvidenceSource[];
}

export interface ProductEvidence {
  productId: string;
  price: AttributeEvidence;
  rating: AttributeEvidence;
  specs: AttributeEvidence;
  identity: AttributeEvidence;
  stale: boolean;
}

export function isStale(isoDate: string, maxAgeDays = 7): boolean {
  const time = Date.parse(isoDate);
  if (!Number.isFinite(time)) {
    return true;
  }
  return Date.now() - time > maxAgeDays * 24 * 60 * 60 * 1000;
}

function inr(value: number): string {
  return `₹${value.toLocaleString("en-IN")}`;
}

export function buildProductEvidence(
  product: Product,
  conflicts: ConflictRecord[],
): ProductEvidence {
  const self = [{ url: product.url, retrievedAt: product.retrievedAt }];
  const priceConflict = conflicts.find(
    (c) => c.productId === product.id && c.field === "price",
  );
  const ratingConflict = conflicts.find(
    (c) => c.productId === product.id && c.field === "rating",
  );
  return {
    productId: product.id,
    price: priceConflict
      ? {
          status: "conflicting",
          detail: `Conflicting prices observed: ${priceConflict.values.map((v) => inr(v)).join(" vs ")}`,
          sources: self,
        }
      : product.priceInr == null
        ? {
            status: "missing",
            detail: "No price found on the retailer page.",
            sources: self,
          }
        : product.priceEvidence === "repeated"
          ? {
              status: "verified",
              detail: "Price corroborated across the retailer page.",
              sources: self,
            }
          : {
              status: "observed",
              detail: "Price seen once; treat as unverified.",
              sources: self,
            },
    rating: ratingConflict
      ? {
          status: "conflicting",
          detail: `Conflicting ratings observed: ${ratingConflict.values.join(" vs ")}`,
          sources: self,
        }
      : product.rating == null
        ? {
            status: "missing",
            detail: "No rating found on the retailer page.",
            sources: self,
          }
        : product.rating.count != null
          ? {
              status: "verified",
              detail: "Rating with ratings count from the retailer page.",
              sources: self,
            }
          : {
              status: "observed",
              detail: "Rating value without a count.",
              sources: self,
            },
    specs: {
      status: "missing",
      detail: "Structured specifications are not extracted in this phase.",
      sources: self,
    },
    identity: isProductUrl(product.url, product.sourceId)
      ? {
          status: "verified",
          detail: "Canonical product-page URL.",
          sources: self,
        }
      : {
          status: "observed",
          detail: "Non-canonical URL; identity matched by title.",
          sources: self,
        },
    stale:
      (product.priceSeenAt != null && isStale(product.priceSeenAt)) ||
      isStale(product.retrievedAt),
  };
}

export type ConfidenceLevel = "high" | "medium" | "low";

export interface ConfidenceAssessment {
  score: number;
  level: ConfidenceLevel;
  gaps: string[];
}

export const CONFIDENCE_HIGH = 70;
export const CONFIDENCE_MEDIUM = 45;

function attrScore(status: EvidenceStatus): number {
  return status === "verified" ? 1 : status === "observed" ? 0.5 : 0;
}

export function assessConfidence(
  products: Product[],
  evidence: Map<string, ProductEvidence>,
): ConfidenceAssessment {
  if (products.length === 0) {
    return { score: 0, level: "low", gaps: ["No products to assess."] };
  }
  let priceSum = 0;
  let ratingSum = 0;
  let identitySum = 0;
  let staleCount = 0;
  let conflictCount = 0;
  for (const product of products) {
    const ev = evidence.get(product.id);
    if (!ev) {
      continue;
    }
    priceSum += attrScore(ev.price.status);
    ratingSum += attrScore(ev.rating.status);
    identitySum += attrScore(ev.identity.status);
    if (ev.stale) {
      staleCount += 1;
    }
    if (
      ev.price.status === "conflicting" ||
      ev.rating.status === "conflicting"
    ) {
      conflictCount += 1;
    }
  }
  const n = products.length;
  const merchants = new Set(products.map((p) => p.sourceId)).size;
  const score = Math.round(
    100 *
      (0.3 * (priceSum / n) +
        0.15 * (ratingSum / n) +
        0.15 * Math.min(1, merchants / 3) +
        0.1 * (1 - staleCount / n) +
        0.15 * (identitySum / n) +
        0.15 * (1 - conflictCount / n)),
  );
  const level: ConfidenceLevel =
    score >= CONFIDENCE_HIGH
      ? "high"
      : score >= CONFIDENCE_MEDIUM
        ? "medium"
        : "low";
  const gaps: string[] = [];
  const missingPrice = products.filter((p) => {
    const status = evidence.get(p.id)?.price.status;
    return status === "missing" || status === "conflicting";
  }).length;
  if (missingPrice > 0) {
    gaps.push(`Verified prices missing for ${missingPrice} of ${n} top picks.`);
  }
  const missingRating = products.filter(
    (p) => evidence.get(p.id)?.rating.status === "missing",
  ).length;
  if (missingRating > 0) {
    gaps.push(`No ratings found for ${missingRating} of ${n} top picks.`);
  }
  if (conflictCount > 0) {
    gaps.push(
      `${conflictCount} conflicting attribute${conflictCount === 1 ? "" : "s"} unresolved.`,
    );
  }
  if (staleCount > 0) {
    gaps.push(`${staleCount} stale record${staleCount === 1 ? "" : "s"}.`);
  }
  if (merchants < 2) {
    gaps.push("All picks come from a single merchant.");
  }
  return { score, level, gaps: gaps.slice(0, 3) };
}
