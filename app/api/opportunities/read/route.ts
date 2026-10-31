import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import {
  sessionUserFromRequest,
  unauthenticatedResponse,
} from "../../../../lib/auth/require-session";
import { FileMemoryStore } from "../../../../lib/memory/file-store";

const BodySchema = z.object({
  ids: z.union([z.array(z.string().min(1).max(64)).max(100), z.literal("all")]),
});

export async function POST(request: NextRequest): Promise<NextResponse> {
  const user = sessionUserFromRequest(request);
  if (!user) {
    return unauthenticatedResponse();
  }
  const body: unknown = await request.json().catch(() => null);
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Body must be { ids: [...] | \"all\" }.", code: "invalid-read" },
      { status: 400 },
    );
  }
  const store = new FileMemoryStore();
  const all = await store.listOpportunities(user.sub);
  const ids =
    parsed.data.ids === "all"
      ? all.filter((entry) => entry.status === "active").map((entry) => entry.id)
      : parsed.data.ids;
  const byId = new Map(all.map((entry) => [entry.id, entry]));
  let updated = 0;
  for (const id of ids) {
    if (byId.get(id)?.status !== "active") {
      continue;
    }
    const done = await store.updateOpportunityStatus(user.sub, id, "read");
    if (done) {
      updated += 1;
    }
  }
  return NextResponse.json({ updated });
}
