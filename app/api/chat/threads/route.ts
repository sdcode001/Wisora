import { NextResponse, type NextRequest } from "next/server";
import {
  sessionUserFromRequest,
  unauthenticatedResponse,
} from "../../../../lib/auth/require-session";
import { FileMemoryStore } from "../../../../lib/memory/file-store";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const user = sessionUserFromRequest(request);
  if (!user) {
    return unauthenticatedResponse();
  }
  const threads = await new FileMemoryStore().listChatThreads(user.sub);
  return NextResponse.json({ threads });
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
  const deleted = await new FileMemoryStore().deleteChatThread(user.sub, id);
  return NextResponse.json({ deleted });
}
