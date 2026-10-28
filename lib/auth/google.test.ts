import {
  createSign,
  generateKeyPairSync,
  type KeyObject,
} from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import {
  resetCertCacheForTests,
  verifyGoogleIdToken,
  type CertFetcher,
} from "./google";

beforeEach(() => {
  resetCertCacheForTests();
});

const CLIENT_ID = "test-client-id.apps.googleusercontent.com";

function base64url(value: string): string {
  return Buffer.from(value).toString("base64url");
}

function signJwt(
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
  privateKey: KeyObject,
): string {
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  return `${signingInput}.${signer.sign(privateKey, "base64url")}`;
}

function keyPair() {
  return generateKeyPairSync("rsa", { modulusLength: 2048 });
}

function jwkOf(publicKey: ReturnType<typeof keyPair>["publicKey"]) {
  return publicKey.export({ format: "jwk" }) as {
    kty: string;
    n: string;
    e: string;
  };
}

function stubFetch(
  jwks: Array<{ kid: string; n: string; e: string }>,
): CertFetcher {
  return () =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          keys: jwks.map((k) => ({ ...k, kty: "RSA" })),
        }),
    });
}

function payload(overrides: Record<string, unknown> = {}) {
  return {
    iss: "https://accounts.google.com",
    aud: CLIENT_ID,
    sub: "user-123",
    exp: Math.floor(Date.now() / 1000) + 3600,
    iat: Math.floor(Date.now() / 1000),
    name: "Test User",
    email: "test@example.com",
    picture: "https://example.com/photo.jpg",
    ...overrides,
  };
}

describe("verifyGoogleIdToken", () => {
  it("accepts a valid token and returns the profile", async () => {
    const keys = keyPair();
    const token = signJwt(
      { alg: "RS256", kid: "key-1" },
      payload(),
      keys.privateKey,
    );
    const profile = await verifyGoogleIdToken(
      token,
      CLIENT_ID,
      stubFetch([{ kid: "key-1", ...jwkOf(keys.publicKey) }]),
    );
    expect(profile).toEqual({
      sub: "user-123",
      name: "Test User",
      email: "test@example.com",
      picture: "https://example.com/photo.jpg",
    });
  });

  it("rejects tokens for a different audience", async () => {
    const keys = keyPair();
    const token = signJwt(
      { alg: "RS256", kid: "key-1" },
      payload({ aud: "attacker-client-id" }),
      keys.privateKey,
    );
    expect(
      await verifyGoogleIdToken(
        token,
        CLIENT_ID,
        stubFetch([{ kid: "key-1", ...jwkOf(keys.publicKey) }]),
      ),
    ).toBeNull();
  });

  it("rejects expired tokens", async () => {
    const keys = keyPair();
    const token = signJwt(
      { alg: "RS256", kid: "key-1" },
      payload({ exp: Math.floor(Date.now() / 1000) - 3600 }),
      keys.privateKey,
    );
    expect(
      await verifyGoogleIdToken(
        token,
        CLIENT_ID,
        stubFetch([{ kid: "key-1", ...jwkOf(keys.publicKey) }]),
      ),
    ).toBeNull();
  });

  it("rejects forged signatures", async () => {
    const real = keyPair();
    const attacker = keyPair();
    const token = signJwt(
      { alg: "RS256", kid: "key-1" },
      payload(),
      attacker.privateKey,
    );
    expect(
      await verifyGoogleIdToken(
        token,
        CLIENT_ID,
        stubFetch([{ kid: "key-1", ...jwkOf(real.publicKey) }]),
      ),
    ).toBeNull();
  });

  it("rejects unknown key ids and malformed tokens", async () => {
    const keys = keyPair();
    const token = signJwt(
      { alg: "RS256", kid: "unknown" },
      payload(),
      keys.privateKey,
    );
    expect(
      await verifyGoogleIdToken(
        token,
        CLIENT_ID,
        stubFetch([{ kid: "key-1", ...jwkOf(keys.publicKey) }]),
      ),
    ).toBeNull();
    expect(await verifyGoogleIdToken("not-a-token", CLIENT_ID)).toBeNull();
    expect(await verifyGoogleIdToken("a.b.c", CLIENT_ID)).toBeNull();
    const noAlg = signJwt({ kid: "key-1" }, payload(), keys.privateKey);
    expect(await verifyGoogleIdToken(noAlg, CLIENT_ID)).toBeNull();
  });

  it("returns null when certs cannot be fetched", async () => {
    const keys = keyPair();
    const token = signJwt(
      { alg: "RS256", kid: "key-1" },
      payload(),
      keys.privateKey,
    );
    const failing: CertFetcher = () =>
      Promise.reject(new Error("offline"));
    expect(await verifyGoogleIdToken(token, CLIENT_ID, failing)).toBeNull();
  });
});
