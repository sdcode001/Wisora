import { NextResponse, type NextRequest } from "next/server";
import {
  sessionUserFromRequest,
  unauthenticatedResponse,
} from "../../../../lib/auth/require-session";
import {
  DuplicateWatchError,
  FileMemoryStore,
  WatchlistFullError,
} from "../../../../lib/memory/file-store";
import { evaluateWatchForOpportunities } from "../../../../lib/opportunities/evaluate";
import { evaluateObservationsForUser } from "../../../../lib/prices/check";
import { summarizeHistory, targetRealismNote } from "../../../../lib/prices/history";
import { notifierFromEnv } from "../../../../lib/prices/notify";
import {
  NewWatchSchema,
  WatchUpdateSchema,
} from "../../../../lib/prices/observation";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const user = sessionUserFromRequest(request);
  if (!user) {
    return unauthenticatedResponse();
  }
  const store = new FileMemoryStore();
  const [watches, alerts] = await Promise.all([
    store.listWatches(user.sub),
    store.listAlerts(user.sub),
  ]);
  const unreadByWatch = new Map<string, number>();
  for (const alert of alerts) {
    if (!alert.read) {
      unreadByWatch.set(
        alert.watchId,
        (unreadByWatch.get(alert.watchId) ?? 0) + 1,
      );
    }
  }
  const enriched = await Promise.all(
    watches.map(async (watch) => {
      const observations = await store.listObservations(watch.productId);
      const stats = summarizeHistory(observations);
      return {
        watch,
        latest: stats.latest,
        stats,
        recent: observations.slice(0, 10),
        unreadAlerts: unreadByWatch.get(watch.id) ?? 0,
      };
    }),
  );
  return NextResponse.json({ watches: enriched });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const user = sessionUserFromRequest(request);
  if (!user) {
    return unauthenticatedResponse();
  }
  const body: unknown = await request.json().catch(() => null);
  const parsed = NewWatchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error:
          "Body must be a watch: { productId, url, title, merchant, targetPrice }.",
        code: "invalid-watch",
      },
      { status: 400 },
    );
  }
  const store = new FileMemoryStore();
  try {
    const watch = await store.saveWatch(user.sub, {
      ...parsed.data,
      // The recipient is always the signed-in account — never client-chosen.
      notifyEmail: user.email,
    });
    // Immediate evaluation against known history: a met target alerts now,
    // and an unrealistic one gets an honest note (never adjusted).
    const observations = await store.listObservations(watch.productId);
    const stats = summarizeHistory(observations);
    const created = stats.latest
      ? await evaluateObservationsForUser({
          store,
          userSub: user.sub,
          observations: [stats.latest],
          notifier: notifierFromEnv(),
        })
      : [];
    // A met target also files a feed card; failures here never fail the save.
    let opportunities: unknown[] = [];
    try {
      opportunities = (
        await evaluateWatchForOpportunities({
          store,
          userSub: user.sub,
          watch,
        })
      ).created;
    } catch {
      opportunities = [];
    }
    return NextResponse.json({
      watch,
      alert: created.find((entry) => entry.watchId === watch.id) ?? null,
      opportunities,
      stats,
      realismWarning: targetRealismNote(watch.targetPrice, stats),
    });
  } catch (error) {
    if (error instanceof DuplicateWatchError) {
      return NextResponse.json(
        { error: error.message, code: "duplicate-watch" },
        { status: 409 },
      );
    }
    if (error instanceof WatchlistFullError) {
      return NextResponse.json(
        { error: error.message, code: "watchlist-full" },
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
  const parsed = WatchUpdateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "Body must be { id, targetPrice?, active?, canWait? }.",
        code: "invalid-watch",
      },
      { status: 400 },
    );
  }
  // notifyEmail stays server-managed (always the signed-in account).
  const { notifyEmail: _ignored, ...update } = parsed.data;
  void _ignored;
  const watch = await new FileMemoryStore().updateWatch(user.sub, {
    ...update,
    id: parsed.data.id,
  });
  if (!watch) {
    return NextResponse.json(
      { error: "Unknown watch.", code: "unknown-watch" },
      { status: 404 },
    );
  }
  return NextResponse.json({ watch });
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
  const deleted = await new FileMemoryStore().deleteWatch(user.sub, id);
  return NextResponse.json({ deleted });
}
