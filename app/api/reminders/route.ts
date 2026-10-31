import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import {
  sessionUserFromRequest,
  unauthenticatedResponse,
} from "../../../lib/auth/require-session";
import {
  FileMemoryStore,
  RemindersFullError,
} from "../../../lib/memory/file-store";
import {
  NewReminderSchema,
  ReminderUpdateSchema,
} from "../../../lib/memory/records";

const QuerySchema = z.object({
  status: z.enum(["active", "done", "disabled", "all"]).default("all"),
});

export async function GET(request: NextRequest): Promise<NextResponse> {
  const user = sessionUserFromRequest(request);
  if (!user) {
    return unauthenticatedResponse();
  }
  const params = request.nextUrl.searchParams;
  const parsed = QuerySchema.safeParse({
    ...(params.get("status") ? { status: params.get("status") } : {}),
  });
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid query.", code: "invalid-query" },
      { status: 400 },
    );
  }
  const store = new FileMemoryStore();
  const reminders = await store.listReminders(user.sub);
  const filtered =
    parsed.data.status === "all"
      ? reminders
      : reminders.filter((entry) => entry.status === parsed.data.status);
  return NextResponse.json({ reminders: filtered });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const user = sessionUserFromRequest(request);
  if (!user) {
    return unauthenticatedResponse();
  }
  const body: unknown = await request.json().catch(() => null);
  const parsed = NewReminderSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "Body must be a reminder: { title, remindAt, ... }.",
        code: "invalid-reminder",
      },
      { status: 400 },
    );
  }
  const store = new FileMemoryStore();
  try {
    const reminder = await store.saveReminder(user.sub, parsed.data);
    return NextResponse.json({ reminder });
  } catch (error) {
    if (error instanceof RemindersFullError) {
      return NextResponse.json(
        { error: error.message, code: "reminders-full" },
        { status: 400 },
      );
    }
    throw error;
  }
}

export async function PUT(request: NextRequest): Promise<NextResponse> {
  const user = sessionUserFromRequest(request);
  if (!user) {
    return unauthenticatedResponse();
  }
  const body: unknown = await request.json().catch(() => null);
  const parsed = ReminderUpdateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Body must be { id, ...fields }.", code: "invalid-reminder" },
      { status: 400 },
    );
  }
  if (parsed.data.status === "done") {
    return NextResponse.json(
      {
        error: "Only the scheduler marks reminders done.",
        code: "invalid-status",
      },
      { status: 400 },
    );
  }
  const reminder = await new FileMemoryStore().updateReminder(
    user.sub,
    parsed.data,
  );
  if (!reminder) {
    return NextResponse.json(
      { error: "Unknown reminder.", code: "unknown-reminder" },
      { status: 404 },
    );
  }
  return NextResponse.json({ reminder });
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
  const deleted = await new FileMemoryStore().deleteReminder(user.sub, id);
  return NextResponse.json({ deleted });
}
