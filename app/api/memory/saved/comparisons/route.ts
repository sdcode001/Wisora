import { NextResponse, type NextRequest } from "next/server";
import {
  sessionUserFromRequest,
  unauthenticatedResponse,
} from "../../../../../lib/auth/require-session";
import { FileMemoryStore } from "../../../../../lib/memory/file-store";
import { NewSavedComparisonSchema } from "../../../../../lib/memory/records";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const user = sessionUserFromRequest(request);
  if (!user) {
    return unauthenticatedResponse();
  }
  const comparisons =
    await new FileMemoryStore().listSavedComparisons(user.sub);
  return NextResponse.json({ comparisons });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const user = sessionUserFromRequest(request);
  if (!user) {
    return unauthenticatedResponse();
  }
  const body: unknown = await request.json().catch(() => null);
  const parsed = NewSavedComparisonSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error:
          "Body must be a comparison: { category, products: 2–6 snapshots }.",
        code: "invalid-comparison",
      },
      { status: 400 },
    );
  }
  const comparison = await new FileMemoryStore().saveSavedComparison(
    user.sub,
    parsed.data,
  );
  return NextResponse.json({ comparison });
}

export async function DELETE(request: NextRequest): Promise<NextResponse> {
  const user = sessionUserFromRequest(request);
  if (!user) {
    return unauthenticatedResponse();
  }
  const id = request.nextUrl.searchParams.get("id");
  if (!id) {
    return NextResponse.json(
      { error: "Missing ?id= query parameter.", code: "missing-id" },
      { status: 400 },
    );
  }
  const deleted = await new FileMemoryStore().deleteSavedComparison(
    user.sub,
    id,
  );
  return NextResponse.json({ deleted });
}
