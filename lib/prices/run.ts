import { z } from "zod";

/**
 * One background monitoring pass, recorded for the status API and UI.
 * Global (not per-user): a cycle scans every owner's watches, and the
 * counts carry no user-identifying data.
 */
export const MonitorRunSchema = z.object({
  id: z.string().min(1).max(64),
  startedAt: z.string().min(1),
  finishedAt: z.string().min(1),
  intervalMinutes: z.number().positive(),
  maxChecksPerCycle: z.number().positive(),
  ownersScanned: z.number().int().nonnegative(),
  due: z.number().int().nonnegative(),
  checked: z.number().int().nonnegative(),
  ok: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  alerts: z.number().int().nonnegative(),
  opportunities: z.number().int().nonnegative(),
  remindersFired: z.number().int().nonnegative().default(0),
  emails: z.number().int().nonnegative().default(0),
  errors: z.array(z.string().max(300)).max(10),
});
export type MonitorRun = z.infer<typeof MonitorRunSchema>;

/** Server-built run input; the store stamps the id. */
export type NewMonitorRun = Omit<z.input<typeof MonitorRunSchema>, "id">;
