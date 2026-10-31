import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import {
  sessionUserFromRequest,
  unauthenticatedResponse,
} from "../../../lib/auth/require-session";
import { respondToChat } from "../../../lib/chat/service";
import { getLlmProvider } from "../../../lib/llm/provider";
import { FileMemoryStore } from "../../../lib/memory/file-store";

const BodySchema = z.object({
  threadId: z.string().min(1).max(64).nullable().optional(),
  message: z.string().trim().min(1).max(2000),
  productId: z.string().min(1).max(64).nullable().optional(),
});

export async function POST(request: NextRequest): Promise<NextResponse> {
  const user = sessionUserFromRequest(request);
  if (!user) {
    return unauthenticatedResponse();
  }
  const body: unknown = await request.json().catch(() => null);
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Body must be { message, threadId?, productId? }.", code: "invalid-chat" },
      { status: 400 },
    );
  }
  const store = new FileMemoryStore();
  if (parsed.data.threadId) {
    const existing = await store.getChatThread(user.sub, parsed.data.threadId);
    if (!existing) {
      return NextResponse.json(
        { error: "Unknown thread.", code: "unknown-thread" },
        { status: 404 },
      );
    }
  }
  const result = await respondToChat({
    store,
    userSub: user.sub,
    threadId: parsed.data.threadId,
    message: parsed.data.message,
    productId: parsed.data.productId,
    provider: getLlmProvider(),
  });
  return NextResponse.json({
    thread: result.thread,
    reply: result.reply,
  });
}
