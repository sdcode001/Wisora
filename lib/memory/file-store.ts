import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { UserProfileSchema, type UserProfile } from "./profile";
import {
  DecisionRecordSchema,
  FeedbackSchema,
  NewDecisionRecordSchema,
  NewFeedbackSchema,
  NewSavedComparisonSchema,
  NewSavedProductSchema,
  SavedComparisonSchema,
  SavedProductSchema,
  createRecordId,
  type DecisionRecord,
  type Feedback,
  type NewDecisionRecord,
  type NewFeedback,
  type NewSavedComparison,
  type NewSavedProduct,
  type SavedComparison,
  type SavedProduct,
} from "./records";
import {
  ProposalSchema,
  type NewProposal,
  type Proposal,
  type ProposalStatus,
} from "./proposals";
import type { MemoryStore } from "./store";

/**
 * Stored bytes exist but cannot be used (unsupported version, identity
 * mismatch, unreadable directory). Routes map this to an honest 500 —
 * the bytes on disk are left untouched for inspection.
 */
export class StoredDataError extends Error {}

/** Growth bounds per record file; oldest entries past the cap drop on write. */
export const MAX_DECISIONS = 50;
export const MAX_FEEDBACK = 100;
export const MAX_SAVED_PRODUCTS = 100;
export const MAX_SAVED_COMPARISONS = 30;
export const MAX_PROPOSALS = 50;

export function defaultDataDir(): string {
  return process.env.WISORA_DATA_DIR ?? path.join(process.cwd(), "data");
}

/**
 * File-backed MemoryStore. Each user gets one directory named by the
 * SHA-256 of their subject (so the raw sub is never a filename), holding
 * `profile.json` plus one JSON file per record list. Writes are atomic
 * (temp file + rename); reads validate against the record schemas, and
 * unparseable files are quarantined (bytes preserved) instead of trusted.
 */
export class FileMemoryStore implements MemoryStore {
  constructor(private readonly rootDir: string = defaultDataDir()) {}

  private userDir(userSub: string): string {
    const hash = createHash("sha256")
      .update(userSub, "utf8")
      .digest("hex")
      .slice(0, 32);
    return path.join(this.rootDir, "users", hash);
  }

  private profileFile(userSub: string): string {
    return path.join(this.userDir(userSub), "profile.json");
  }

  private listFile(userSub: string, name: string): string {
    return path.join(this.userDir(userSub), name);
  }

  private async readList<T>(
    file: string,
    parse: (data: unknown) => T[] | null,
  ): Promise<T[]> {
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      await this.quarantine(file);
      return [];
    }
    const parsed = parse(data);
    if (!parsed) {
      await this.quarantine(file);
      return [];
    }
    return parsed;
  }

  private async writeJson(file: string, value: unknown): Promise<void> {
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
    await rename(tmp, file);
  }

  async getProfile(userSub: string): Promise<UserProfile | null> {
    const file = this.profileFile(userSub);
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Unparseable bytes can never be migrated — quarantine and start fresh.
      await this.quarantine(file);
      return null;
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      (parsed as { version?: unknown }).version !== 1
    ) {
      // Version drift may be recoverable by a future migration: fail
      // loudly and preserve the file instead of quarantining it.
      throw new StoredDataError(`Unsupported profile version in ${file}`);
    }
    const valid = UserProfileSchema.safeParse(parsed);
    if (!valid.success) {
      await this.quarantine(file);
      return null;
    }
    if (valid.data.userSub !== userSub) {
      throw new StoredDataError(`Profile identity mismatch in ${file}`);
    }
    return valid.data;
  }

  async saveProfile(profile: UserProfile): Promise<void> {
    const valid = UserProfileSchema.parse(profile);
    await this.writeJson(this.profileFile(valid.userSub), valid);
  }

  async clearProfile(userSub: string): Promise<boolean> {
    const file = this.profileFile(userSub);
    try {
      await rm(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return false;
      }
      throw error;
    }
    // Best effort: remove the user directory when it holds nothing else.
    // Quarantined files intentionally keep the directory alive.
    try {
      const entries = await readdir(this.userDir(userSub));
      if (entries.length === 0) {
        await rm(this.userDir(userSub), { recursive: true });
      }
    } catch {
      // Directory cleanup is cosmetic; the profile itself is gone.
    }
    return true;
  }

  async listDecisions(
    userSub: string,
    limit?: number,
  ): Promise<DecisionRecord[]> {
    const records = await this.readList(
      this.listFile(userSub, "decisions.json"),
      (data) => {
        const parsed = DecisionRecordSchema.array().safeParse(data);
        return parsed.success ? parsed.data : null;
      },
    );
    return limit === undefined ? records : records.slice(0, limit);
  }

  async saveDecision(
    userSub: string,
    input: NewDecisionRecord,
  ): Promise<DecisionRecord> {
    const file = this.listFile(userSub, "decisions.json");
    const records = await this.listDecisions(userSub);
    const record: DecisionRecord = {
      ...NewDecisionRecordSchema.parse(input),
      id: createRecordId(),
      createdAt: new Date().toISOString(),
    };
    await this.writeJson(file, [record, ...records].slice(0, MAX_DECISIONS));
    return record;
  }

  async listSavedProducts(userSub: string): Promise<SavedProduct[]> {
    return this.readList(this.listFile(userSub, "saved-products.json"), (data) => {
      const parsed = SavedProductSchema.array().safeParse(data);
      return parsed.success ? parsed.data : null;
    });
  }

  async saveSavedProduct(
    userSub: string,
    input: NewSavedProduct,
  ): Promise<SavedProduct> {
    const file = this.listFile(userSub, "saved-products.json");
    const valid = NewSavedProductSchema.parse(input);
    const current = await this.listSavedProducts(userSub);
    const record: SavedProduct = {
      ...valid,
      savedAt: new Date().toISOString(),
    };
    const next = [
      record,
      ...current.filter((item) => item.productId !== valid.productId),
    ].slice(0, MAX_SAVED_PRODUCTS);
    await this.writeJson(file, next);
    return record;
  }

  async deleteSavedProduct(
    userSub: string,
    productId: string,
  ): Promise<boolean> {
    const file = this.listFile(userSub, "saved-products.json");
    const current = await this.listSavedProducts(userSub);
    const next = current.filter((item) => item.productId !== productId);
    if (next.length === current.length) {
      return false;
    }
    await this.writeJson(file, next);
    return true;
  }

  async listSavedComparisons(userSub: string): Promise<SavedComparison[]> {
    return this.readList(
      this.listFile(userSub, "saved-comparisons.json"),
      (data) => {
        const parsed = SavedComparisonSchema.array().safeParse(data);
        return parsed.success ? parsed.data : null;
      },
    );
  }

  async saveSavedComparison(
    userSub: string,
    input: NewSavedComparison,
  ): Promise<SavedComparison> {
    const file = this.listFile(userSub, "saved-comparisons.json");
    const records = await this.listSavedComparisons(userSub);
    const record: SavedComparison = {
      ...NewSavedComparisonSchema.parse(input),
      id: createRecordId(),
      createdAt: new Date().toISOString(),
    };
    await this.writeJson(
      file,
      [record, ...records].slice(0, MAX_SAVED_COMPARISONS),
    );
    return record;
  }

  async deleteSavedComparison(
    userSub: string,
    id: string,
  ): Promise<boolean> {
    const file = this.listFile(userSub, "saved-comparisons.json");
    const current = await this.listSavedComparisons(userSub);
    const next = current.filter((item) => item.id !== id);
    if (next.length === current.length) {
      return false;
    }
    await this.writeJson(file, next);
    return true;
  }

  async listFeedback(
    userSub: string,
    limit?: number,
  ): Promise<Feedback[]> {
    const records = await this.readList(
      this.listFile(userSub, "feedback.json"),
      (data) => {
        const parsed = FeedbackSchema.array().safeParse(data);
        return parsed.success ? parsed.data : null;
      },
    );
    return limit === undefined ? records : records.slice(0, limit);
  }

  async saveFeedback(
    userSub: string,
    input: NewFeedback,
  ): Promise<Feedback> {
    const file = this.listFile(userSub, "feedback.json");
    const records = await this.listFeedback(userSub);
    const record: Feedback = {
      ...NewFeedbackSchema.parse(input),
      id: createRecordId(),
      createdAt: new Date().toISOString(),
    };
    await this.writeJson(file, [record, ...records].slice(0, MAX_FEEDBACK));
    return record;
  }

  async listProposals(userSub: string): Promise<Proposal[]> {
    return this.readList(this.listFile(userSub, "proposals.json"), (data) => {
      const parsed = ProposalSchema.array().safeParse(data);
      return parsed.success ? parsed.data : null;
    });
  }

  async saveProposal(userSub: string, input: NewProposal): Promise<Proposal> {
    const file = this.listFile(userSub, "proposals.json");
    const records = await this.listProposals(userSub);
    const record = ProposalSchema.parse({
      ...input,
      id: createRecordId(),
      createdAt: new Date().toISOString(),
      status: "pending",
    });
    await this.writeJson(file, [record, ...records].slice(0, MAX_PROPOSALS));
    return record;
  }

  async decideProposal(
    userSub: string,
    id: string,
    status: Exclude<ProposalStatus, "pending">,
  ): Promise<Proposal | null> {
    const file = this.listFile(userSub, "proposals.json");
    const records = await this.listProposals(userSub);
    const index = records.findIndex((proposal) => proposal.id === id);
    if (index < 0) {
      return null;
    }
    const current = records[index];
    if (current === undefined || current.status !== "pending") {
      return current ?? null;
    }
    const decided: Proposal = {
      ...current,
      status,
      decidedAt: new Date().toISOString(),
    };
    await this.writeJson(file, [
      ...records.slice(0, index),
      decided,
      ...records.slice(index + 1),
    ]);
    return decided;
  }

  async clearHistory(userSub: string): Promise<{
    decisions: number;
    feedback: number;
    proposals: number;
  }> {
    const [decisions, feedback, proposals] = await Promise.all([
      this.listDecisions(userSub),
      this.listFeedback(userSub),
      this.listProposals(userSub),
    ]);
    await Promise.all(
      ["decisions.json", "feedback.json", "proposals.json"].map((name) =>
        rm(this.listFile(userSub, name), { force: true }),
      ),
    );
    return {
      decisions: decisions.length,
      feedback: feedback.length,
      proposals: proposals.length,
    };
  }

  private async quarantine(file: string): Promise<void> {
    await rename(file, `${file}.corrupt-${Date.now()}`);
  }
}
