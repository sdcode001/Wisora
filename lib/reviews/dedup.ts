import { normalizeUrl } from "../products/schema";
import { contentTokens } from "../text/tokens";
import type { ReviewRecord } from "./types";

const NEAR_DUP_JACCARD = 0.85;
const MIN_TOKENS_FOR_FUZZY = 8;

function tokenSet(text: string): Set<string> {
  return contentTokens(text);
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) {
    return 0;
  }
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) {
      intersection += 1;
    }
  }
  return intersection / (a.size + b.size - intersection);
}

export interface DedupOutcome {
  records: ReviewRecord[];
  merged: number;
}

export function dedupeReviewRecords(
  records: ReviewRecord[],
): DedupOutcome {
  const canonical: ReviewRecord[] = [];
  const canonicalTokens: Array<Set<string>> = [];
  const seenUrls = new Map<string, string>();
  let merged = 0;
  for (const record of records) {
    const normalizedUrl = normalizeUrl(record.url);
    const urlHit = seenUrls.get(normalizedUrl);
    if (urlHit) {
      merged += 1;
      canonical.push({ ...record, duplicateOf: urlHit });
      continue;
    }
    const tokens = tokenSet(record.excerpt);
    let dupOf: string | null = null;
    if (tokens.size >= MIN_TOKENS_FOR_FUZZY) {
      for (let i = 0; i < canonical.length; i += 1) {
        const other = canonical[i];
        const otherTokens = canonicalTokens[i];
        if (
          !other ||
          !otherTokens ||
          other.duplicateOf ||
          otherTokens.size < MIN_TOKENS_FOR_FUZZY
        ) {
          continue;
        }
        if (jaccard(tokens, otherTokens) >= NEAR_DUP_JACCARD) {
          dupOf = other.id;
          break;
        }
      }
    } else {
      // Short excerpts: exact normalized-text match only, to avoid
      // false merges on thin content.
      for (const other of canonical) {
        if (!other.duplicateOf && other.excerpt === record.excerpt) {
          dupOf = other.id;
          break;
        }
      }
    }
    if (dupOf) {
      merged += 1;
      canonical.push({ ...record, duplicateOf: dupOf });
    } else {
      seenUrls.set(normalizedUrl, record.id);
      canonical.push(record);
      canonicalTokens.push(tokens);
    }
  }
  return { records: canonical, merged };
}

/** Records usable for insight counting: not duplicates, not irrelevant. */
export function usableRecords(records: ReviewRecord[]): ReviewRecord[] {
  return records.filter(
    (r) => !r.duplicateOf && r.relevance !== "irrelevant",
  );
}
