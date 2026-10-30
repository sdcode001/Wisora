import { NextResponse, type NextRequest } from "next/server";
import {
  sessionUserFromRequest,
  unauthenticatedResponse,
} from "../../../../lib/auth/require-session";
import { FileMemoryStore } from "../../../../lib/memory/file-store";
import { summarizeHistory, type PriceStats } from "../../../../lib/prices/history";
import type { PriceObservation } from "../../../../lib/prices/observation";

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Batch price insights for product cards: latest observation, windowed
 * stats, and recent history per product id (comma-separated, max 10).
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const user = sessionUserFromRequest(request);
  if (!user) {
    return unauthenticatedResponse();
  }
  const raw = request.nextUrl.searchParams.get("ids") ?? "";
  const ids = raw
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0)
    .slice(0, 10);
  if (ids.length === 0 || !ids.every((id) => ID_RE.test(id))) {
    return NextResponse.json(
      {
        error: "Provide ?ids= as 1–10 product ids.",
        code: "invalid-product-id",
      },
      { status: 400 },
    );
  }
  const store = new FileMemoryStore();
  const insights: Record<
    string,
    {
      latest: PriceObservation | null;
      stats: PriceStats;
      recent: PriceObservation[];
    }
  > = {};
  await Promise.all(
    ids.map(async (id) => {
      const observations = await store.listObservations(id);
      insights[id] = {
        latest: observations[0] ?? null,
        stats: summarizeHistory(observations),
        recent: observations.slice(0, 10),
      };
    }),
  );
  return NextResponse.json({ insights });
}
