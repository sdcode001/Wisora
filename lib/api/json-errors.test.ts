import { NextResponse } from "next/server";
import { expect, test, vi } from "vitest";
import { withJsonErrors } from "./json-errors";

test("passes through successful handler responses untouched", async () => {
  const ok = NextResponse.json({ hello: "world" }, { status: 201 });
  const wrapped = withJsonErrors(async () => ok);
  await expect(wrapped()).resolves.toBe(ok);
});

test("converts a thrown error into a JSON 500 clients can parse", async () => {
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const wrapped = withJsonErrors(async (): Promise<NextResponse> => {
      throw new Error("read-only disk");
    });
    const response = await wrapped();
    expect(response.status).toBe(500);
    // The whole point: this parse must succeed where an HTML/empty 500
    // page would throw "Unexpected end of JSON input".
    const body = (await response.json()) as { error: string; code: string };
    expect(body.code).toBe("internal-error");
    expect(body.error).toContain("went wrong");
    expect(errorSpy).toHaveBeenCalled();
  } finally {
    errorSpy.mockRestore();
  }
});
