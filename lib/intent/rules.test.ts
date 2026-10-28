import { expect, test } from "vitest";
import { analyzeIntent } from "./rules";

test("example prompts classify with budgets", () => {
  const laptop = analyzeIntent(
    "Find a laptop under ₹90,000 for .NET development.",
  );
  expect(laptop.category).toBe("electronics");
  expect(laptop.budgetInr).toEqual({ max: 90000 });

  const shoes = analyzeIntent("Suggest comfortable running shoes under ₹5,000.");
  expect(shoes.category).toBe("footwear");
  expect(shoes.budgetInr).toEqual({ max: 5000 });

  const phones = analyzeIntent(
    "Compare smartphones with excellent battery life under ₹30,000.",
  );
  expect(phones.category).toBe("electronics");
  expect(phones.budgetInr).toEqual({ max: 30000 });

  const skincare = analyzeIntent(
    "Find skincare products suitable for a simple daily routine.",
  );
  expect(skincare.category).toBe("beauty");
  expect(skincare.budgetInr).toBeUndefined();
});

test("4K is a resolution, not a price", () => {
  const tv = analyzeIntent("4K TV under 60000");
  expect(tv.category).toBe("electronics");
  expect(tv.budgetInr).toEqual({ max: 60000 });
});

test("between sets a price range", () => {
  const mixer = analyzeIntent("mixer grinder between 3000 and 5000");
  expect(mixer.category).toBe("home-kitchen");
  expect(mixer.budgetInr).toEqual({ min: 3000, max: 5000 });
});

test("ambiguous queries fall back to general with low confidence", () => {
  const gift = analyzeIntent("gift for mom");
  expect(gift.category).toBe("general");
  expect(gift.categoryConfidence).toBe("low");
});

test("flexible budget phrasings", () => {
  const shoes = analyzeIntent("Find me good running shoe between 5000 to 10000");
  expect(shoes.category).toBe("footwear");
  expect(shoes.budgetInr).toEqual({ min: 5000, max: 10000 });
  expect(shoes.searchTerms).toBe("Find me good running shoe");

  expect(analyzeIntent("laptop between 50k to 1 lakh").budgetInr).toEqual({
    min: 50000,
    max: 100000,
  });
  expect(analyzeIntent("shoes under 1.5 lac").budgetInr).toEqual({ max: 150000 });
  expect(analyzeIntent("phone till 30000").budgetInr).toEqual({ max: 30000 });
  expect(analyzeIntent("headphones for no more than ₹20000").budgetInr).toEqual({
    max: 20000,
  });
  expect(analyzeIntent("watch between 5 to 10 lakhs").budgetInr).toEqual({
    min: 500000,
    max: 1000000,
  });
  expect(analyzeIntent("headphones ₹5000-10000").budgetInr).toEqual({
    min: 5000,
    max: 10000,
  });
  expect(analyzeIntent("camera from 40000 to 60000").budgetInr).toEqual({
    min: 40000,
    max: 60000,
  });
  expect(analyzeIntent("laptop 50000 rupees").budgetInr).toEqual({ max: 50000 });
});
