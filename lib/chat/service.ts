import type { LlmProvider } from "../llm/provider";
import type { ChatThread } from "../memory/records";
import type { MemoryStore } from "../memory/store";
import {
  answerQuestion,
  enrichContextWithProduct,
  type AnswerSource,
} from "./answer";
import { buildChatContext } from "./context";

export type ReplySource = "rules" | "llm" | "offline";

export interface ChatReply {
  text: string;
  sources: AnswerSource[];
  source: ReplySource;
}

export interface RespondToChatInput {
  store: MemoryStore;
  userSub: string;
  threadId?: string | null;
  message: string;
  /** UI hint from an opportunity card or watch. */
  productId?: string | null;
  provider?: LlmProvider | null;
  nowMs?: number;
}

export interface RespondToChatResult {
  thread: ChatThread;
  reply: ChatReply;
}

const OFFLINE_FALLBACK =
  "I couldn't match that to your tracked products, and the AI assistant " +
  "is offline right now. Try asking about the price of something you track " +
  "or watch — for example “is the Lenovo still a good deal?”";

function threadTitle(message: string): string {
  const cleaned = message.trim().replace(/\s+/g, " ");
  return cleaned.length > 40 ? `${cleaned.slice(0, 40)}…` : cleaned;
}

/**
 * One chat turn: persist the user message, answer from stored data when a
 * rule matches (no model cost), otherwise ask the LLM over retrieved
 * context, otherwise fall back honestly. LLM failures never fail the
 * request — they degrade to the offline message.
 */
export async function respondToChat(
  input: RespondToChatInput,
): Promise<RespondToChatResult> {
  const {
    store,
    userSub,
    message,
    provider = null,
    nowMs = Date.now(),
  } = input;
  const productId = input.productId ?? undefined;
  const text = message.trim();
  if (!text) {
    throw new Error("Message must not be empty.");
  }

  let thread =
    input.threadId != null
      ? await store.getChatThread(userSub, input.threadId)
      : null;
  if (!thread) {
    thread = await store.createChatThread(userSub, {
      title: threadTitle(text),
      firstMessage: { role: "user", text: text.slice(0, 2000) },
    });
  } else {
    const updated = await store.appendChatMessages(userSub, thread.id, [
      { role: "user", text: text.slice(0, 2000) },
    ]);
    thread = updated ?? thread;
  }

  let context = await buildChatContext({ store, userSub, nowMs });
  if (productId) {
    context = await enrichContextWithProduct(store, userSub, context, productId);
  }
  const ruled = answerQuestion(text, context, { productId, nowMs });
  let reply: ChatReply;
  if (ruled) {
    reply = { ...ruled, source: "rules" as const };
  } else if (provider && provider.available) {
    try {
      const history = thread.messages.slice(-6).map((entry) => ({
        role: entry.role,
        text: entry.text,
      }));
      const grounded = await provider.answerGrounded({
        question: text,
        context: context.text,
        history,
      });
      reply = { text: grounded.answer, sources: [], source: "llm" };
    } catch {
      reply = { text: OFFLINE_FALLBACK, sources: [], source: "offline" };
    }
  } else {
    reply = { text: OFFLINE_FALLBACK, sources: [], source: "offline" };
  }

  const updated =
    (await store.appendChatMessages(userSub, thread.id, [
      {
        role: "assistant",
        text: reply.text.slice(0, 4000),
        ...(reply.sources.length > 0 ? { sources: reply.sources } : {}),
      },
    ])) ?? thread;
  return { thread: updated, reply };
}
