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
  const params = request.nextUrl.searchParams;
  const limitRaw = params.get("limit");
  const limit = limitRaw === null ? undefined : Number.parseInt(limitRaw, 10);
  const alerts = await new FileMemoryStore().listAlerts(
    user.sub,
    Number.isFinite(limit) ? limit : undefined,
  );
  const unreadOnly = params.get("unread") === "1";
  return NextResponse.json({
    alerts: unreadOnly ? alerts.filter((alert) => !alert.read) : alerts,
  });
}
