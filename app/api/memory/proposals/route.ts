import { NextResponse, type NextRequest } from "next/server";
import {
  sessionUserFromRequest,
  unauthenticatedResponse,
  unreadableResponse,
} from "../../../../lib/auth/require-session";
import {
  FileMemoryStore,
  StoredDataError,
} from "../../../../lib/memory/file-store";
import { createDefaultProfile } from "../../../../lib/memory/profile";
import { detectProposals } from "../../../../lib/memory/proposals";

/**
 * Pending preference proposals. Each read also runs detection over the
 * latest decisions and feedback and persists genuinely new proposals —
 * detection is idempotent (fingerprints suppress repeats), so this GET
 * never duplicates or resurfaces a decided question.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const user = sessionUserFromRequest(request);
  if (!user) {
    return unauthenticatedResponse();
  }
  const store = new FileMemoryStore();
  try {
    const [profile, decisions, feedback, existing] = await Promise.all([
      store.getProfile(user.sub),
      store.listDecisions(user.sub),
      store.listFeedback(user.sub),
      store.listProposals(user.sub),
    ]);
    let pending = existing.filter(
      (proposal) => proposal.status === "pending",
    );
    // Detection runs against an empty default when nothing is saved yet, so
    // first-time users get suggestions from feedback alone. The default is
    // never persisted — only confirmed proposals write to the profile.
    const fresh = detectProposals({
      profile: profile ?? createDefaultProfile(user.sub),
      decisions,
      feedback,
      existing,
    });
    for (const candidate of fresh) {
      pending = [await store.saveProposal(user.sub, candidate), ...pending];
    }
    return NextResponse.json({ proposals: pending });
  } catch (error) {
    if (error instanceof StoredDataError) {
      return unreadableResponse(error.message);
    }
    throw error;
  }
}
