import { expect, test } from "vitest";
import { applyGeneralPatch, createDefaultProfile } from "./profile";
import type { DecisionRecord, Feedback } from "./records";
import {
  applyProposal,
  detectProposals,
  fingerprintFor,
  ProposalError,
  ProposalSchema,
  type DetectionInput,
  type Proposal,
} from "./proposals";

function feedback(overrides: Partial<Feedback> & { id: string }): Feedback {
  return {
    createdAt: "2026-01-01T00:00:00.000Z",
    decisionId: null,
    helpful: null,
    preferred: null,
    rejected: null,
    purchased: null,
    ...overrides,
  };
}

function decision(
  overrides: Partial<DecisionRecord> & { id: string },
): DecisionRecord {
  return {
    createdAt: "2026-01-01T00:00:00.000Z",
    query: "laptop",
    category: "electronics",
    topPick: null,
    verdict: "BUY",
    ...overrides,
  };
}

function inputWith(overrides: Partial<DetectionInput> = {}): DetectionInput {
  return {
    profile: createDefaultProfile("user-1"),
    decisions: [],
    feedback: [],
    existing: [],
    ...overrides,
  };
}

function storedProposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    id: "pr1",
    createdAt: "2026-01-01T00:00:00.000Z",
    status: "pending",
    kind: "general",
    patch: { preferredBrands: ["Sony"] },
    reason: "test",
    evidence: [],
    fingerprint: "fp",
    ...overrides,
  };
}

test("two preferred-brand signals propose the brand", () => {
  const proposals = detectProposals(
    inputWith({
      feedback: [
        feedback({
          id: "f1",
          preferred: { productId: "p1", title: "Sony WH-1000XM5" },
        }),
        feedback({
          id: "f2",
          purchased: { productId: "p2", title: "Sony TV 55 inch" },
        }),
      ],
    }),
  );
  expect(proposals).toHaveLength(1);
  expect(proposals[0]).toMatchObject({
    kind: "general",
    patch: { preferredBrands: ["Sony"] },
    reason: "You preferred Sony in 2 recent decisions.",
    evidence: ["f1", "f2"],
  });
});

test("brand proposals append to the existing brand list", () => {
  const profile = createDefaultProfile("user-1");
  profile.general.value = applyGeneralPatch(profile.general.value, {
    preferredBrands: ["Bose"],
  });
  const proposals = detectProposals(
    inputWith({
      profile,
      feedback: [
        feedback({
          id: "f1",
          preferred: { productId: "p1", title: "Sony A" },
        }),
        feedback({
          id: "f2",
          preferred: { productId: "p2", title: "Sony B" },
        }),
      ],
    }),
  );
  expect(proposals[0]?.patch).toEqual({ preferredBrands: ["Bose", "Sony"] });
});

test("a single preferred pick already proposes the brand", () => {
  const proposals = detectProposals(
    inputWith({
      feedback: [
        feedback({
          id: "f1",
          preferred: { productId: "p1", title: "Sony A" },
        }),
      ],
    }),
  );
  expect(proposals).toHaveLength(1);
  expect(proposals[0]).toMatchObject({
    patch: { preferredBrands: ["Sony"] },
    reason: "You preferred Sony in 1 recent decision.",
  });
});

test("a single rejection already proposes avoidance", () => {
  const proposals = detectProposals(
    inputWith({
      feedback: [
        feedback({
          id: "f1",
          rejected: { productId: "p1", title: "Acme Phone" },
        }),
      ],
    }),
  );
  expect(proposals).toHaveLength(1);
  expect(proposals[0]).toMatchObject({
    patch: { avoidedBrands: ["Acme"] },
    reason: "You rejected Acme in 1 recent decision.",
  });
});

test("listed brands propose nothing", () => {
  const profile = createDefaultProfile("user-1");
  profile.general.value = applyGeneralPatch(profile.general.value, {
    preferredBrands: ["Sony"],
  });
  const listed = detectProposals(
    inputWith({
      profile,
      feedback: [
        feedback({
          id: "f1",
          preferred: { productId: "p1", title: "Sony A" },
        }),
        feedback({
          id: "f2",
          preferred: { productId: "p2", title: "Sony B" },
        }),
      ],
    }),
  );
  expect(listed).toEqual([]);
});

test("rejected brands propose avoidance", () => {
  const proposals = detectProposals(
    inputWith({
      feedback: [
        feedback({
          id: "f1",
          rejected: { productId: "p1", title: "Acme Phone" },
        }),
        feedback({
          id: "f2",
          rejected: { productId: "p2", title: "Acme Tablet" },
        }),
      ],
    }),
  );
  expect(proposals).toHaveLength(1);
  expect(proposals[0]).toMatchObject({
    kind: "general",
    patch: { avoidedBrands: ["Acme"] },
    reason: "You rejected Acme in 2 recent decisions.",
  });
});

test("generic first words never become brand proposals", () => {
  const proposals = detectProposals(
    inputWith({
      feedback: [
        feedback({
          id: "f1",
          preferred: { productId: "p1", title: "The best laptop" },
        }),
        feedback({
          id: "f2",
          preferred: { productId: "p2", title: "The best mouse" },
        }),
      ],
    }),
  );
  expect(proposals).toEqual([]);
});

test("clustered budgets propose a category budget", () => {
  const proposals = detectProposals(
    inputWith({
      decisions: [
        decision({ id: "d1", budgetInr: { max: 50000 } }),
        decision({ id: "d2", budgetInr: { max: 52000 } }),
      ],
    }),
  );
  expect(proposals).toHaveLength(1);
  expect(proposals[0]).toMatchObject({
    kind: "category",
    category: "electronics",
    patch: { budgetInr: { max: 52000 } },
    evidence: ["d1", "d2"],
  });
  expect(proposals[0]?.reason).toContain("₹52,000");
});

test("scattered budgets and stored budgets propose nothing", () => {
  const scattered = detectProposals(
    inputWith({
      decisions: [
        decision({ id: "d1", budgetInr: { max: 50000 } }),
        decision({ id: "d2", budgetInr: { max: 80000 } }),
      ],
    }),
  );
  expect(scattered).toEqual([]);

  const profile = createDefaultProfile("user-1");
  const stored = detectProposals(
    inputWith({
      profile: {
        ...profile,
        categories: {
          electronics: {
            value: {
              category: "electronics",
              budgetInr: { max: 90000 },
            },
            updatedAt: "2026-01-01T00:00:00.000Z",
            provenance: "explicit",
          },
        },
      },
      decisions: [
        decision({ id: "d1", budgetInr: { max: 50000 } }),
        decision({ id: "d2", budgetInr: { max: 51000 } }),
      ],
    }),
  );
  expect(stored).toEqual([]);
});

test("decided proposals are never re-proposed", () => {
  const feedbackItems = [
    feedback({ id: "f1", preferred: { productId: "p1", title: "Sony A" } }),
    feedback({ id: "f2", preferred: { productId: "p2", title: "Sony B" } }),
  ];
  const [candidate] = detectProposals(inputWith({ feedback: feedbackItems }));
  expect(candidate).toBeDefined();
  const rejected = detectProposals(
    inputWith({
      feedback: feedbackItems,
      existing: [
        storedProposal({
          status: "rejected",
          patch: { preferredBrands: ["Sony"] },
          fingerprint: candidate?.fingerprint ?? "missing",
        }),
      ],
    }),
  );
  expect(rejected).toEqual([]);
});

test("fingerprints ignore patch key order", () => {
  expect(
    fingerprintFor("general", undefined, { a: 1, b: { c: 2, d: 3 } }),
  ).toBe(fingerprintFor("general", undefined, { b: { d: 3, c: 2 }, a: 1 }));
});

test("confirming a proposal applies it with confirmed provenance", () => {
  const profile = applyProposal(createDefaultProfile("user-1"), {
    kind: "general",
    category: undefined,
    patch: { preferredBrands: ["Sony"] },
  });
  expect(profile.general.value.preferredBrands).toEqual(["Sony"]);
  expect(profile.general.provenance).toBe("confirmed");
  expect(profile.general.value.currency).toBe("INR");
});

test("confirming a category proposal targets that category", () => {
  const profile = applyProposal(
    createDefaultProfile("user-1"),
    {
      kind: "category",
      category: "electronics",
      patch: { budgetInr: { max: 90000 } },
    },
    undefined,
    "2026-02-02T00:00:00.000Z",
  );
  expect(profile.categories.electronics?.value).toMatchObject({
    category: "electronics",
    budgetInr: { max: 90000 },
  });
  expect(profile.categories.electronics?.provenance).toBe("confirmed");
  expect(profile.categories.fashion).toBeUndefined();
});

test("confirming with an edited patch applies the edit", () => {
  const profile = applyProposal(
    createDefaultProfile("user-1"),
    {
      kind: "category",
      category: "electronics",
      patch: { budgetInr: { max: 52000 } },
    },
    { budgetInr: { max: 60000 } },
  );
  expect(profile.categories.electronics?.value).toMatchObject({
    budgetInr: { max: 60000 },
  });
});

test("invalid and empty patches throw ProposalError", () => {
  expect(() =>
    applyProposal(createDefaultProfile("user-1"), {
      kind: "category",
      category: "electronics",
      patch: { minRamGb: "lots" },
    }),
  ).toThrow(ProposalError);
  expect(() =>
    applyProposal(createDefaultProfile("user-1"), {
      kind: "general",
      category: undefined,
      patch: {},
    }),
  ).toThrow(ProposalError);
});

test("stored proposals validate kind, category, and patch together", () => {
  expect(ProposalSchema.safeParse(storedProposal()).success).toBe(true);
  expect(
    ProposalSchema.safeParse(
      storedProposal({ kind: "category", category: undefined }),
    ).success,
  ).toBe(false);
  expect(
    ProposalSchema.safeParse(
      storedProposal({ kind: "general", category: "electronics" }),
    ).success,
  ).toBe(false);
  expect(
    ProposalSchema.safeParse(
      storedProposal({
        kind: "category",
        category: "electronics",
        patch: { minRamGb: "lots" },
      }),
    ).success,
  ).toBe(false);
});
