import { expect, test } from "vitest";
import { extractImageUrl, extractRating, isProductUrl } from "./adapter";

test("extracts Amazon-style ratings", () => {
  expect(
    extractRating("4.3 out of 5 stars 12,345 global ratings"),
  ).toEqual({ value: 4.3, count: 12345 });
});

test("extracts Flipkart-style ratings", () => {
  expect(extractRating("4.1★ 2,340 Ratings & 156 Reviews")).toEqual({
    value: 4.1,
    count: 2340,
  });
});

test("rejects missing or out-of-range ratings", () => {
  expect(extractRating("No reviews yet for this product")).toBeUndefined();
  expect(extractRating("6 out of 5 stars")).toBeUndefined();
});

test("detects product pages per source", () => {
  expect(
    isProductUrl("https://www.amazon.in/dp/B0CX12ABC3", "amazon-in"),
  ).toBe(true);
  expect(
    isProductUrl("https://www.amazon.in/Laptops/b?node=1", "amazon-in"),
  ).toBe(false);
  expect(
    isProductUrl("https://www.flipkart.com/item/p/itm123", "flipkart"),
  ).toBe(true);
  expect(
    isProductUrl("https://www.flipkart.com/search?q=laptop", "flipkart"),
  ).toBe(false);
});

test("prefers product photos over site chrome and upscales Amazon images", () => {
  const text = [
    "![banner](https://m.media-amazon.com/images/G/31/Events/img25/banner._CB1_.jpg)",
    "![sprite](https://m.media-amazon.com/images/G/31/gno/sprites/nav-sprite.png)",
    "![thumb](https://m.media-amazon.com/images/I/31-IfVurYtL._SL75_.jpg)",
  ].join("\n");
  expect(extractImageUrl(text, "https://www.amazon.in/dp/X")).toBe(
    "https://m.media-amazon.com/images/I/31-IfVurYtL._SL1500_.jpg",
  );
});

test("upscales Flipkart and Myntra images, skips svg and data URIs", () => {
  const text = [
    "![icon](https://static-assets-web.flixcart.com/x/y/icon.svg)",
    "![inline](data:image/svg+xml;base64,AAA)",
    "![Image](https://rukminim2.flixcart.com/image/80/80/x/y/photo.jpeg?q=80)",
  ].join("\n");
  expect(extractImageUrl(text, "https://www.flipkart.com/p/1")).toBe(
    "https://rukminim2.flixcart.com/image/832/832/x/y/photo.jpeg?q=80",
  );
  expect(
    extractImageUrl("", "https://www.myntra.com/buy/1", [
      "https://constant.myntassets.com/web/assets/img/chevron-right.svg",
      "https://assets.myntassets.com/f_auto,h_150,q_auto:best,w_112/assets/images/2025/x.jpg",
    ]),
  ).toBe(
    "https://assets.myntassets.com/f_auto,h_1440,q_auto:best,w_1080/assets/images/2025/x.jpg",
  );
});

test("returns undefined when only chrome images exist", () => {
  expect(
    extractImageUrl(
      "![logo](https://example.com/logo.png)",
      "https://example.com/p/1",
    ),
  ).toBeUndefined();
});
