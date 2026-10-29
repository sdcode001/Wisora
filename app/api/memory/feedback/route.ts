import { NextResponse, type NextRequest } from "next/server";
import {
  sessionUserFromRequest,
  unauthenticatedResponse,
} from "../../../../lib/auth/require-session";
import { FileMemoryStore } from "../../../../lib/memory/file-store";
import { NewFeedbackSchema } from "../../../../lib/memory/records";

function readLimit(request: NextRequest, fallback = 20): number {
  const raw = request.nextUrl.searchParams.get("limit");
  const parsed = raw === null ? Number.NaN : Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(1, Math.min(50, parsed));
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const user = sessionUserFromRequest(request);
  if (!user) {
    return unauthenticatedResponse();
  }
  const feedback = await new FileMemoryStore().listFeedback(
    user.sub,
    readLimit(request),
  );
  return NextResponse.json({ feedback });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const user = sessionUserFromRequest(request);
  if (!user) {
    return unauthenticatedResponse();
  }
  const body: unknown = await request.json().catch(() => null);
  const parsed = NewFeedbackSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error:
          "Body must be feedback with at least one signal: { helpful?, preferred?, rejected?, purchased?, note? }.",
        code: "invalid-feedback",
      },
      { status: 400 },
    );
  }
  const item = await new FileMemoryStore().saveFeedback(
    user.sub,
    parsed.data,
  );
  return NextResponse.json({ feedback: item });
}
