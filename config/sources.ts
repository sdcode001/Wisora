import { z } from "zod";

export const CategorySchema = z.enum([
  "electronics",
  "fashion",
  "footwear",
  "beauty",
  "home-kitchen",
  "general",
]);
export type Category = z.infer<typeof CategorySchema>;

export const SearchMethodSchema = z.enum([
  "search-api",
  "direct",
  "unavailable",
]);
export type SearchMethod = z.infer<typeof SearchMethodSchema>;

export const ShoppingSourceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  baseUrl: z.string().url(),
  domain: z.string().min(1),
  categories: z.array(CategorySchema).min(1),
  enabled: z.boolean(),
  searchMethod: SearchMethodSchema,
  searchPath: z.string().optional(),
});
export type ShoppingSource = z.infer<typeof ShoppingSourceSchema>;

const SourcesSchema = z.array(ShoppingSourceSchema);

// Single source of truth for shopping sources. Edit here to add, remove,
// enable, or disable a source — no other file duplicates this list.
export const SOURCES: ShoppingSource[] = SourcesSchema.parse([
  {
    id: "amazon-in",
    name: "Amazon India",
    baseUrl: "https://www.amazon.in/",
    domain: "amazon.in",
    categories: [
      "electronics",
      "fashion",
      "footwear",
      "beauty",
      "home-kitchen",
      "general",
    ],
    enabled: true,
    searchMethod: "search-api",
  },
  {
    id: "flipkart",
    name: "Flipkart",
    baseUrl: "https://www.flipkart.com/",
    domain: "flipkart.com",
    categories: [
      "electronics",
      "fashion",
      "footwear",
      "beauty",
      "home-kitchen",
      "general",
    ],
    enabled: true,
    searchMethod: "search-api",
  },
  {
    id: "shopclues",
    name: "ShopClues",
    baseUrl: "https://www.shopclues.com/",
    domain: "shopclues.com",
    categories: [
      "electronics",
      "fashion",
      "footwear",
      "beauty",
      "home-kitchen",
      "general",
    ],
    enabled: true,
    searchMethod: "search-api",
  },
  {
    id: "snapdeal",
    name: "Snapdeal",
    baseUrl: "https://www.snapdeal.com/",
    domain: "snapdeal.com",
    categories: [
      "electronics",
      "fashion",
      "footwear",
      "beauty",
      "home-kitchen",
      "general",
    ],
    enabled: true,
    searchMethod: "search-api",
  },
  {
    id: "myntra",
    name: "Myntra",
    baseUrl: "https://www.myntra.com/",
    domain: "myntra.com",
    categories: ["fashion", "footwear", "beauty"],
    enabled: true,
    searchMethod: "search-api",
  },
  {
    id: "ajio",
    name: "AJIO",
    baseUrl: "https://www.ajio.com/",
    domain: "ajio.com",
    categories: ["fashion", "footwear", "beauty"],
    enabled: true,
    searchMethod: "search-api",
  },
  {
    id: "tata-cliq",
    name: "Tata CLiQ",
    baseUrl: "https://www.tatacliq.com/",
    domain: "tatacliq.com",
    categories: ["fashion", "footwear", "beauty"],
    enabled: true,
    searchMethod: "search-api",
  },
  {
    id: "nykaa-fashion",
    name: "Nykaa Fashion",
    baseUrl: "https://www.nykaafashion.com/",
    domain: "nykaafashion.com",
    categories: ["fashion", "footwear", "beauty"],
    enabled: true,
    searchMethod: "search-api",
  },
  {
    id: "newme-fashion",
    name: "NewMe",
    baseUrl: "https://newme.asia/",
    domain: "newme.asia",
    categories: ["fashion"],
    enabled: true,
    searchMethod: "search-api",
  },
]);

export function enabledSourcesFor(
  category: Category,
  overrides?: Record<string, boolean>,
): ShoppingSource[] {
  return SOURCES.filter(
    (s) =>
      s.categories.includes(category) &&
      (overrides?.[s.id] ?? s.enabled) &&
      s.searchMethod !== "unavailable",
  );
}
