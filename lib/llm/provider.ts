import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { CategorySchema } from "../../config/sources";

export const LlmIntentSchema = z.object({
  category: CategorySchema,
  budgetInrMax: z.number().positive().nullable().optional(),
  searchTerms: z.string().min(1).max(300),
});
export type LlmIntent = z.infer<typeof LlmIntentSchema>;

export const LlmVerdictSchema = z.object({
  verdict: z.enum(["BUY", "WAIT", "AVOID"]),
  productId: z.string().nullable().optional(),
  reason: z.string().min(20).max(1500),
  tradeoffs: z.array(z.string()).default([]),
  uncertainties: z.array(z.string()).default([]),
});
export type LlmVerdict = z.infer<typeof LlmVerdictSchema>;

export interface VerdictCandidate {
  id: string;
  title: string;
  merchant: string;
  priceInr?: number;
  priceEvidence?: string;
  rating?: { value: number; count?: number };
  snippet: string;
}

export interface ExplainVerdictRequest {
  query: string;
  budgetMax?: number;
  candidates: VerdictCandidate[];
  topReasons: string[];
}

export interface LlmProvider {
  readonly name: string;
  extractIntent(query: string): Promise<LlmIntent>;
  explainVerdict(request: ExplainVerdictRequest): Promise<LlmVerdict>;
}

export interface CliLlmOptions {
  model: string;
  effort: string;
  apiKey: string;
  bin?: string;
  baseUrl?: string;
  timeoutMs?: number;
}

function extractJson(stdout: string): unknown {
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("model output contained no JSON object");
  }
  return JSON.parse(stdout.slice(start, end + 1)) as unknown;
}

function buildIntentPrompt(query: string): string {
  return [
    "You are Wisora's intent extractor. Read the shopping request and respond",
    "with ONLY a JSON object, no other text. Schema:",
    '{"category": one of electronics|fashion|footwear|beauty|home-kitchen|general,',
    ' "budgetInrMax": maximum budget in INR as a plain number, or null if none stated,',
    ' "searchTerms": concise product search terms}',
    `Request: ${JSON.stringify(query)}`,
  ].join("\n");
}

function buildVerdictPrompt(request: ExplainVerdictRequest): string {
  const lines = [
    "You are Wisora's recommendation engine. Given verified shopping options,",
    "respond with ONLY a JSON object, no other text. Rules:",
    "- verdict is BUY only for an option with a verified price that fits the budget; set productId to its id.",
    "- WAIT only with a concrete, stated reason (e.g. price unverified, over budget, key details missing).",
    "  Never invent sales, price drops, launches, or reviews.",
    "- AVOID for a poor match; explain which requirement it fails.",
    "- reason: 1-3 sentences. tradeoffs: honest trade-offs. uncertainties: what could change the verdict.",
    "- Use only the options below. Never invent products, prices, or facts.",
    `Budget max (INR): ${request.budgetMax ?? "none stated"}`,
    "Options:",
  ];
  for (const candidate of request.candidates) {
    lines.push(
      `- id: ${candidate.id} | ${candidate.title} (${candidate.merchant}) | ` +
        `${candidate.priceInr != null ? `₹${candidate.priceInr} (${candidate.priceEvidence ?? "unknown"})` : "price unavailable"} | ` +
        `${candidate.rating != null ? `rating ${candidate.rating.value}${candidate.rating.count != null ? ` (${candidate.rating.count} ratings)` : ""}` : "no rating found"} | ` +
        `${candidate.snippet.slice(0, 200)}`,
    );
  }
  if (request.topReasons.length > 0) {
    lines.push(`Top deterministic signals: ${request.topReasons.join("; ")}`);
  }
  lines.push(
    'Schema: {"verdict": "BUY"|"WAIT"|"AVOID", "productId": "id or null",',
    ' "reason": "...", "tradeoffs": [...], "uncertainties": [...]}',
  );
  return lines.join("\n");
}

const MAX_OUTPUT_BYTES = 1024 * 1024;

function runCli(
  bin: string,
  args: string[],
  stdinData: string,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      reject(error);
    };
    const timer = setTimeout(() => {
      fail(new Error(`muse exec timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > MAX_OUTPUT_BYTES) {
        fail(new Error("muse exec output exceeded size limit"));
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error: Error) => {
      fail(error);
    });
    child.on("close", (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`muse exec exited ${String(code)}: ${stderr.slice(0, 500)}`));
      }
    });
    child.stdin.write(stdinData);
    child.stdin.end();
  });
}

export class CliLlmProvider implements LlmProvider {
  readonly name = "muse-exec";

  private readonly opts: CliLlmOptions;

  constructor(opts: CliLlmOptions) {
    this.opts = opts;
  }

  private async runPrompt(prompt: string): Promise<unknown> {
    let lastError: unknown = new Error("unreachable");
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const dir = await mkdtemp(join(tmpdir(), "wisora-"));
      try {
        const promptFile = join(dir, "prompt.txt");
        await writeFile(promptFile, prompt, "utf8");
        const args = [
          "exec",
          "--provider",
          "meta",
          "--model",
          this.opts.model,
          "--effort",
          this.opts.effort,
          "--api-key-stdin",
          "--prompt-file",
          promptFile,
        ];
        if (this.opts.baseUrl) {
          args.push("--base-url", this.opts.baseUrl);
        }
        const stdout = await runCli(
          this.opts.bin ?? "muse",
          args,
          this.opts.apiKey,
          this.opts.timeoutMs ?? 60000,
        );
        return extractJson(stdout);
      } catch (error) {
        lastError = error;
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
    throw lastError;
  }

  async extractIntent(query: string): Promise<LlmIntent> {
    return LlmIntentSchema.parse(await this.runPrompt(buildIntentPrompt(query)));
  }

  async explainVerdict(request: ExplainVerdictRequest): Promise<LlmVerdict> {
    return LlmVerdictSchema.parse(
      await this.runPrompt(buildVerdictPrompt(request)),
    );
  }
}

function buildProvider(effort: string, timeoutMs: number): LlmProvider | null {
  const apiKey = process.env.META_API_KEY;
  if (!apiKey) {
    return null;
  }
  return new CliLlmProvider({
    model: process.env.WISORA_MUSE_MODEL ?? "muse-spark-1.3",
    effort,
    apiKey,
    bin: process.env.WISORA_MUSE_BIN,
    baseUrl: process.env.WISORA_MUSE_BASE_URL,
    timeoutMs,
  });
}

export function getLlmProvider(): LlmProvider | null {
  return buildProvider(
    process.env.WISORA_MUSE_EFFORT_CLASSIFY ?? "low",
    60000,
  );
}

export function getReasonProvider(): LlmProvider | null {
  return buildProvider(
    process.env.WISORA_MUSE_EFFORT_REASON ?? "medium",
    120000,
  );
}
