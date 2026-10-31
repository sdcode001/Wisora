import { NextResponse, type NextRequest } from "next/server";
import {
  sessionUserFromRequest,
  unauthenticatedResponse,
} from "../../../../lib/auth/require-session";
import { FileMemoryStore } from "../../../../lib/memory/file-store";
import { NotificationSettingsPatchSchema } from "../../../../lib/memory/records";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const user = sessionUserFromRequest(request);
  if (!user) {
    return unauthenticatedResponse();
  }
  const settings = await new FileMemoryStore().getNotificationSettings(
    user.sub,
  );
  return NextResponse.json({ settings });
}

export async function PUT(request: NextRequest): Promise<NextResponse> {
  const user = sessionUserFromRequest(request);
  if (!user) {
    return unauthenticatedResponse();
  }
  const body: unknown = await request.json().catch(() => null);
  const parsed = NotificationSettingsPatchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid settings.", code: "invalid-settings" },
      { status: 400 },
    );
  }
  const settings = await new FileMemoryStore().saveNotificationSettings(
    user.sub,
    parsed.data,
  );
  return NextResponse.json({ settings });
}
