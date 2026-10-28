import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createSession, verifySession } from "./session";

const SECRET = "test-secret";
const USER = {
  sub: "user-123",
  name: "Test User",
  email: "test@example.com",
  picture: null,
};

describe("session", () => {
  it("round-trips a session", () => {
    const token = createSession(USER, SECRET);
    expect(verifySession(token, SECRET)).toEqual(USER);
  });

  it("rejects tampered bodies and signatures", () => {
    const token = createSession(USER, SECRET);
    const [body, signature] = token.split(".") as [string, string];
    const tamperedBody = `${Buffer.from(
      JSON.stringify({ ...USER, sub: "attacker", exp: 9999999999 }),
    ).toString("base64url")}.${signature}`;
    expect(verifySession(tamperedBody, SECRET)).toBeNull();
    const tamperedSignature = `${body}.${signature.slice(0, -2)}xx`;
    expect(verifySession(tamperedSignature, SECRET)).toBeNull();
  });

  it("rejects expired sessions", () => {
    const body = Buffer.from(
      JSON.stringify({ ...USER, exp: Math.floor(Date.now() / 1000) - 10 }),
    ).toString("base64url");
    const signature = createHmac("sha256", SECRET)
      .update(body)
      .digest("base64url");
    expect(verifySession(`${body}.${signature}`, SECRET)).toBeNull();
  });

  it("rejects malformed tokens and wrong secrets", () => {
    expect(verifySession("garbage", SECRET)).toBeNull();
    expect(verifySession("a.b.c", SECRET)).toBeNull();
    const token = createSession(USER, SECRET);
    expect(verifySession(token, "other-secret")).toBeNull();
  });
});
