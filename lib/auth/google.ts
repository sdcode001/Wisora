import { createPublicKey, type KeyObject } from "node:crypto";
import { createVerify } from "node:crypto";

const CERTS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const ISSUERS = new Set([
  "https://accounts.google.com",
  "accounts.google.com",
]);
const CERTS_TTL_MS = 6 * 60 * 60 * 1000;
const CLOCK_SKEW_SECONDS = 60;

export interface GoogleProfile {
  sub: string;
  name: string | null;
  email: string | null;
  picture: string | null;
}

export type CertFetcher = (url: string) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

interface JwtHeader {
  alg?: string;
  kid?: string;
}

interface JwtPayload {
  iss?: string;
  aud?: string | string[];
  sub?: string;
  exp?: number;
  name?: string;
  email?: string;
  picture?: string;
}

function base64urlDecode(input: string): Buffer {
  return Buffer.from(
    input.replace(/-/g, "+").replace(/_/g, "/"),
    "base64",
  );
}

let cachedCerts: { keys: Map<string, KeyObject>; fetchedAt: number } | null =
  null;

/** Test-only: clear the in-memory cert cache between cases. */
export function resetCertCacheForTests(): void {
  cachedCerts = null;
}

async function fetchCerts(
  fetcher: CertFetcher,
): Promise<Map<string, KeyObject>> {
  const response = await fetcher(CERTS_URL);
  if (!response.ok) {
    throw new Error(`Google certs fetch failed (${response.status})`);
  }
  const data = (await response.json()) as {
    keys?: Array<{ kid?: string; kty?: string; n?: string; e?: string }>;
  };
  const keys = new Map<string, KeyObject>();
  for (const key of data.keys ?? []) {
    if (key.kid && key.kty === "RSA" && key.n && key.e) {
      try {
        keys.set(
          key.kid,
          createPublicKey({
            key: { kty: "RSA", n: key.n, e: key.e },
            format: "jwk",
          }),
        );
      } catch {
        // Skip malformed keys.
      }
    }
  }
  return keys;
}

async function publicKeyFor(
  kid: string,
  fetcher: CertFetcher,
  allowRefresh: boolean,
): Promise<KeyObject | null> {
  const fresh =
    cachedCerts != null && Date.now() - cachedCerts.fetchedAt < CERTS_TTL_MS;
  if (!fresh && allowRefresh) {
    try {
      cachedCerts = { keys: await fetchCerts(fetcher), fetchedAt: Date.now() };
    } catch {
      cachedCerts = null;
      return null;
    }
  }
  const key = cachedCerts?.keys.get(kid) ?? null;
  if (!key && allowRefresh && fresh) {
    // Possible key rotation: refresh once.
    cachedCerts = null;
    return publicKeyFor(kid, fetcher, false);
  }
  return key;
}

/**
 * Verify a Google ID token: structure, RS256 signature against Google's
 * published keys, issuer, expiry, and audience (must be OUR client id).
 * Returns the profile on success, null on any failure. Never throws.
 */
export async function verifyGoogleIdToken(
  idToken: string,
  clientId: string,
  fetcher: CertFetcher = fetch,
): Promise<GoogleProfile | null> {
  const parts = idToken.split(".");
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
    return null;
  }
  let header: JwtHeader;
  let payload: JwtPayload;
  try {
    header = JSON.parse(base64urlDecode(parts[0]).toString("utf8")) as JwtHeader;
    payload = JSON.parse(
      base64urlDecode(parts[1]).toString("utf8"),
    ) as JwtPayload;
  } catch {
    return null;
  }
  if (header.alg !== "RS256" || !header.kid) {
    return null;
  }
  if (!payload.iss || !ISSUERS.has(payload.iss)) {
    return null;
  }
  const aud = payload.aud;
  const audOk =
    typeof aud === "string"
      ? aud === clientId
      : Array.isArray(aud) && aud.includes(clientId);
  if (!audOk || typeof payload.sub !== "string" || !payload.sub) {
    return null;
  }
  const now = Math.floor(Date.now() / 1000);
  if (
    typeof payload.exp !== "number" ||
    payload.exp + CLOCK_SKEW_SECONDS < now
  ) {
    return null;
  }
  const key = await publicKeyFor(header.kid, fetcher, true);
  if (!key) {
    return null;
  }
  try {
    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${parts[0]}.${parts[1]}`);
    if (!verifier.verify(key, base64urlDecode(parts[2]))) {
      return null;
    }
  } catch {
    return null;
  }
  return {
    sub: payload.sub,
    name: typeof payload.name === "string" ? payload.name : null,
    email: typeof payload.email === "string" ? payload.email : null,
    picture: typeof payload.picture === "string" ? payload.picture : null,
  };
}
