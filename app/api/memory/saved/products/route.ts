import { NextResponse, type NextRequest } from "next/server";
import {
  sessionUserFromRequest,
  unauthenticatedResponse,
} from "../../../../../lib/auth/require-session";
import { getMemoryStore } from "../../../../../lib/memory/get-store";
import { NewSavedProductSchema } from "../../../../../lib/memory/records";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const user = sessionUserFromRequest(request);
  if (!user) {
    return unauthenticatedResponse();
  }
  const products = await getMemoryStore().listSavedProducts(user.sub);
  return NextResponse.json({ products });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const user = sessionUserFromRequest(request);
  if (!user) {
    return unauthenticatedResponse();
  }
  const body: unknown = await request.json().catch(() => null);
  const parsed = NewSavedProductSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error:
          "Body must be a product snapshot: { productId, title, url, merchant }.",
        code: "invalid-saved-product",
      },
      { status: 400 },
    );
  }
  const product = await getMemoryStore().saveSavedProduct(
    user.sub,
    parsed.data,
  );
  return NextResponse.json({ product });
}

export async function DELETE(request: NextRequest): Promise<NextResponse> {
  const user = sessionUserFromRequest(request);
  if (!user) {
    return unauthenticatedResponse();
  }
  const productId = request.nextUrl.searchParams.get("productId");
  if (!productId) {
    return NextResponse.json(
      { error: "Missing ?productId= query parameter.", code: "missing-id" },
      { status: 400 },
    );
  }
  const deleted = await getMemoryStore().deleteSavedProduct(
    user.sub,
    productId,
  );
  return NextResponse.json({ deleted });
}
