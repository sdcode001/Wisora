import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { CategorySchema } from "../../../config/sources";
import {
  sessionUserFromRequest,
  unauthenticatedResponse,
} from "../../../lib/auth/require-session";
import { FileMemoryStore } from "../../../lib/memory/file-store";
import { OpportunityKindSchema } from "../../../lib/opportunities/schema";

const QuerySchema = z.object({
  status: z.enum(["active", "read", "dismissed", "all"]).default("active"),
  kind: OpportunityKindSchema.optional(),
  category: CategorySchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

function relevanceScoreOf(entry: { relevance?: { score: number } }): number {
  return entry.relevance?.score ?? 50;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const user = sessionUserFromRequest(request);
  if (!user) {
    return unauthenticatedResponse();
  }
  const params = request.nextUrl.searchParams;
  const parsed = QuerySchema.safeParse({
    ...(params.get("status") ? { status: params.get("status") } : {}),
    ...(params.get("kind") ? { kind: params.get("kind") } : {}),
    ...(params.get("category") ? { category: params.get("category") } : {}),
    ...(params.get("limit") ? { limit: params.get("limit") } : {}),
  });
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid query.", code: "invalid-query" },
      { status: 400 },
    );
  }
  const { status, kind, category, limit } = parsed.data;
  const store = new FileMemoryStore();
  const all = await store.listOpportunities(user.sub);
  const filtered = all.filter(
    (entry) =>
      (status === "all" || entry.status === status) &&
      (kind === undefined || entry.kind === kind) &&
      (category === undefined || entry.category === category),
  );
  filtered.sort(
    (a, b) =>
      relevanceScoreOf(b) - relevanceScoreOf(a) ||
      (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0),
  );
  return NextResponse.json({ opportunities: filtered.slice(0, limit) });
}
