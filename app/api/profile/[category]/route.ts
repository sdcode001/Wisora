import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import {
  CategorySchema,
  type Category,
} from "../../../../config/sources";
import {
  sessionUserFromRequest,
  unauthenticatedResponse,
  unreadableResponse,
} from "../../../../lib/auth/require-session";
import {
  FileMemoryStore,
  StoredDataError,
} from "../../../../lib/memory/file-store";
import {
  applyCategoryPatch,
  createDefaultProfile,
  parseCategoryPatch,
  ProvenanceSchema,
} from "../../../../lib/memory/profile";

interface RouteContext {
  params: Promise<{ category: string }>;
}

const PutBodySchema = z.object({
  preferences: z.unknown(),
  provenance: ProvenanceSchema.optional(),
});

function resolveCategory(
  raw: string,
): { category: Category } | { response: NextResponse } {
  const parsed = CategorySchema.safeParse(raw);
  if (!parsed.success) {
    return {
      response: NextResponse.json(
        {
          error: `Unknown category: ${raw}.`,
          code: "unknown-category",
        },
        { status: 400 },
      ),
    };
  }
  return { category: parsed.data };
}

export async function GET(
  request: NextRequest,
  context: RouteContext,
): Promise<NextResponse> {
  const user = sessionUserFromRequest(request);
  if (!user) {
    return unauthenticatedResponse();
  }
  const resolved = resolveCategory((await context.params).category);
  if ("response" in resolved) {
    return resolved.response;
  }
  try {
    const profile = await new FileMemoryStore().getProfile(user.sub);
    return NextResponse.json({
      category: resolved.category,
      preferences: profile?.categories[resolved.category] ?? null,
    });
  } catch (error) {
    if (error instanceof StoredDataError) {
      return unreadableResponse(error.message);
    }
    throw error;
  }
}

export async function PUT(
  request: NextRequest,
  context: RouteContext,
): Promise<NextResponse> {
  const user = sessionUserFromRequest(request);
  if (!user) {
    return unauthenticatedResponse();
  }
  const resolved = resolveCategory((await context.params).category);
  if ("response" in resolved) {
    return resolved.response;
  }
  const category = resolved.category;
  const body: unknown = await request.json().catch(() => null);
  const envelope = PutBodySchema.safeParse(body);
  if (!envelope.success) {
    return NextResponse.json(
      {
        error: "Body must be { preferences: <category fields> }.",
        code: "invalid-preferences",
      },
      { status: 400 },
    );
  }
  const parsed = parseCategoryPatch(category, envelope.data.preferences);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: `Invalid ${category} preferences.`,
        code: "invalid-preferences",
      },
      { status: 400 },
    );
  }
  const store = new FileMemoryStore();
  try {
    const now = new Date().toISOString();
    const provenance = envelope.data.provenance ?? "explicit";
    const base =
      (await store.getProfile(user.sub)) ??
      createDefaultProfile(user.sub, { updatedAt: now, provenance });
    const preferences = {
      value: applyCategoryPatch(
        base.categories[category]?.value,
        category,
        parsed.data,
      ),
      updatedAt: now,
      provenance,
    };
    const categories = { ...base.categories };
    categories[category] = preferences;
    const profile = { ...base, categories };
    await store.saveProfile(profile);
    return NextResponse.json({ category, preferences });
  } catch (error) {
    if (error instanceof StoredDataError) {
      return unreadableResponse(error.message);
    }
    throw error;
  }
}
