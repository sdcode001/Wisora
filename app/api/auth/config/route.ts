import { NextResponse } from "next/server";

/**
 * Expose the Google OAuth client id to the login page. The client id is
 * public by design (Google embeds it in the sign-in button flow); the
 * session secret never leaves the server.
 */
export async function GET(): Promise<NextResponse> {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID ?? "";
  return NextResponse.json({ clientId: clientId || null });
}
