import { expect, test } from "vitest";
import { dedupeProducts } from "./dedup";
import { productIdFor, type Product } from "./schema";

const mk = (
  url: string,
  title: string,
  priceInr: number | undefined,
  sourceId: string,
  score: number,
): Product => ({
  id: productIdFor(url),
  title,
  url,
  sourceId,
  merchant: sourceId,
  snippet: "",
  score,
  priceInr,
  retrievedAt: "t",
});

test("merges same-listing and same-offer duplicates, keeps distinct prices", () => {
  const { products, removed } = dedupeProducts([
    mk("https://www.amazon.in/dp/B0CX12ABC3?ref=x", "Laptop X 16GB RAM 512GB", 45999, "amazon-in", 0.9),
    mk("https://www.amazon.in/dp/B0CX12ABC3?ref=y", "Laptop X 16GB RAM 512GB", 45999, "amazon-in", 0.5),
    mk("https://www.flipkart.com/laptop-x/p/itm1", "Laptop X 16GB RAM 512GB", 45999, "flipkart", 0.8),
    mk("https://www.flipkart.com/laptop-x/p/itm2", "Laptop X 16GB RAM 512GB", 47999, "flipkart", 0.7),
    mk("https://www.amazon.in/dp/B0OTHER123", "Laptop Y 8GB", undefined, "amazon-in", 0.6),
  ]);
  expect(products.map((p) => `${p.sourceId}:${p.priceInr ?? "-"}`)).toEqual([
    "amazon-in:45999",
    "flipkart:47999",
    "amazon-in:-",
  ]);
  expect(removed).toBe(2);
});
