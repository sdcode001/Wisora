import { NextResponse } from "next/server";
import { z } from "zod";
import { resolveIntent } from "../../../lib/intent/service";

const BodySchema = z.object({
  query: z.string().trim().min(2).max(500),
});

export async function POST(request: Request): Promise<NextResponse> {
  const body: unknown = await request.json().catch(() => null);
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "query must be a string of 2–500 characters" },
      { status: 400 },
    );
  }
  const resolved = await resolveIntent(parsed.data.query);
  return NextResponse.json(resolved);
}
