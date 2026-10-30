import { expect, test } from "vitest";
import { extractRupeeAmounts, selectObservedPrice } from "./extract";

test("extracts rupee amounts in ₹/Rs/INR forms", () => {
  expect(extractRupeeAmounts("Price ₹45,999 only")).toEqual([45999]);
  expect(extractRupeeAmounts("Rs. 1200 and INR 999.50")).toEqual([1200, 1000]);
  expect(extractRupeeAmounts("no prices here")).toEqual([]);
  expect(extractRupeeAmounts("₹0 and ₹99999999 out of range")).toEqual([]);
});

test("selects the most frequent amount with evidence", () => {
  expect(selectObservedPrice([])).toBeNull();
  expect(selectObservedPrice([45999])).toEqual({
    priceInr: 45999,
    evidence: "single",
    candidates: 1,
  });
  // Selling price repeats; MRP appears once.
  expect(selectObservedPrice([45999, 59999, 45999])).toEqual({
    priceInr: 45999,
    evidence: "repeated",
    candidates: 2,
  });
});
