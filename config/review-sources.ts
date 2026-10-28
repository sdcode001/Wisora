import { z } from "zod";

export const ReviewSourceTypeSchema = z.enum([
  "retailer",
  "editorial",
  "forum",
  "manufacturer",
]);
export type ReviewSourceType = z.infer<typeof ReviewSourceTypeSchema>;

export const ReviewSourceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  domain: z.string().min(1),
  type: ReviewSourceTypeSchema,
  enabled: z.boolean(),
});
export type ReviewSource = z.infer<typeof ReviewSourceSchema>;

const ReviewSourcesSchema = z.array(ReviewSourceSchema);

// Single source of truth for review sources. Edit here to add, remove,
// enable, or disable a source — no other file duplicates this list.
// Retailer review sections and manufacturer pages are often unextractable;
// those types exist for attribution when content is reachable, not as a
// promise of coverage.
export const REVIEW_SOURCES: ReviewSource[] = ReviewSourcesSchema.parse([
  {
    id: "digit-in",
    name: "Digit.in",
    domain: "digit.in",
    type: "editorial",
    enabled: true,
  },
  {
    id: "91mobiles",
    name: "91mobiles",
    domain: "91mobiles.com",
    type: "editorial",
    enabled: true,
  },
  {
    id: "smartprix",
    name: "Smartprix",
    domain: "smartprix.com",
    type: "editorial",
    enabled: true,
  },
  {
    id: "gadgets360",
    name: "Gadgets 360",
    domain: "gadgets360.com",
    type: "editorial",
    enabled: true,
  },
  {
    id: "gsmarena",
    name: "GSMArena",
    domain: "gsmarena.com",
    type: "editorial",
    enabled: true,
  },
  {
    id: "notebookcheck",
    name: "Notebookcheck",
    domain: "notebookcheck.net",
    type: "editorial",
    enabled: true,
  },
  {
    id: "rtings",
    name: "RTINGS",
    domain: "rtings.com",
    type: "editorial",
    enabled: true,
  },
  {
    id: "mouthshut",
    name: "MouthShut",
    domain: "mouthshut.com",
    type: "forum",
    enabled: true,
  },
  {
    id: "reddit",
    name: "Reddit",
    domain: "reddit.com",
    type: "forum",
    enabled: true,
  },
]);

export function enabledReviewSources(
  overrides?: Record<string, boolean>,
): ReviewSource[] {
  return REVIEW_SOURCES.filter((s) => overrides?.[s.id] ?? s.enabled);
}
