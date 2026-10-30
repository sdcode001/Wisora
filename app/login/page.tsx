"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

const GIS_SCRIPT = "https://accounts.google.com/gsi/client";

interface GisCredential {
  credential?: string;
}

interface GisAccounts {
  id: {
    initialize: (options: {
      client_id: string;
      callback: (response: GisCredential) => void;
    }) => void;
    renderButton: (
      element: HTMLElement,
      options: Record<string, string | number | boolean>,
    ) => void;
  };
}

declare global {
  interface Window {
    google?: { accounts: GisAccounts };
  }
}

type PageState =
  | { kind: "loading" }
  | { kind: "ready" }
  | { kind: "signing-in" }
  | { kind: "error"; message: string }
  | { kind: "not-configured" };

function loadGisScript(): Promise<void> {
  if (window.google?.accounts?.id) {
    return Promise.resolve();
  }
  const existing = document.querySelector<HTMLScriptElement>(
    `script[src="${GIS_SCRIPT}"]`,
  );
  if (existing) {
    return new Promise((resolve, reject) => {
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener(
        "error",
        () => reject(new Error("script failed")),
        { once: true },
      );
    });
  }
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = GIS_SCRIPT;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("script failed"));
    document.head.appendChild(script);
  });
}

function withTimeout(promise: Promise<void>, ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out")), ms);
    promise.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error("script failed"));
      },
    );
  });
}

export default function Login() {
  const router = useRouter();
  const buttonRef = useRef<HTMLDivElement | null>(null);
  const [state, setState] = useState<PageState>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    async function setup(): Promise<void> {
      try {
        const me = await fetch("/api/auth/me", { cache: "no-store" });
        if (cancelled) {
          return;
        }
        if (me.ok) {
          const data = (await me.json()) as { user: unknown };
          if (data.user) {
            router.replace("/");
            return;
          }
        }
        const configResponse = await fetch("/api/auth/config");
        const config = (await configResponse.json()) as {
          clientId: string | null;
        };
        if (cancelled) {
          return;
        }
        if (!config.clientId) {
          setState({ kind: "not-configured" });
          return;
        }
        await withTimeout(loadGisScript(), 20000);
        if (cancelled) {
          return;
        }
        if (!window.google?.accounts?.id || !buttonRef.current) {
          throw new Error("Google sign-in did not initialize.");
        }
        window.google.accounts.id.initialize({
          client_id: config.clientId,
          callback: (response) => {
            if (!response.credential) {
              setState({
                kind: "error",
                message: "Google did not return a sign-in credential.",
              });
              return;
            }
            void (async () => {
              setState({ kind: "signing-in" });
              try {
                const login = await fetch("/api/auth/google", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ idToken: response.credential }),
                });
                if (!login.ok) {
                  const data = (await login.json().catch(() => null)) as {
                    error?: string;
                  } | null;
                  throw new Error(
                    data?.error ?? `sign-in failed (${login.status})`,
                  );
                }
                router.push("/");
              } catch (error) {
                setState({
                  kind: "error",
                  message:
                    error instanceof Error
                      ? error.message
                      : "Sign-in failed. Please try again.",
                });
              }
            })();
          },
        });
        buttonRef.current.innerHTML = "";
        window.google.accounts.id.renderButton(buttonRef.current, {
          theme: "filled_black",
          size: "large",
          shape: "pill",
          text: "signin_with",
          width: 300,
        });
        setState({ kind: "ready" });
      } catch {
        if (!cancelled) {
          setState({
            kind: "error",
            message:
              "Could not load Google sign-in. Check your connection and retry.",
          });
        }
      }
    }
    void setup();
    return () => {
      cancelled = true;
    };
  }, [router]);

  return (
    <main className="relative mx-auto flex min-h-screen max-w-3xl flex-col items-center justify-center px-4 py-10 text-stone-200 sm:px-6">
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-0 -z-10 bg-[radial-gradient(70rem_32rem_at_50%_-12%,rgba(45,212,191,0.09),transparent_60%),radial-gradient(40rem_24rem_at_85%_110%,rgba(45,212,191,0.05),transparent_60%)]"
      />
      <section
        aria-label="Sign in"
        className="glass w-full max-w-md rounded-2xl p-8 text-center"
      >
        <p className="text-sm font-semibold tracking-[0.2em] text-teal-300 uppercase">
          Wisora
        </p>
        <h1 className="mt-3 font-serif text-3xl leading-tight text-stone-50">
          Welcome back
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-stone-400">
          Sign in to keep your identity with your decisions. Wisora only
          reads your name, email, and profile photo.
        </p>

        <div className="mt-6 min-h-[52px]" aria-live="polite">
          {(state.kind === "loading" || state.kind === "signing-in") && (
            <p className="flex items-center justify-center gap-2 text-sm text-stone-500">
              <span
                aria-hidden="true"
                className="h-4 w-4 rounded-full border-2 border-stone-500/30 border-t-stone-200 motion-safe:animate-spin"
              />
              {state.kind === "loading"
                ? "Preparing secure sign-in…"
                : "Signing you in…"}
            </p>
          )}
          {state.kind === "not-configured" && (
            <p className="rounded-lg border border-amber-300/30 bg-amber-400/10 p-3 text-sm text-amber-200">
              Google sign-in is not configured yet. Add
              GOOGLE_OAUTH_CLIENT_ID to .env to enable it.
            </p>
          )}
          {state.kind === "error" && (
            <div className="flex flex-col items-center">
              <p className="rounded-lg border border-red-400/30 bg-red-500/10 p-3 text-sm text-red-200">
                {state.message}
              </p>
              <button
                type="button"
                onClick={() => window.location.reload()}
                className="mt-3 rounded-lg border border-white/15 bg-white/5 px-4 py-2 text-sm font-semibold text-stone-200 transition hover:border-teal-300/50 hover:text-teal-200"
              >
                Retry
              </button>
            </div>
          )}
          {/* Always mounted: the sign-in button renders into this div. */}
          <div
            ref={buttonRef}
            className={
              state.kind === "signing-in" || state.kind === "error"
                ? "hidden"
                : "flex justify-center"
            }
          />
        </div>

        <p className="mt-6 text-xs text-stone-500">
          Protected by Google · Wisora never sees your password
        </p>
      </section>
    </main>
  );
}
