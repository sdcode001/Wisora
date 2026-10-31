import type { MemoryStore } from "../memory/store";
import { FileMemoryStore } from "../memory/file-store";
import {
  detectionThresholdsFromEnv,
  type DetectionThresholds,
} from "../opportunities/detect";
import { maybeSendOpportunityEmail } from "../opportunities/email";
import { evaluateWatchForOpportunities } from "../opportunities/evaluate";
import { maybeSendReminderEmail } from "../reminders/email";
import { fireDueReminders } from "../reminders/fire";
import type { Watch } from "./observation";
import {
  runWatchCheck,
  tavilyPageFetcher,
  type PageFetcher,
} from "./check";
import { notifierFromEnv, type Notifier } from "./notify";

export const DEFAULT_INTERVAL_MINUTES = 240; // 4 hours
export const DEFAULT_MAX_CHECKS_PER_CYCLE = 10;
export const MIN_INTERVAL_MINUTES = 5;

export interface MonitorConfig {
  intervalMinutes: number;
  maxChecksPerCycle: number;
}

export function monitorConfigFromEnv(): MonitorConfig {
  const interval = Number.parseInt(
    process.env.WISORA_CHECK_INTERVAL_MINUTES ?? "",
    10,
  );
  const maxChecks = Number.parseInt(
    process.env.WISORA_MAX_CHECKS_PER_CYCLE ?? "",
    10,
  );
  return {
    intervalMinutes: Number.isFinite(interval)
      ? Math.max(MIN_INTERVAL_MINUTES, interval)
      : DEFAULT_INTERVAL_MINUTES,
    maxChecksPerCycle: Number.isFinite(maxChecks)
      ? Math.max(1, Math.min(50, maxChecks))
      : DEFAULT_MAX_CHECKS_PER_CYCLE,
  };
}

export interface CycleResult {
  ownersScanned: number;
  due: number;
  checked: number;
  ok: number;
  failed: number;
  alerts: number;
  opportunities: number;
  remindersFired: number;
  /** Opportunity/reminder emails sent (watch-target alert emails excluded). */
  emails: number;
  errors: string[];
}

function lastCheckMs(watch: Watch): number {
  if (!watch.lastCheck) {
    return 0;
  }
  const time = new Date(watch.lastCheck.at).getTime();
  return Number.isFinite(time) ? time : 0;
}

/**
 * One monitoring pass: find due watches across all users (active, never
 * checked or older than the interval), check the stalest first up to the
 * per-cycle cap. One watch's failure never aborts the rest.
 */
export async function runMonitoringCycle(args: {
  store: MemoryStore;
  fetchPage: PageFetcher;
  notifier: Notifier;
  config: MonitorConfig;
  thresholds?: DetectionThresholds;
  nowMs?: number;
}): Promise<CycleResult> {
  const { store, fetchPage, notifier, config } = args;
  const thresholds = args.thresholds ?? detectionThresholdsFromEnv();
  const nowMs = args.nowMs ?? Date.now();
  const now = new Date(nowMs).toISOString();
  const startedAt = new Date().toISOString();
  const intervalMs = config.intervalMinutes * 60 * 1000;
  const result: CycleResult = {
    ownersScanned: 0,
    due: 0,
    checked: 0,
    ok: 0,
    failed: 0,
    alerts: 0,
    opportunities: 0,
    remindersFired: 0,
    emails: 0,
    errors: [],
  };
  // Per-cycle proactive cache: one settings read per user per cycle.
  const proactiveCache = new Map<string, boolean>();
  const isProactive = async (userSub: string): Promise<boolean> => {
    const cached = proactiveCache.get(userSub);
    if (cached !== undefined) {
      return cached;
    }
    const enabled = await store
      .getNotificationSettings(userSub)
      .then((settings) => settings.proactiveEnabled)
      .catch(() => true);
    proactiveCache.set(userSub, enabled);
    return enabled;
  };
  const finish = async (): Promise<CycleResult> => {
    try {
      await store.recordMonitorRun({
        startedAt,
        finishedAt: new Date().toISOString(),
        intervalMinutes: config.intervalMinutes,
        maxChecksPerCycle: config.maxChecksPerCycle,
        ownersScanned: result.ownersScanned,
        due: result.due,
        checked: result.checked,
        ok: result.ok,
        failed: result.failed,
        alerts: result.alerts,
        opportunities: result.opportunities,
        remindersFired: result.remindersFired,
        emails: result.emails,
        errors: result.errors.slice(0, 10),
      });
    } catch (error) {
      result.errors.push(
        `Run log failed: ${error instanceof Error ? error.message.slice(0, 150) : "unknown error"}`,
      );
    }
    return result;
  };
  let owners: string[];
  try {
    owners = await store.listWatchOwners();
  } catch (error) {
    result.errors.push(
      error instanceof Error ? error.message.slice(0, 200) : "Owner scan failed.",
    );
    return finish();
  }
  result.ownersScanned = owners.length;
  const due: Array<{ userSub: string; watch: Watch }> = [];
  for (const userSub of owners) {
    try {
      const watches = await store.listWatches(userSub);
      for (const watch of watches) {
        if (
          watch.active &&
          (watch.lastCheck === undefined ||
            nowMs - lastCheckMs(watch) >= intervalMs)
        ) {
          due.push({ userSub, watch });
        }
      }
    } catch (error) {
      if (result.errors.length < 5) {
        result.errors.push(
          `Watchlist unreadable for one user: ${error instanceof Error ? error.message.slice(0, 150) : "unknown error"}`,
        );
      }
    }
  }
  due.sort(
    (a, b) => lastCheckMs(a.watch) - lastCheckMs(b.watch),
  );
  result.due = due.length;
  for (const { userSub, watch } of due.slice(0, config.maxChecksPerCycle)) {
    try {
      const previousStatus = watch.lastCheck?.status;
      const outcome = await runWatchCheck({
        store,
        userSub,
        watch,
        fetchPage,
        notifier,
        now,
      });
      result.checked += 1;
      if (outcome.status === "ok") {
        result.ok += 1;
      } else {
        result.failed += 1;
      }
      if (outcome.alert) {
        result.alerts += 1;
      }
      // Fresh state only: transient failures re-evaluate nothing.
      // Users who disabled proactive cards keep checks and target alerts,
      // but get no new opportunities or emails from this cycle.
      if (
        (outcome.status === "ok" || outcome.status === "unavailable") &&
        (await isProactive(userSub))
      ) {
        try {
          const evaluated = await evaluateWatchForOpportunities({
            store,
            userSub,
            watch: outcome.watch,
            previousStatus,
            thresholds,
            nowMs,
          });
          result.opportunities += evaluated.created.length;
          for (const opportunity of evaluated.created) {
            try {
              const sent = await maybeSendOpportunityEmail({
                store,
                notifier,
                userSub,
                opportunity,
              });
              if (sent) {
                result.emails += 1;
              }
            } catch {
              if (result.errors.length < 5) {
                result.errors.push(
                  `Opportunity email failed for ${watch.title}.`,
                );
              }
            }
          }
        } catch (error) {
          if (result.errors.length < 5) {
            result.errors.push(
              `Opportunity check failed for ${watch.title}: ${error instanceof Error ? error.message.slice(0, 130) : "unknown error"}`,
            );
          }
        }
      }
    } catch (error) {
      result.failed += 1;
      if (result.errors.length < 5) {
        result.errors.push(
          `Check failed for ${watch.title}: ${error instanceof Error ? error.message.slice(0, 150) : "unknown error"}`,
        );
      }
    }
  }
  let reminderOwners: string[] = [];
  try {
    reminderOwners = await store.listReminderOwners();
  } catch (error) {
    if (result.errors.length < 5) {
      result.errors.push(
        `Reminder scan failed: ${error instanceof Error ? error.message.slice(0, 150) : "unknown error"}`,
      );
    }
  }
  for (const userSub of reminderOwners) {
    try {
      if (!(await isProactive(userSub))) {
        continue;
      }
      const fired = await fireDueReminders({ store, userSub, nowMs });
      result.remindersFired += fired.fired.length;
      result.opportunities += fired.opportunities.length;
      for (const opportunity of fired.opportunities) {
        try {
          const sent = await maybeSendOpportunityEmail({
            store,
            notifier,
            userSub,
            opportunity,
          });
          if (sent) {
            result.emails += 1;
          }
        } catch {
          if (result.errors.length < 5) {
            result.errors.push("Reminder email failed for one user.");
          }
        }
      }
      // Freeform reminders (no feed card) email directly when watch-bound.
      for (const reminder of fired.fired) {
        const hasCard = fired.opportunities.some(
          (entry) => entry.dedupeKey === `reminder-due:${reminder.id}`,
        );
        if (hasCard || !reminder.watchId) {
          continue;
        }
        try {
          const sent = await maybeSendReminderEmail({
            store,
            notifier,
            userSub,
            reminder,
          });
          if (sent) {
            result.emails += 1;
          }
        } catch {
          if (result.errors.length < 5) {
            result.errors.push("Reminder email failed for one user.");
          }
        }
      }
    } catch {
      if (result.errors.length < 5) {
        result.errors.push("Reminder firing failed for one user.");
      }
    }
  }
  return finish();
}

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

export function isMonitoringActive(): boolean {
  return timer !== null;
}

/**
 * Start the background price monitor: one cycle immediately (bounded by
 * the per-cycle cap), then every configured interval. Overlapping cycles
 * are skipped, never stacked. No-op when disabled or unconfigured.
 */
export function startMonitoring(): void {
  if (timer !== null || process.env.WISORA_MONITORING === "off") {
    return;
  }
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) {
    console.warn("[wisora] Price monitor not started: TAVILY_API_KEY is missing.");
    return;
  }
  const config = monitorConfigFromEnv();
  const store = new FileMemoryStore();
  const notifier = notifierFromEnv();
  const tick = (): void => {
    if (running) {
      return;
    }
    running = true;
    runMonitoringCycle({
      store,
      fetchPage: (url) => tavilyPageFetcher(apiKey, url),
      notifier,
      config,
    })
      .then((result) => {
        if (
          result.checked > 0 ||
          result.opportunities > 0 ||
          result.errors.length > 0
        ) {
          console.log(
            `[wisora] Price monitor: ${result.checked} checked, ` +
              `${result.alerts} alerts, ` +
              `${result.opportunities} opportunities, ` +
              `${result.remindersFired} reminders, ` +
              `${result.emails} emails ` +
              `(${result.failed} failed).`,
          );
        }
      })
      .catch((error: unknown) => {
        console.error(
          "[wisora] Price monitor cycle failed:",
          error instanceof Error ? error.message : error,
        );
      })
      .finally(() => {
        running = false;
      });
  };
  timer = setInterval(tick, config.intervalMinutes * 60 * 1000);
  const handle = timer as unknown as { unref?: () => void };
  if (typeof handle.unref === "function") {
    handle.unref();
  }
  tick();
}

export function stopMonitoring(): void {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}
