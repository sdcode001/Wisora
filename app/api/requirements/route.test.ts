import { expect, test } from "vitest";
import { POST } from "./route";

delete process.env.META_API_KEY;

const req = (body: unknown): Request =>
  new Request("http://localhost/api/requirements", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const INTENT = {
  query: "laptop with no webcam",
  category: "electronics",
  categoryConfidence: "high",
  searchTerms: "laptop",
};

test("rejects invalid bodies", async () => {
  const response = await POST(req({}));
  expect(response.status).toBe(400);
});

test("extracts rules requirements without live calls", async () => {
  const response = await POST(
    req({ query: "laptop with no webcam", intent: INTENT }),
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    requirements: {
      category: string;
      must: unknown[];
      exclude: Array<{ key: string }>;
    };
    questions: unknown[];
    suggestedCategory: string | null;
  };
  expect(body.requirements.category).toBe("electronics");
  expect(body.requirements.must).toEqual([]);
  expect(body.requirements.exclude.map((r) => r.key)).toEqual(["webcam"]);
  expect(body.questions).toEqual([]);
  expect(body.suggestedCategory).toBeNull();
});

test("maps a category answer to a suggestion", async () => {
  const response = await POST(
    req({
      query: "running shoes",
      intent: {
        ...INTENT,
        query: "running shoes",
        categoryConfidence: "low",
      },
      answers: [{ questionId: "category", value: "Fashion" }],
    }),
  );
  const body = (await response.json()) as {
    requirements: { category: string };
    questions: unknown[];
    suggestedCategory: string | null;
  };
  expect(body.suggestedCategory).toBe("fashion");
  expect(body.requirements.category).toBe("fashion");
  expect(body.questions).toEqual([]);
});
