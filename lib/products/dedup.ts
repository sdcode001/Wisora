import type { ConflictRecord, Product } from "./schema";

export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\u0900-\u097F\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function evidenceTier(product: Product): number {
  return product.priceEvidence === "repeated"
    ? 2
    : product.priceEvidence === "single"
      ? 1
      : 0;
}

function betterOf(a: Product, b: Product): Product {
  const tier = evidenceTier(b) - evidenceTier(a);
  if (tier !== 0) {
    return tier > 0 ? b : a;
  }
  return b.score > a.score ? b : a;
}

export function dedupeProducts(products: Product[]): {
  products: Product[];
  removed: number;
  conflicts: ConflictRecord[];
} {
  const byId = new Map<string, Product>();
  const conflicts: ConflictRecord[] = [];
  for (const product of products) {
    const existing = byId.get(product.id);
    if (!existing) {
      byId.set(product.id, product);
      continue;
    }
    if (
      existing.priceInr != null &&
      product.priceInr != null &&
      existing.priceInr !== product.priceInr
    ) {
      conflicts.push({
        productId: product.id,
        field: "price",
        values: [existing.priceInr, product.priceInr].sort((a, b) => a - b),
      });
    }
    const existingRating = existing.rating?.value;
    const rating = product.rating?.value;
    if (
      existingRating != null &&
      rating != null &&
      existingRating !== rating
    ) {
      conflicts.push({
        productId: product.id,
        field: "rating",
        values: [existingRating, rating].sort((a, b) => a - b),
      });
    }
    byId.set(product.id, betterOf(existing, product));
  }
  let removed = products.length - byId.size;
  const seen = new Map<string, Product>();
  const ranked = [...byId.values()].sort((a, b) => b.score - a.score);
  for (const product of ranked) {
    const key = `${normalizeTitle(product.title)}|${product.priceInr ?? "noprice"}`;
    if (!seen.has(key)) {
      seen.set(key, product);
    } else {
      removed += 1;
    }
  }
  return { products: [...seen.values()], removed, conflicts };
}
