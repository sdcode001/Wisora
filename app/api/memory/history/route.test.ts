import { NextRequest } from "next/server";
import { expect, test } from "vitest";
import { FileMemoryStore } from "../../../../lib/memory/file-store";
import { POST as postDecision } from "../decisions/route";
import { POST as postFeedback } from "../feedback/route";
import { memoryRequest, setupMemoryEnv, setupTempMemoryDir } from "../test-helpers";
import { DELETE } from "./route";

setupMemoryEnv();

const URL = "http://localhost/api/memory/history";

test("clearing history requires a signed-in user", async () => {
  await setupTempMemoryDir();
  expect((await DELETE(new NextRequest(URL, { method: "DELETE" }))).status)
    .toBe(401);
});

test("clearing history removes decisions, feedback, and proposals", async () => {
  await setupTempMemoryDir();
  const store = new FileMemoryStore();
  await postDecision(
    memoryRequest("http://localhost/api/memory/decisions", {
      body: {
        query: "laptop",
        category: "electronics",
        topPick: null,
        verdict: "BUY",
      },
    }),
  );
  await postFeedback(
    memoryRequest("http://localhost/api/memory/feedback", {
      body: { helpful: true },
    }),
  );
  await store.saveProposal("user-1", {
    kind: "general",
    patch: { preferredBrands: ["Sony"] },
    reason: "test",
    evidence: [],
    fingerprint: "fp",
  });
  const response = await DELETE(memoryRequest(URL, { method: "DELETE" }));
  expect(await response.json()).toEqual({
    cleared: { decisions: 1, feedback: 1, proposals: 1 },
  });
  expect(await store.listDecisions("user-1")).toEqual([]);
  expect(await store.listFeedback("user-1")).toEqual([]);
  expect(await store.listProposals("user-1")).toEqual([]);
});
