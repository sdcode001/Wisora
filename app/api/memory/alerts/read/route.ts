import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import {
  sessionUserFromRequest,
  unauthenticatedResponse,
} from "../../../../../lib/auth/require-session";
import { FileMemoryStore } from "../../../../../lib/memory/file-store";

const BodySchema = z.object({
  ids: z.array(z.string().min(1).max(64)).max(100).optional(),
  all: z.boolean().optional(),
});

export async function POST(request: NextRequest): Promise<NextResponse> {
  const user = sessionUserFromRequest(request);
  if (!user) {
    return unauthenticatedResponse();
  }
  const body: unknown = await request.json().catch(() => null);
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success || (!parsed.data.all && !parsed.data.ids)) {
    return NextResponse.json(
      { error: "Body must be { ids: [...] } or { all: true }.", code: "invalid-read" },
      { status: 400 },
    );
  }
  const marked = await new FileMemoryStore().markAlertsRead(
    user.sub,
    parsed.data.all ? "all" : (parsed.data.ids ?? []),
  );
  return NextResponse.json({ marked });
}
