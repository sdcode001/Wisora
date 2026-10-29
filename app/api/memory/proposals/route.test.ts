import { NextRequest } from "next/server";
import { expect, test } from "vitest";
import { FileMemoryStore } from "../../../../lib/memory/file-store";
import { createDefaultProfile } from "../../../../lib/memory/profile";
import { POST as postDecision } from "../decisions/route";
import { POST as postFeedback } from "../feedback/route";
import { memoryRequest, setupMemoryEnv, setupTempMemoryDir } from "../test-helpers";
import { GET } from "./route";

setupMemoryEnv();

test("proposals require a signed-in user", async () => {
  await setupTempMemoryDir();
  expect(
    (await GET(new NextRequest("http://localhost/api/memory/proposals")))
      .status,
  ).toBe(401);
});

test("proposals start empty without a profile", async () => {
  await setupTempMemoryDir();
  const response = await GET(
    memoryRequest("http://localhost/api/memory/proposals"),
  );
  expect(await response.json()).toEqual({ proposals: [] });
});

test("detection works without a stored profile", async () => {
  await setupTempMemoryDir();
  await postFeedback(
    memoryRequest("http://localhost/api/memory/feedback", {
      body: { preferred: { productId: "p1", title: "Sony Alpha" } },
    }),
  );
  const response = (await (
    await GET(memoryRequest("http://localhost/api/memory/proposals"))
  ).json()) as {
    proposals: Array<{ patch: unknown; reason: string }>;
  };
  expect(response.proposals).toHaveLength(1);
  expect(response.proposals[0]?.patch).toEqual({
    preferredBrands: ["Sony"],
  });
});

test("reading proposals detects and persists new ones exactly once", async () => {
  await setupTempMemoryDir();
  const store = new FileMemoryStore();
  await store.saveProfile(createDefaultProfile("user-1"));
  const decisionsUrl = "http://localhost/api/memory/decisions";
  await postDecision(
    memoryRequest(decisionsUrl, {
      body: {
        query: "laptop",
        category: "electronics",
        topPick: null,
        verdict: "BUY",
        budgetInr: { max: 50000 },
      },
    }),
  );
  await postDecision(
    memoryRequest(decisionsUrl, {
      body: {
        query: "laptop",
        category: "electronics",
        topPick: null,
        verdict: "BUY",
        budgetInr: { max: 52000 },
      },
    }),
  );
  const url = "http://localhost/api/memory/proposals";
  const first = (await (await GET(memoryRequest(url))).json()) as {
    proposals: Array<{ id: string; status: string; patch: unknown }>;
  };
  expect(first.proposals).toHaveLength(1);
  expect(first.proposals[0]?.status).toBe("pending");
  expect(first.proposals[0]?.patch).toEqual({ budgetInr: { max: 52000 } });
  // A second read reuses the persisted proposal instead of duplicating it.
  const second = (await (await GET(memoryRequest(url))).json()) as {
    proposals: Array<{ id: string }>;
  };
  expect(second.proposals).toHaveLength(1);
  expect(second.proposals[0]?.id).toBe(first.proposals[0]?.id);
});

test("feedback-driven brand proposals surface through the API", async () => {
  await setupTempMemoryDir();
  const store = new FileMemoryStore();
  await store.saveProfile(createDefaultProfile("user-1"));
  const feedbackUrl = "http://localhost/api/memory/feedback";
  await postFeedback(
    memoryRequest(feedbackUrl, {
      body: { preferred: { productId: "p1", title: "Sony Alpha" } },
    }),
  );
  await postFeedback(
    memoryRequest(feedbackUrl, {
      body: { purchased: { productId: "p2", title: "Sony Beta" } },
    }),
  );
  const response = (await (
    await GET(memoryRequest("http://localhost/api/memory/proposals"))
  ).json()) as {
    proposals: Array<{ patch: unknown; reason: string }>;
  };
  expect(response.proposals).toHaveLength(1);
  expect(response.proposals[0]?.patch).toEqual({
    preferredBrands: ["Sony"],
  });
  expect(response.proposals[0]?.reason).toContain("Sony");
});
