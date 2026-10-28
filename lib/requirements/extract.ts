import type { Intent } from "../intent/types";
import { getLlmProvider, type LlmProvider } from "../llm/provider";
import {
  CATEGORY_LABELS,
  RequirementSetSchema,
  type ClarificationAnswer,
  type ClarificationQuestion,
  type Requirement,
  type RequirementSet,
} from "./types";

const EXCLUSION_RES = [
  /\b(?:no|without|avoid|excluding?)\s+([a-z][a-z0-9\s-]{1,40}?)(?=[,.;]| and | or | with | under | over |$)/gi,
  /\bnot\s+(?:into|interested in)\s+([a-z][a-z0-9\s-]{1,40}?)(?=[,.;]| and | or |$)/gi,
];

const EXCLUSION_STOPLIST = /\b(budget|limit|preference|idea|hurry|rush|problem|issue)\b/i;

function slugify(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function dedupeByKey(items: Requirement[]): Requirement[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (!item.key || seen.has(item.key)) {
      return false;
    }
    seen.add(item.key);
    return true;
  });
}

export function extractExclusionRules(query: string): Requirement[] {
  const found: Requirement[] = [];
  for (const re of EXCLUSION_RES) {
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(query)) !== null && found.length < 5) {
      const label = match[1]?.trim().replace(/\s+/g, " ") ?? "";
      if (label.length < 2 || EXCLUSION_STOPLIST.test(label)) {
        continue;
      }
      if (/^(?:a|an|the|it|that|this)$/i.test(label)) {
        continue;
      }
      found.push({
        key: slugify(label),
        label,
        kind: "exclude",
        importance: 1,
        evidence: match[0].trim(),
      });
    }
  }
  return dedupeByKey(found);
}

export interface ExtractRequirementsOptions {
  provider?: LlmProvider | null;
  answers?: ClarificationAnswer[];
}

export async function extractRequirements(
  query: string,
  intent: Intent,
  options: ExtractRequirementsOptions = {},
): Promise<{
  requirements: RequirementSet;
  questions: ClarificationQuestion[];
}> {
  const withAnswers =
    options.answers?.length
      ? `${query}\nUser clarifications: ${options.answers
          .map((a) => `${a.questionId}=${a.value}`)
          .join("; ")}`
      : query;
  const rules = extractExclusionRules(query);
  const provider =
    options.provider === undefined ? getLlmProvider() : options.provider;
  let llm: Awaited<ReturnType<LlmProvider["extractRequirements"]>> | null =
    null;
  if (provider?.available) {
    try {
      llm = await provider.extractRequirements(withAnswers, intent.category);
    } catch {
      llm = null;
    }
  }
  const requirements = RequirementSetSchema.parse({
    category: intent.category,
    useContext: llm?.useContext ?? undefined,
    must: (llm?.must ?? []).map((r) => ({ ...r, kind: "must" as const, importance: 1 })),
    want: (llm?.want ?? []).map((r) => ({ ...r, kind: "want" as const })),
    exclude: dedupeByKey([
      ...rules,
      ...(llm?.exclude ?? []).map((r) => ({
        ...r,
        kind: "exclude" as const,
        importance: 1,
      })),
    ]),
    unanswered: llm?.unanswered ?? [],
  });
  const questions = options.answers?.length
    ? []
    : decideClarification(intent, requirements);
  return { requirements, questions };
}

export function decideClarification(
  intent: Intent,
  requirements: RequirementSet,
): ClarificationQuestion[] {
  const questions: ClarificationQuestion[] = [];
  if (intent.categoryConfidence === "low") {
    questions.push({
      id: "category",
      prompt: "Which category best matches what you're looking for?",
      options: Object.values(CATEGORY_LABELS),
      freeText: false,
    });
  }
  const first = requirements.unanswered[0];
  if (first && questions.length < 2) {
    questions.push({ id: "q0", prompt: first, freeText: true });
  }
  return questions.slice(0, 2);
}
