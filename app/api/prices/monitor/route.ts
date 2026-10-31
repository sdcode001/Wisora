import { NextResponse, type NextRequest } from "next/server";
import {
  sessionUserFromRequest,
  unauthenticatedResponse,
} from "../../../../lib/auth/require-session";
import { FileMemoryStore } from "../../../../lib/memory/file-store";
import {
  isMonitoringActive,
  monitorConfigFromEnv,
} from "../../../../lib/prices/monitor";

/**
 * Monitor liveness for this server process. Note the honesty boundary:
 * `active` describes THIS process only — serverless or multi-instance
 * deployments need an external cron instead (see README).
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const user = sessionUserFromRequest(request);
  if (!user) {
    return unauthenticatedResponse();
  }
  const config = monitorConfigFromEnv();
  const store = new FileMemoryStore();
  const runs = await store.listMonitorRuns(1);
  return NextResponse.json({
    monitoring: {
      active: isMonitoringActive(),
      intervalMinutes: config.intervalMinutes,
      maxChecksPerCycle: config.maxChecksPerCycle,
      tavilyConfigured: Boolean(process.env.TAVILY_API_KEY),
      emailConfigured: Boolean(
        process.env.RESEND_API_KEY && process.env.RESEND_FROM,
      ),
      lastRun: runs[0] ?? null,
    },
  });
}
