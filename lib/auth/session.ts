import { createHmac, timingSafeEqual } from "node:crypto";

export interface SessionUser {
  sub: string;
  name: string | null;
  email: string | null;
  picture: string | null;
}

export const SESSION_COOKIE = "wisora_session";
export const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

interface SessionPayload extends SessionUser {
  exp: number;
}

export function createSession(user: SessionUser, secret: string): string {
  const payload: SessionPayload = {
    ...user,
    exp: Math.floor(Date.now() / 1000) + SESSION_MAX_AGE_SECONDS,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${signature}`;
}

export function verifySession(
  token: string,
  secret: string,
): SessionUser | null {
  const separator = token.indexOf(".");
  if (separator <= 0) {
    return null;
  }
  const body = token.slice(0, separator);
  const signature = token.slice(separator + 1);
  const expected = createHmac("sha256", secret).update(body).digest();
  let actual: Buffer;
  try {
    actual = Buffer.from(signature, "base64url");
  } catch {
    return null;
  }
  if (actual.length !== expected.length) {
    return null;
  }
  if (!timingSafeEqual(actual, expected)) {
    return null;
  }
  try {
    const payload = JSON.parse(
      Buffer.from(body, "base64url").toString("utf8"),
    ) as Partial<SessionPayload>;
    if (
      typeof payload.sub !== "string" ||
      !payload.sub ||
      typeof payload.exp !== "number" ||
      payload.exp <= Date.now() / 1000
    ) {
      return null;
    }
    return {
      sub: payload.sub,
      name: payload.name ?? null,
      email: payload.email ?? null,
      picture: payload.picture ?? null,
    };
  } catch {
    return null;
  }
}
