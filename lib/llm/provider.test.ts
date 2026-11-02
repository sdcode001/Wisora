import { afterEach, expect, test, vi } from "vitest";
import {
  DEFAULT_META_BASE_URL,
  HttpLlmProvider,
  getLlmProvider,
  getReasonProvider,
  llmTransportFromEnv,
} from "./provider";

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.META_API_KEY;
  delete process.env.WISORA_LLM_TRANSPORT;
  delete process.env.WISORA_MUSE_BASE_URL;
  delete process.env.WISORA_MUSE_MODEL;
});

function chatResponse(content: string, status = 200): Response {
  return Response.json(
    {
      choices: [{ message: { content } }],
    },
    { status },
  );
}

function stubFetch(response: Response): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockResolvedValue(response);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function requestOf(fetchMock: ReturnType<typeof vi.fn>): {
  url: string;
  init: RequestInit;
} {
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  return { url, init };
}

test("posts chat completions with bearer auth and effort", async () => {
  const fetchMock = stubFetch(
    chatResponse(
      '{"category":"electronics","budgetInrMin":null,"budgetInrMax":90000,"searchTerms":"laptop"}',
    ),
  );
  const provider = new HttpLlmProvider({
    model: "muse-spark-1.3",
    effort: "low",
    apiKey: "secret-key",
  });
  const intent = await provider.extractIntent("laptop under 90000");
  expect(intent).toMatchObject({
    category: "electronics",
    budgetInrMax: 90000,
  });
  const { url, init } = requestOf(fetchMock);
  expect(url).toBe(`${DEFAULT_META_BASE_URL}/chat/completions`);
  expect(init.method).toBe("POST");
  expect(init.headers).toMatchObject({
    "Content-Type": "application/json",
    Authorization: "Bearer secret-key",
  });
  const body = JSON.parse(init.body as string) as Record<string, unknown>;
  expect(body).toMatchObject({
    model: "muse-spark-1.3",
    stream: false,
    reasoning_effort: "low",
    response_format: { type: "json_object" },
  });
  expect(body.messages).toHaveLength(1);
});

test("extracts JSON from fenced content", async () => {
  stubFetch(
    chatResponse('```json\n{"answer":"Yes.","usedContext":true}\n```'),
  );
  const provider = new HttpLlmProvider({
    model: "muse-spark-1.3",
    effort: "low",
    apiKey: "secret-key",
  });
  await expect(
    provider.answerGrounded({ question: "q", context: "c", history: [] }),
  ).resolves.toMatchObject({ answer: "Yes.", usedContext: true });
});

test("retries once, then surfaces the failure", async () => {
  const fetchMock = vi
    .fn()
    .mockRejectedValueOnce(new Error("socket hang up"))
    .mockResolvedValueOnce(
      chatResponse(
        '{"category":"electronics","budgetInrMin":null,"budgetInrMax":null,"searchTerms":"laptop"}',
      ),
    );
  vi.stubGlobal("fetch", fetchMock);
  const provider = new HttpLlmProvider({
    model: "muse-spark-1.3",
    effort: "low",
    apiKey: "secret-key",
  });
  await expect(provider.extractIntent("laptop")).resolves.toMatchObject({
    category: "electronics",
  });
  expect(fetchMock).toHaveBeenCalledTimes(2);

  fetchMock.mockReset();
  fetchMock.mockRejectedValue(new Error("down"));
  await expect(provider.extractIntent("laptop")).rejects.toThrow("down");
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

test("non-ok statuses and empty choices throw", async () => {
  // Fresh body per attempt: the provider retries once before surfacing.
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation(() => Promise.resolve(
      new Response("bad key", {
        status: 401,
        headers: { "Content-Type": "text/plain" },
      }),
    )),
  );
  const provider = new HttpLlmProvider({
    model: "muse-spark-1.3",
    effort: "low",
    apiKey: "secret-key",
  });
  await expect(provider.extractIntent("laptop")).rejects.toThrow("401");
});

test("missing message content throws", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation(() => Promise.resolve(
      Response.json({ choices: [{ message: { content: null } }] }),
    )),
  );
  const provider = new HttpLlmProvider({
    model: "muse-spark-1.3",
    effort: "low",
    apiKey: "secret-key",
  });
  await expect(provider.extractIntent("laptop")).rejects.toThrow(
    "no message content",
  );
});

test("honors a custom base url and strips trailing slashes", async () => {
  const fetchMock = stubFetch(
    chatResponse(
      '{"category":"general","budgetInrMin":null,"budgetInrMax":null,"searchTerms":"x"}',
    ),
  );
  const provider = new HttpLlmProvider({
    model: "muse-spark-1.3",
    effort: "low",
    apiKey: "secret-key",
    baseUrl: "https://proxy.example.com/meta///",
  });
  await provider.extractIntent("x");
  expect(requestOf(fetchMock).url).toBe(
    "https://proxy.example.com/meta/chat/completions",
  );
});

test("available reflects the api key", () => {
  expect(
    new HttpLlmProvider({ model: "m", effort: "low", apiKey: "" }).available,
  ).toBe(false);
  expect(
    new HttpLlmProvider({ model: "m", effort: "low", apiKey: "k" }).available,
  ).toBe(true);
});

test("transport selection defaults to cli and honors env", () => {
  expect(llmTransportFromEnv()).toBe("cli");
  process.env.WISORA_LLM_TRANSPORT = "http";
  expect(llmTransportFromEnv()).toBe("http");
  process.env.WISORA_LLM_TRANSPORT = "bogus";
  expect(llmTransportFromEnv()).toBe("cli");
});

test("factory builds the selected transport, or null without a key", () => {
  expect(getLlmProvider()).toBeNull();
  process.env.META_API_KEY = "secret-key";
  expect(getLlmProvider()?.name).toBe("muse-exec");
  expect(getReasonProvider()?.name).toBe("muse-exec");
  process.env.WISORA_LLM_TRANSPORT = "http";
  expect(getLlmProvider()?.name).toBe("meta-http");
  expect(getReasonProvider()?.name).toBe("meta-http");
});
