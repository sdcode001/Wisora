import type { Product } from "./schema";

export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\u0900-\u097F\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function dedupeProducts(products: Product[]): {
  products: Product[];
  removed: number;
} {
  const byId = new Map<string, Product>();
  for (const product of products) {
    const existing = byId.get(product.id);
    if (!existing || product.score > existing.score) {
      byId.set(product.id, product);
    }
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
  return { products: [...seen.values()], removed };
}
