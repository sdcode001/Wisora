import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import {
  sessionUserFromRequest,
  unauthenticatedResponse,
} from "../../../../lib/auth/require-session";
import { FileMemoryStore } from "../../../../lib/memory/file-store";
import { detectionThresholdsFromEnv } from "../../../../lib/opportunities/detect";
import { evaluateWatchForOpportunities } from "../../../../lib/opportunities/evaluate";
import { runWatchCheck, tavilyPageFetcher } from "../../../../lib/prices/check";
import { notifierFromEnv } from "../../../../lib/prices/notify";

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
      { error: "Body must be { id }.", code: "invalid-reevaluate" },
      { status: 400 },
    );
  }
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      {
        error: "Re-evaluation needs TAVILY_API_KEY. Add it to .env.",
        code: "missing-tavily-key",
      },
      { status: 503 },
    );
  }
  const store = new FileMemoryStore();
  const existing = (await store.listOpportunities(user.sub)).find(
    (entry) => entry.id === parsed.data.id,
  );
  if (!existing) {
    return NextResponse.json(
      { error: "Unknown opportunity.", code: "unknown-opportunity" },
      { status: 404 },
    );
  }
  if (!existing.watchId) {
    return NextResponse.json(
      {
        error: "This opportunity has no tracked watch to re-check.",
        code: "no-watch",
      },
      { status: 400 },
    );
  }
  const stored = await store.getWatch(user.sub, existing.watchId);
  if (!stored) {
    return NextResponse.json(
      { error: "The tracked watch no longer exists.", code: "unknown-watch" },
      { status: 404 },
    );
  }
  // Keep the alert recipient in sync with the signed-in account.
  const watch =
    user.email && user.email !== stored.notifyEmail
      ? ((await store.updateWatch(user.sub, {
          id: stored.id,
          notifyEmail: user.email,
        })) ?? stored)
      : stored;
  const previousStatus = watch.lastCheck?.status;
  const outcome = await runWatchCheck({
    store,
    userSub: user.sub,
    watch,
    fetchPage: (url) => tavilyPageFetcher(apiKey, url),
    notifier: notifierFromEnv(),
  });
  let created: unknown[] = [];
  let skipped: unknown[] = [];
  if (outcome.status === "ok" || outcome.status === "unavailable") {
    const evaluated = await evaluateWatchForOpportunities({
      store,
      userSub: user.sub,
      watch: outcome.watch,
      previousStatus,
      thresholds: detectionThresholdsFromEnv(),
    });
    created = evaluated.created;
    skipped = evaluated.skipped;
  }
  return NextResponse.json({
    watch: outcome.watch,
    status: outcome.status,
    ...(outcome.error ? { error: outcome.error } : {}),
    ...(outcome.observation ? { observation: outcome.observation } : {}),
    alert: outcome.alert ?? null,
    created,
    skipped,
  });
}
