import { NextResponse } from "next/server";

/**
 * Wrap a route handler so unexpected failures always produce a JSON error
 * body. Without this, a thrown error (read-only disk on serverless, a dead
 * upstream, a missing binary) makes Next return an HTML or empty 500 page,
 * and every client `response.json()` call fails with the cryptic
 * "Unexpected end of JSON input" instead of a readable error.
 */
export function withJsonErrors<
  TArgs extends unknown[],
  TResponse extends NextResponse,
>(
  handler: (...args: TArgs) => Promise<TResponse>,
): (...args: TArgs) => Promise<TResponse | NextResponse> {
  return async (...args: TArgs) => {
    try {
      return await handler(...args);
    } catch (error) {
      console.error("API handler failed:", error);
      return NextResponse.json(
        {
          error:
            "Something went wrong handling that request. Please try again.",
          code: "internal-error",
        },
        { status: 500 },
      );
    }
  };
}
