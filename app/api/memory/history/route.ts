import { NextResponse, type NextRequest } from "next/server";
import {
  sessionUserFromRequest,
  unauthenticatedResponse,
} from "../../../../lib/auth/require-session";
import { getMemoryStore } from "../../../../lib/memory/get-store";

/**
 * Clear saved decision history: decisions, feedback, and proposals.
 * Explicit keepsakes (saved products/comparisons) and the preference
 * profile are untouched — they have their own delete endpoints.
 */
export async function DELETE(request: NextRequest): Promise<NextResponse> {
  const user = sessionUserFromRequest(request);
  if (!user) {
    return unauthenticatedResponse();
  }
  const cleared = await getMemoryStore().clearHistory(user.sub);
  return NextResponse.json({ cleared });
}
