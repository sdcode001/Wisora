import { NextRequest } from "next/server";
import { expect, test } from "vitest";
import { FileMemoryStore } from "../../../../../lib/memory/file-store";
import { createDefaultProfile } from "../../../../../lib/memory/profile";
import { fingerprintFor } from "../../../../../lib/memory/proposals";
import { GET as getProfile } from "../../../profile/route";
import {
  memoryRequest,
  setupMemoryEnv,
  setupTempMemoryDir,
} from "../../test-helpers";
import { GET as listProposals } from "../route";
import { POST } from "./route";

setupMemoryEnv();

const URL = "http://localhost/api/memory/proposals/decide";

async function seedPending(patch: Record<string, unknown>): Promise<string> {
  await setupTempMemoryDir();
  const store = new FileMemoryStore();
  await store.saveProfile(createDefaultProfile("user-1"));
  const proposal = await store.saveProposal("user-1", {
    kind: "general",
    patch,
    reason: "test",
    evidence: [],
    fingerprint: fingerprintFor("general", undefined, patch),
  });
  return proposal.id;
}

test("deciding proposals requires a signed-in user", async () => {
  await setupTempMemoryDir();
  expect((await POST(new NextRequest(URL, { method: "POST" }))).status).toBe(
    401,
  );
});

test("unknown and malformed decisions fail cleanly", async () => {
  await setupTempMemoryDir();
  const unknown = await POST(
    memoryRequest(URL, { body: { id: "missing", decision: "confirmed" } }),
  );
  expect(unknown.status).toBe(404);
  expect((await unknown.json()).code).toBe("unknown-proposal");
  const malformed = await POST(
    memoryRequest(URL, { body: { id: "x", decision: "maybe" } }),
  );
  expect(malformed.status).toBe(400);
  expect((await malformed.json()).code).toBe("invalid-proposal-decision");
});

test("rejecting flips the proposal without touching the profile", async () => {
  const id = await seedPending({ preferredBrands: ["Sony"] });
  const response = await POST(
    memoryRequest(URL, { body: { id, decision: "rejected" } }),
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    proposal: { status: string; decidedAt: string };
  };
  expect(body.proposal.status).toBe("rejected");
  expect(typeof body.proposal.decidedAt).toBe("string");
  const pending = (await (
    await listProposals(memoryRequest("http://localhost/api/memory/proposals"))
  ).json()) as { proposals: unknown[] };
  expect(pending.proposals).toEqual([]);
  const profile = (await (
    await getProfile(memoryRequest("http://localhost/api/profile"))
  ).json()) as {
    profile: { general: { value: { preferredBrands: string[] } } };
  };
  expect(profile.profile.general.value.preferredBrands).toEqual([]);
});

test("confirming applies the patch with confirmed provenance", async () => {
  const id = await seedPending({ preferredBrands: ["Sony"] });
  const response = await POST(
    memoryRequest(URL, { body: { id, decision: "confirmed" } }),
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    proposal: { status: string };
    profile: {
      general: {
        value: { preferredBrands: string[] };
        provenance: string;
      };
    };
  };
  expect(body.proposal.status).toBe("confirmed");
  expect(body.profile.general.value.preferredBrands).toEqual(["Sony"]);
  expect(body.profile.general.provenance).toBe("confirmed");
});

test("confirming with an edit applies the edited patch", async () => {
  const id = await seedPending({ preferredBrands: ["Sony"] });
  const response = await POST(
    memoryRequest(URL, {
      body: {
        id,
        decision: "confirmed",
        patch: { preferredBrands: ["Sony", "Bose"] },
      },
    }),
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    profile: { general: { value: { preferredBrands: string[] } } };
  };
  expect(body.profile.general.value.preferredBrands).toEqual(["Sony", "Bose"]);
});

test("confirming an invalid edit keeps the proposal pending", async () => {
  const id = await seedPending({ preferredBrands: ["Sony"] });
  const response = await POST(
    memoryRequest(URL, {
      body: { id, decision: "confirmed", patch: { currency: "xx" } },
    }),
  );
  expect(response.status).toBe(400);
  expect((await response.json()).code).toBe("invalid-proposal-patch");
  const pending = (await (
    await listProposals(memoryRequest("http://localhost/api/memory/proposals"))
  ).json()) as { proposals: Array<{ id: string }> };
  expect(pending.proposals.map((p) => p.id)).toContain(id);
});
