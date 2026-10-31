import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import {
  sessionUserFromRequest,
  unauthenticatedResponse,
} from "../../../../lib/auth/require-session";
import { FileMemoryStore } from "../../../../lib/memory/file-store";

const BodySchema = z.object({ id: z.string().min(1).max(64) });

export async function POST(request: NextRequest): Promise<NextResponse> {
  const user = sessionUserFromRequest(request);
  if (!user) {
    return unauthenticatedResponse();
  }
  const body: unknown = await request.json().catch(() => null);
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Body must be { id }.", code: "invalid-dismiss" },
      { status: 400 },
    );
  }
  const store = new FileMemoryStore();
  const updated = await store.updateOpportunityStatus(
    user.sub,
    parsed.data.id,
    "dismissed",
  );
  if (!updated) {
    return NextResponse.json(
      { error: "Unknown opportunity.", code: "unknown-opportunity" },
      { status: 404 },
    );
  }
  return NextResponse.json({ opportunity: updated });
}
