import { NextResponse } from "next/server";
import { z } from "zod";
import { CATEGORY_LABELS } from "../../../lib/requirements/types";
import type { Category } from "../../../config/sources";
import { resolveIntent } from "../../../lib/intent/service";
import { IntentSchema } from "../../../lib/intent/types";
import { extractRequirements } from "../../../lib/requirements/extract";
import { ClarificationAnswerSchema } from "../../../lib/requirements/types";

const BodySchema = z.object({
  query: z.string().trim().min(2).max(500),
  intent: IntentSchema.optional(),
  answers: z.array(ClarificationAnswerSchema).optional(),
});

function categoryIdFromAnswer(value: string): Category | null {
  const normalized = value.trim().toLowerCase();
  for (const [id, label] of Object.entries(CATEGORY_LABELS) as Array<
    [Category, string]
  >) {
    if (label.toLowerCase() === normalized || id === normalized) {
      return id;
    }
  }
  return null;
}

export async function POST(request: Request): Promise<NextResponse> {
  const body: unknown = await request.json().catch(() => null);
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "query must be a string of 2–500 characters" },
      { status: 400 },
    );
  }
  const input = parsed.data;
  const resolved = input.intent
    ? { intent: input.intent, llmUsed: false, llmAvailable: true }
    : await resolveIntent(input.query);
  const { requirements, questions } = await extractRequirements(
    resolved.intent.query,
    resolved.intent,
    { answers: input.answers },
  );
  const categoryAnswer = input.answers?.find(
    (a) => a.questionId === "category",
  )?.value;
  const suggestedCategory = categoryAnswer
    ? categoryIdFromAnswer(categoryAnswer)
    : null;
  return NextResponse.json({
    requirements:
      suggestedCategory != null
        ? { ...requirements, category: suggestedCategory }
        : requirements,
    questions,
    suggestedCategory,
  });
}
