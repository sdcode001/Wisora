import { NextResponse } from "next/server";
import { SESSION_COOKIE, verifySession, type SessionUser } from "./session";

/**
 * Resolve the signed-in user from a request's session cookie.
 *
 * Returns null when sessions are unconfigured, the cookie is missing, or
 * the token is invalid/expired. Callers decide the status code (503 when
 * SESSION_SECRET is missing, otherwise 401). Works for both Request and
 * NextRequest since it only reads headers.
 */
export function sessionUserFromRequest(request: Request): SessionUser | null {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    return null;
  }
  const token = readCookie(request.headers.get("cookie"), SESSION_COOKIE);
  if (!token) {
    return null;
  }
  return verifySession(token, secret);
}

/**
 * Shared gate response for session-scoped APIs: 401 for anonymous
 * callers, 503 when the server itself cannot verify sessions.
 */
export function unauthenticatedResponse(): NextResponse {
  if (!process.env.SESSION_SECRET) {
    return NextResponse.json(
      {
        error:
          "Sign-in is not configured (SESSION_SECRET is missing). Add it to .env to enable personal features.",
        code: "auth-not-configured",
      },
      { status: 503 },
    );
  }
  return NextResponse.json(
    { error: "Sign in required.", code: "unauthorized" },
    { status: 401 },
  );
}

/**
 * Shared response for stored data that exists but cannot be used.
 * The bytes on disk are always left untouched for inspection.
 */
export function unreadableResponse(detail: string): NextResponse {
  return NextResponse.json(
    {
      error: `Saved data could not be read (${detail}). Your data on disk is untouched.`,
      code: "profile-unreadable",
    },
    { status: 500 },
  );
}

function readCookie(header: string | null, name: string): string | null {
  if (!header) {
    return null;
  }
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    if (part.slice(0, separator).trim() === name) {
      const value = part.slice(separator + 1).trim();
      return value ? value : null;
    }
  }
  return null;
}
