import { expect, test } from "vitest";
import { matchRequirement } from "../eligibility/filter";
import type { Intent } from "../intent/types";
import { DEFAULT_WEIGHTS } from "../recommend/weights";
import type { RequirementSet } from "../requirements/types";
import {
  personalizeRequest,
  STORED_WANT_IMPORTANCE,
  weightPresetFor,
  type PersonalizationInput,
} from "./personalize";
import {
  applyCategoryPatch,
  applyGeneralPatch,
  createDefaultProfile,
  type DecisionPriority,
} from "./profile";

const INTENT: Intent = {
  query: "laptop for coding",
  category: "electronics",
  categoryConfidence: "high",
  searchTerms: "laptop coding",
};

const REQUIREMENTS: RequirementSet = {
  category: "electronics",
  must: [],
  want: [],
  exclude: [],
  unanswered: [],
};

function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) {
    expect.unreachable(`expected ${what}`);
  }
  return value;
}

function inputWith(
  patch: (profile: ReturnType<typeof createDefaultProfile>) => void,
  overrides: Partial<PersonalizationInput> = {},
): PersonalizationInput {
  const profile = createDefaultProfile("user-1");
  patch(profile);
  return {
    profile,
    category: "electronics",
    intent: INTENT,
    requirements: REQUIREMENTS,
    weightsProvided: false,
    ...overrides,
  };
}

test("every decision-priority preset sums to 100", () => {
  const priorities: DecisionPriority[] = [
    "lowest-price",
    "best-value",
    "performance",
    "durability",
    "premium",
  ];
  for (const priority of priorities) {
    const weights = weightPresetFor(priority);
    expect(
      weights.price + weights.relevance + weights.evidence + weights.wants,
    ).toBe(100);
  }
  expect(weightPresetFor("lowest-price").price).toBeGreaterThan(
    DEFAULT_WEIGHTS.price,
  );
  expect(weightPresetFor("premium").price).toBeLessThan(DEFAULT_WEIGHTS.price);
});

test("an empty profile changes nothing but reports enabled", () => {
  const result = personalizeRequest(inputWith(() => {}));
  expect(result.report.enabled).toBe(true);
  expect(result.report.applied).toEqual([]);
  expect(result.report.skipped).toEqual([]);
  expect(result.report.budgetSource).toBe("none");
  expect(result.report.weightsSource).toBe("default");
  expect(result.preset).toBeNull();
  expect(result.intent).toBe(INTENT);
  expect(result.requirements.want).toEqual([]);
  expect(result.requirements.exclude).toEqual([]);
});

test("a stored budget fills an unstated budget", () => {
  const result = personalizeRequest(
    inputWith((profile) => {
      profile.categories.electronics = {
        value: applyCategoryPatch(undefined, "electronics", {
          budgetInr: { max: 90000 },
        }),
        updatedAt: "2026-01-01T00:00:00.000Z",
        provenance: "explicit",
      };
    }),
  );
  expect(result.intent.budgetInr).toEqual({ max: 90000 });
  expect(result.report.budgetSource).toBe("profile");
  expect(result.report.applied).toContain(
    "Saved electronics budget applied (up to ₹90,000).",
  );
});

test("a stated budget wins over a stored one, with a conflict note", () => {
  const result = personalizeRequest(
    inputWith(
      (profile) => {
        profile.categories.electronics = {
          value: applyCategoryPatch(undefined, "electronics", {
            budgetInr: { max: 90000 },
          }),
          updatedAt: "2026-01-01T00:00:00.000Z",
          provenance: "explicit",
        };
      },
      { intent: { ...INTENT, budgetInr: { max: 50000 } } },
    ),
  );
  expect(result.intent.budgetInr).toEqual({ max: 50000 });
  expect(result.report.budgetSource).toBe("query");
  expect(result.report.applied).toContain(
    "Query budget (up to ₹50,000) used instead of your saved electronics budget (up to ₹90,000).",
  );
});

test("a stored maximum combines with a stated minimum", () => {
  const result = personalizeRequest(
    inputWith(
      (profile) => {
        profile.categories.electronics = {
          value: applyCategoryPatch(undefined, "electronics", {
            budgetInr: { max: 90000 },
          }),
          updatedAt: "2026-01-01T00:00:00.000Z",
          provenance: "explicit",
        };
      },
      { intent: { ...INTENT, budgetInr: { min: 10000 } } },
    ),
  );
  expect(result.intent.budgetInr).toEqual({ min: 10000, max: 90000 });
  expect(result.report.budgetSource).toBe("profile");
});

test("preferred brands become low-importance wants", () => {
  const result = personalizeRequest(
    inputWith((profile) => {
      profile.general.value = applyGeneralPatch(profile.general.value, {
        preferredBrands: ["Sony"],
      });
    }),
  );
  expect(result.requirements.want).toHaveLength(1);
  const want = must(result.requirements.want[0], "a stored brand want");
  expect(want.label).toBe("Sony");
  expect(want.kind).toBe("want");
  expect(want.importance).toBe(STORED_WANT_IMPORTANCE);
  expect(want.key.startsWith("profile:")).toBe(true);
  expect(result.report.applied).toContain(
    "Preferred brands from your profile: Sony.",
  );
  expect(matchRequirement(want, "Sony WH-1000XM5 headphones")).toBe("met");
  expect(matchRequirement(want, "Bose QuietComfort headphones")).toBe(
    "unknown",
  );
});

test("avoided brands become exclusions", () => {
  const result = personalizeRequest(
    inputWith((profile) => {
      profile.general.value = applyGeneralPatch(profile.general.value, {
        avoidedBrands: ["Acme"],
      });
    }),
  );
  expect(result.requirements.exclude).toHaveLength(1);
  const exclude = must(result.requirements.exclude[0], "a stored exclude");
  expect(exclude.label).toBe("Acme");
  expect(exclude.key.startsWith("profile:")).toBe(true);
  expect(result.report.applied).toContain(
    "Avoided brands from your profile: Acme.",
  );
  expect(matchRequirement(exclude, "Acme Laptop Pro 15")).toBe("met");
});

test("an avoided brand in the query is kept, with a conflict note", () => {
  const result = personalizeRequest(
    inputWith(
      (profile) => {
        profile.general.value = applyGeneralPatch(profile.general.value, {
          avoidedBrands: ["Acme"],
        });
      },
      {
        intent: {
          ...INTENT,
          query: "Acme laptop for coding",
          searchTerms: "Acme laptop",
        },
      },
    ),
  );
  expect(result.requirements.exclude).toEqual([]);
  expect(result.report.applied).toContain(
    "Kept Acme: your query explicitly asks for it.",
  );
});

test("a preferred brand excluded by the query is skipped, with a note", () => {
  const result = personalizeRequest(
    inputWith((profile) => {
      profile.general.value = applyGeneralPatch(profile.general.value, {
        preferredBrands: ["Sony"],
      });
    }, {
      requirements: {
        ...REQUIREMENTS,
        exclude: [
          {
            key: "no-sony",
            label: "Sony",
            kind: "exclude",
            importance: 1,
          },
        ],
      },
    }),
  );
  expect(result.requirements.want).toEqual([]);
  expect(result.report.applied).toContain(
    "Skipped saved preference for Sony: excluded in this query.",
  );
});

test("a brand both preferred and avoided is avoided, with a note", () => {
  const result = personalizeRequest(
    inputWith((profile) => {
      profile.general.value = applyGeneralPatch(profile.general.value, {
        preferredBrands: ["Sony"],
        avoidedBrands: ["Sony"],
      });
    }),
  );
  expect(result.requirements.want).toEqual([]);
  expect(result.requirements.exclude).toHaveLength(1);
  expect(result.report.applied).toContain(
    "Sony is both preferred and avoided in your profile — avoiding it.",
  );
});

test("unmatchable brand names are skipped honestly", () => {
  const result = personalizeRequest(
    inputWith((profile) => {
      profile.general.value = applyGeneralPatch(profile.general.value, {
        preferredBrands: ["H&M"],
      });
    }),
  );
  expect(result.requirements.want).toEqual([]);
  expect(result.report.skipped).toContain(
    'Saved brand "H&M" is too short to match listings reliably.',
  );
});

test("stored RAM minimums use the real numeric matcher", () => {
  const result = personalizeRequest(
    inputWith((profile) => {
      profile.categories.electronics = {
        value: applyCategoryPatch(undefined, "electronics", { minRamGb: 16 }),
        updatedAt: "2026-01-01T00:00:00.000Z",
        provenance: "explicit",
      };
    }),
  );
  const want = must(
    result.requirements.want.find((req) => req.key.endsWith("min-ram")),
    "a stored RAM want",
  );
  expect(want.label).toBe("16GB RAM minimum");
  expect(matchRequirement(want, "Gaming laptop with 16GB RAM, 512GB SSD")).toBe(
    "met",
  );
  expect(
    matchRequirement(
      want,
      "Laptop with 8GB RAM for everyday use and a very large 1TB solid state drive",
    ),
  ).toBe("not-met");
});

test("stored storage minimums match any large drive wording", () => {
  const result = personalizeRequest(
    inputWith((profile) => {
      profile.categories.electronics = {
        value: applyCategoryPatch(undefined, "electronics", {
          minStorageGb: 512,
        }),
        updatedAt: "2026-01-01T00:00:00.000Z",
        provenance: "explicit",
      };
    }),
  );
  const want = must(
    result.requirements.want.find((req) => req.key.endsWith("min-storage")),
    "a stored storage want",
  );
  expect(matchRequirement(want, "Thin laptop, 512GB SSD, 16GB RAM")).toBe("met");
  expect(matchRequirement(want, "Desktop with 1TB HDD storage")).toBe("met");
  expect(matchRequirement(want, "Chromebook, 128GB eMMC, 4GB RAM")).toBe(
    "not-met",
  );
});

test("unmatchable category details are skipped honestly", () => {
  const result = personalizeRequest(
    inputWith(
      (profile) => {
        profile.general.value = applyGeneralPatch(profile.general.value, {
          decisionPriority: "durability",
        });
        profile.categories.electronics = {
          value: applyCategoryPatch(undefined, "electronics", {
            batteryPriority: 0.8,
            notes: "prefer backlit keyboard",
          }),
          updatedAt: "2026-01-01T00:00:00.000Z",
          provenance: "explicit",
        };
      },
      { category: "electronics" },
    ),
  );
  expect(result.report.skipped).toContain(
    "Saved electronics battery priority (0.8) has no scoring effect yet.",
  );
  expect(result.report.skipped).toContain(
    "Saved electronics notes aren't used for matching.",
  );
  expect(result.preset).toEqual(weightPresetFor("durability"));
  expect(result.report.weightsSource).toBe("profile");
  expect(result.report.applied).toContain(
    "Scoring tuned for durability (saved preference).",
  );
});

test("explicit request weights win over a saved decision priority", () => {
  const result = personalizeRequest(
    inputWith(
      (profile) => {
        profile.general.value = applyGeneralPatch(profile.general.value, {
          decisionPriority: "lowest-price",
        });
      },
      { weightsProvided: true },
    ),
  );
  expect(result.preset).toBeNull();
  expect(result.report.weightsSource).toBe("default");
  expect(
    result.report.applied.some((note) => note.includes("Scoring tuned")),
  ).toBe(false);
});

test("duplicate brand entries get distinct keys", () => {
  const result = personalizeRequest(
    inputWith((profile) => {
      profile.general.value = applyGeneralPatch(profile.general.value, {
        preferredBrands: ["Sony", "Sony"],
      });
    }),
  );
  const keys = result.requirements.want.map((req) => req.key);
  expect(new Set(keys).size).toBe(2);
});

test("other categories never leak into the current request", () => {
  const result = personalizeRequest(
    inputWith((profile) => {
      profile.categories.fashion = {
        value: applyCategoryPatch(undefined, "fashion", {
          budgetInr: { max: 5000 },
          sizes: ["M"],
        }),
        updatedAt: "2026-01-01T00:00:00.000Z",
        provenance: "explicit",
      };
    }),
  );
  expect(result.intent.budgetInr).toBeUndefined();
  expect(result.requirements.want).toEqual([]);
  expect(result.report.applied).toEqual([]);
  expect(result.report.skipped).toEqual([]);
});
