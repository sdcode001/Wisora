import { NextResponse } from "next/server";
import { SESSION_COOKIE } from "../../../../lib/auth/session";

export async function POST(): Promise<NextResponse> {
  const response = NextResponse.json({ ok: true });
  response.cookies.set(SESSION_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    // Must match the attributes used when the cookie was set, otherwise
    // browsers may keep the session cookie (notably Secure in production).
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 0,
  });
  return response;
}
