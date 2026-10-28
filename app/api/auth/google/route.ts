import { NextResponse } from "next/server";
import { z } from "zod";
import { verifyGoogleIdToken } from "../../../../lib/auth/google";
import {
  createSession,
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
} from "../../../../lib/auth/session";

const BodySchema = z.object({
  idToken: z.string().min(1).max(5000),
});

export async function POST(request: Request): Promise<NextResponse> {
  const body: unknown = await request.json().catch(() => null);
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "idToken must be a non-empty string" },
      { status: 400 },
    );
  }
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const secret = process.env.SESSION_SECRET;
  if (!clientId || !secret) {
    return NextResponse.json(
      {
        error:
          "Sign-in is not configured (GOOGLE_OAUTH_CLIENT_ID or SESSION_SECRET is missing). Add them to .env to enable Google login.",
        code: "auth-not-configured",
      },
      { status: 503 },
    );
  }
  const profile = await verifyGoogleIdToken(parsed.data.idToken, clientId);
  if (!profile) {
    return NextResponse.json(
      {
        error: "Google sign-in could not be verified. Please try again.",
        code: "invalid-id-token",
      },
      { status: 401 },
    );
  }
  const response = NextResponse.json({
    user: {
      sub: profile.sub,
      name: profile.name,
      email: profile.email,
      picture: profile.picture,
    },
  });
  response.cookies.set(
    SESSION_COOKIE,
    createSession(profile, secret),
    {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: SESSION_MAX_AGE_SECONDS,
    },
  );
  return response;
}
