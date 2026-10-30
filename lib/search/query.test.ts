import { expect, test } from "vitest";
import {
  effectiveBudgetMax,
  searchTermsWithBudget,
} from "./query";

test("strict search keeps the stated max", () => {
  expect(effectiveBudgetMax({ max: 90000 }, false)).toBe(90000);
});

test("flexible search expands the max by 25%", () => {
  expect(effectiveBudgetMax({ max: 90000 }, true)).toBe(112500);
  expect(effectiveBudgetMax({ min: 1000, max: 5000 }, true)).toBe(6250);
});

test("no stated max means no effective max either way", () => {
  expect(effectiveBudgetMax(undefined, true)).toBeNull();
  expect(effectiveBudgetMax({ min: 1000 }, true)).toBeNull();
  expect(effectiveBudgetMax(undefined, false)).toBeNull();
});

test("strict search leaves query terms untouched", () => {
  expect(searchTermsWithBudget("laptop", 90000, false)).toBe("laptop");
});

test("flexible search appends the expanded ceiling", () => {
  expect(searchTermsWithBudget("laptop", 112500, true)).toBe(
    "laptop under ₹112500",
  );
});

test("flexible search without a max leaves terms untouched", () => {
  expect(searchTermsWithBudget("laptop", null, true)).toBe("laptop");
});

test("an existing price hint is never duplicated", () => {
  expect(searchTermsWithBudget("laptop under ₹90000", 112500, true)).toBe(
    "laptop under ₹90000",
  );
  expect(searchTermsWithBudget("shoes below Rs 5000", 6250, true)).toBe(
    "shoes below Rs 5000",
  );
});
