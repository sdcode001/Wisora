import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, verifySession } from "../../../../lib/auth/session";

/**
 * Session probe. Always returns 200 with the user or null, so signed-out
 * visits don't log console errors — "not signed in" is a normal state,
 * not a failure.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const secret = process.env.SESSION_SECRET;
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  if (!secret || !token) {
    return NextResponse.json({ user: null });
  }
  return NextResponse.json({ user: verifySession(token, secret) });
}
