import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import {
  sessionUserFromRequest,
  unauthenticatedResponse,
} from "../../../../../lib/auth/require-session";
import { FileMemoryStore } from "../../../../../lib/memory/file-store";
import { runWatchCheck, tavilyPageFetcher } from "../../../../../lib/prices/check";
import { notifierFromEnv } from "../../../../../lib/prices/notify";

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
      { error: "Body must be { id }.", code: "invalid-check" },
      { status: 400 },
    );
  }
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      {
        error: "Price checks need TAVILY_API_KEY. Add it to .env.",
        code: "missing-tavily-key",
      },
      { status: 503 },
    );
  }
  const store = new FileMemoryStore();
  const existing = await store.getWatch(user.sub, parsed.data.id);
  if (!existing) {
    return NextResponse.json(
      { error: "Unknown watch.", code: "unknown-watch" },
      { status: 404 },
    );
  }
  // Keep the alert recipient in sync with the signed-in account.
  const watch =
    user.email && user.email !== existing.notifyEmail
      ? ((await store.updateWatch(user.sub, {
          id: existing.id,
          notifyEmail: user.email,
        })) ?? existing)
      : existing;
  const outcome = await runWatchCheck({
    store,
    userSub: user.sub,
    watch,
    fetchPage: (url) => tavilyPageFetcher(apiKey, url),
    notifier: notifierFromEnv(),
  });
  // Check failures are data (status/error), never HTTP errors.
  return NextResponse.json({
    watch: outcome.watch,
    status: outcome.status,
    ...(outcome.error ? { error: outcome.error } : {}),
    ...(outcome.observation ? { observation: outcome.observation } : {}),
    ...(outcome.recorded !== undefined ? { recorded: outcome.recorded } : {}),
    alert: outcome.alert ?? null,
    alertSkipped: outcome.alertSkipped ?? null,
  });
}
