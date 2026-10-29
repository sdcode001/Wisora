import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import {
  sessionUserFromRequest,
  unauthenticatedResponse,
  unreadableResponse,
} from "../../../../../lib/auth/require-session";
import {
  FileMemoryStore,
  StoredDataError,
} from "../../../../../lib/memory/file-store";
import {
  applyProposal,
  ProposalError,
} from "../../../../../lib/memory/proposals";
import { createDefaultProfile } from "../../../../../lib/memory/profile";

const BodySchema = z.object({
  id: z.string().min(1).max(64),
  decision: z.enum(["confirmed", "rejected"]),
  // Optional user edit of the proposed patch; only used on confirmation.
  patch: z.unknown().optional(),
});

export async function POST(request: NextRequest): Promise<NextResponse> {
  const user = sessionUserFromRequest(request);
  if (!user) {
    return unauthenticatedResponse();
  }
  const body: unknown = await request.json().catch(() => null);
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error:
          "Body must be { id, decision: confirmed|rejected, patch? }.",
        code: "invalid-proposal-decision",
      },
      { status: 400 },
    );
  }
  const store = new FileMemoryStore();
  try {
    const existing = await store.listProposals(user.sub);
    const proposal = existing.find((item) => item.id === parsed.data.id);
    if (!proposal || proposal.status !== "pending") {
      return NextResponse.json(
        {
          error: "Unknown or already decided proposal.",
          code: "unknown-proposal",
        },
        { status: 404 },
      );
    }
    if (parsed.data.decision === "rejected") {
      const decided = await store.decideProposal(
        user.sub,
        proposal.id,
        "rejected",
      );
      return NextResponse.json({ proposal: decided });
    }
    // Confirm: the profile write succeeds before the proposal flips, so a
    // failed patch never loses the pending question.
    const base =
      (await store.getProfile(user.sub)) ?? createDefaultProfile(user.sub);
    let profile;
    try {
      profile = applyProposal(base, proposal, parsed.data.patch);
    } catch (error) {
      if (error instanceof ProposalError) {
        return NextResponse.json(
          { error: error.message, code: "invalid-proposal-patch" },
          { status: 400 },
        );
      }
      throw error;
    }
    await store.saveProfile(profile);
    const decided = await store.decideProposal(
      user.sub,
      proposal.id,
      "confirmed",
    );
    return NextResponse.json({ proposal: decided, profile });
  } catch (error) {
    if (error instanceof StoredDataError) {
      return unreadableResponse(error.message);
    }
    throw error;
  }
}
