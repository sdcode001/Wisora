import { NextRequest } from "next/server";
import { expect, test } from "vitest";
import { memoryRequest, setupMemoryEnv, setupTempMemoryDir } from "../../memory/test-helpers";
import { GET } from "./route";

setupMemoryEnv();

test("monitor status requires a signed-in user", async () => {
  await setupTempMemoryDir();
  expect(
    (await GET(new NextRequest("http://localhost/api/prices/monitor"))).status,
  ).toBe(401);
});

test("monitor status reports this process honestly", async () => {
  await setupTempMemoryDir();
  const response = await GET(
    memoryRequest("http://localhost/api/prices/monitor"),
  );
  const body = (await response.json()) as {
    monitoring: {
      active: boolean;
      intervalMinutes: number;
      maxChecksPerCycle: number;
      tavilyConfigured: boolean;
      emailConfigured: boolean;
    };
  };
  expect(body.monitoring.active).toBe(false);
  expect(body.monitoring.intervalMinutes).toBeGreaterThanOrEqual(5);
  expect(typeof body.monitoring.tavilyConfigured).toBe("boolean");
});
