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

/**
 * Parse a free-text "what to avoid" answer into exclusion requirements.
 * Answers are comma- or "and"-separated labels ("Sony, refurbished"),
 * each becoming one exclusion — the deterministic counterpart to the
 * model's exclusion extraction.
 */
export function exclusionsFromAnswer(value: string): Requirement[] {
  const labels = value
    .split(/[,;]|\band\b/i)
    .map((part) => part.trim().replace(/\s+/g, " "))
    .filter(
      (label) =>
        label.length >= 2 &&
        label.length <= 40 &&
        !EXCLUSION_STOPLIST.test(label) &&
        !/^(?:a|an|the|it|that|this|none|nothing|no)$/i.test(label),
    );
  return dedupeByKey(
    labels.slice(0, 5).map((label) => ({
      key: slugify(label),
      label,
      kind: "exclude" as const,
      importance: 1,
      evidence: value.trim().slice(0, 120),
    })),
  );
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
  // Rule-based incorporation for answers to the fallback questions below.
  // With a model, clarifications ride along in the prompt instead.
  const answerOf = (id: string): string | undefined =>
    options.answers
      ?.find((a) => a.questionId === id)
      ?.value.trim() || undefined;
  const ruleUseContext = llm ? undefined : answerOf("use")?.slice(0, 300);
  const ruleExcludes = llm ? [] : exclusionsFromAnswer(answerOf("avoid") ?? "");
  const requirements = RequirementSetSchema.parse({
    category: intent.category,
    useContext: llm?.useContext ?? ruleUseContext,
    must: (llm?.must ?? []).map((r) => ({ ...r, kind: "must" as const, importance: 1 })),
    want: (llm?.want ?? []).map((r) => ({ ...r, kind: "want" as const })),
    exclude: dedupeByKey([
      ...rules,
      ...ruleExcludes,
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
    : decideClarification(intent, requirements, llm !== null);
  return { requirements, questions };
}

export function decideClarification(
  intent: Intent,
  requirements: RequirementSet,
  llmAvailable = true,
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
  if (!llmAvailable) {
    // The model builds follow-ups from `unanswered`; without it, ask the
    // two highest-value questions directly so rule-based mode still
    // clarifies instead of silently skipping.
    if (questions.length < 2) {
      questions.push({
        id: "use",
        prompt: "What will you mainly use it for?",
        freeText: true,
      });
    }
    if (questions.length < 2) {
      questions.push({
        id: "avoid",
        prompt: "Any brands or features to avoid? (comma-separated, or 'none')",
        freeText: true,
      });
    }
  }
  return questions.slice(0, 2);
}
