import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import {
  sessionUserFromRequest,
  unauthenticatedResponse,
  unreadableResponse,
} from "../../../lib/auth/require-session";
import {
  FileMemoryStore,
  StoredDataError,
} from "../../../lib/memory/file-store";
import {
  applyGeneralPatch,
  createDefaultProfile,
  GeneralPreferencesPatchSchema,
  ProvenanceSchema,
} from "../../../lib/memory/profile";

const PutBodySchema = z.object({
  general: GeneralPreferencesPatchSchema,
  provenance: ProvenanceSchema.optional(),
});

export async function GET(request: NextRequest): Promise<NextResponse> {
  const user = sessionUserFromRequest(request);
  if (!user) {
    return unauthenticatedResponse();
  }
  try {
    const profile = await new FileMemoryStore().getProfile(user.sub);
    return NextResponse.json({ profile });
  } catch (error) {
    if (error instanceof StoredDataError) {
      return unreadableResponse(error.message);
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
  const parsed = PutBodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "Body must be { general: <preference fields> }.",
        code: "invalid-preferences",
      },
      { status: 400 },
    );
  }
  const store = new FileMemoryStore();
  try {
    const base =
      (await store.getProfile(user.sub)) ??
      createDefaultProfile(user.sub, {
        provenance: parsed.data.provenance ?? "explicit",
      });
    const profile = {
      ...base,
      general: {
        value: applyGeneralPatch(base.general.value, parsed.data.general),
        updatedAt: new Date().toISOString(),
        provenance: parsed.data.provenance ?? "explicit",
      },
    };
    await store.saveProfile(profile);
    return NextResponse.json({ profile });
  } catch (error) {
    if (error instanceof StoredDataError) {
      return unreadableResponse(error.message);
    }
    throw error;
  }
}

export async function DELETE(request: NextRequest): Promise<NextResponse> {
  const user = sessionUserFromRequest(request);
  if (!user) {
    return unauthenticatedResponse();
  }
  const cleared = await new FileMemoryStore().clearProfile(user.sub);
  return NextResponse.json({ cleared });
}
