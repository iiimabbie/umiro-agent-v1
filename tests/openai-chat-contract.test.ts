import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { OpenAIChatAdapter, buildOpenAIChatBody, normalizeContent, normalizeFinishReason, normalizeToolCalls } from "../src/llm/adapters/openai-chat.js";
import type { LlmProfile, LlmRequest } from "../src/llm/types.js";

const profile: LlmProfile = {
  name: "test", protocol: "openai_chat_completions", baseUrl: "https://example.invalid/v1",
  apiKey: "test-only", auth: "bearer", model: "test-model", reasoningEffort: "default",
  tokenLimitField: "max_completion_tokens",
  capabilities: { vision: true, function_tools: true, responses: false, hosted_web_search: false, hosted_image_generation: false, hosted_code_execution: false },
};

test("chat request preserves image parts and tool-result correlation", () => {
  const request: LlmRequest = { messages: [
    { role: "system", content: "System" },
    { role: "user", content: [{ type: "text", text: "Inspect" }, { type: "image", url: "https://example.invalid/image.png", detail: "low" }] },
    { role: "assistant", content: null, toolCalls: [{ id: "call_1", name: "lookup", input: { query: "sample" } }] },
    { role: "tool", toolCallId: "call_1", content: "result" },
  ], tools: [{ name: "lookup", description: "Lookup", parameters: { type: "object" } }] };
  const body = buildOpenAIChatBody(request, profile);
  assert.deepEqual(body.messages, [
    { role: "system", content: "System" },
    { role: "user", content: [{ type: "text", text: "Inspect" }, { type: "image_url", image_url: { url: "https://example.invalid/image.png", detail: "low" } }] },
    { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "lookup", arguments: '{"query":"sample"}' } }] },
    { role: "tool", tool_call_id: "call_1", content: "result" },
  ]);
  assert.deepEqual(body.tools, [{ type: "function", function: request.tools![0] }]);
  assert.equal(body.max_completion_tokens, 8192);
  assert.equal("reasoning_effort" in body, false);
  assert.equal("apiKey" in body, false);
});

test("chat requests reject direct file parts instead of silently dropping them", () => {
  const request: LlmRequest = { messages: [{
    role: "user",
    content: [{ type: "text", text: "Read this" }, { type: "file", filename: "sample.pdf", data: "data:application/pdf;base64,JVBERi0=" }],
  }] };
  assert.throws(() => buildOpenAIChatBody(request, profile), /does not support direct file input/);
});

test("chat request respects profile token field and reasoning without mutating input", () => {
  const request: LlmRequest = { messages: [{ role: "user", content: "Hello" }], maxTokens: 128 };
  const before = structuredClone(request);
  const body = buildOpenAIChatBody(request, { ...profile, tokenLimitField: "max_tokens", reasoningEffort: "high" });
  assert.equal(body.max_tokens, 128);
  assert.equal("max_completion_tokens" in body, false);
  assert.equal(body.reasoning_effort, "high");
  assert.equal("tools" in body, false);
  assert.deepEqual(request, before);
});

test("chat normalizers tolerate absent content and unknown finish reasons", () => {
  assert.equal(normalizeContent(null), "");
  assert.equal(normalizeContent("answer"), "answer");
  assert.equal(normalizeContent([{ text: "a" }, null, { other: "ignored" }, { text: "b" }]), "ab");
  for (const reason of ["stop", "tool_calls", "length", "content_filter"]) assert.equal(normalizeFinishReason(reason), reason);
  assert.equal(normalizeFinishReason("future_reason"), "unknown");
});

test("invalid JSON tool arguments remain errors rather than executable empty objects", () => {
  for (const args of ["{", "[]", "null", "42"]) {
    const calls = normalizeToolCalls([{ id: "call_1", function: { name: "lookup", arguments: args } }]);
    assert.equal(calls.length, 1);
    assert.ok(calls[0].argumentError);
    assert.equal(calls[0].id, "call_1");
  }
  assert.deepEqual(normalizeToolCalls(undefined), []);
  assert.deepEqual(normalizeToolCalls([{ id: "call_2", function: { name: "lookup", arguments: '{"q":"value"}' } }]), [{ id: "call_2", name: "lookup", input: { q: "value" } }]);
});

test("chat HTTP contract preserves endpoint, authentication, response and usage", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    calls++;
    assert.equal(url, "https://example.invalid/v1/chat/completions");
    assert.equal(init.method, "POST");
    assert.equal(new Headers(init.headers).get("authorization"), "Bearer test-only");
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    assert.equal(body.model, "test-model");
    assert.equal(String(init.body).includes("test-only"), false);
    return Response.json({ choices: [{ finish_reason: "tool_calls", message: {
      content: null, tool_calls: [{ id: "call_http", function: { name: "lookup", arguments: '{"q":"sample"}' } }],
    } }], usage: { prompt_tokens: 100, completion_tokens: 20, completion_tokens_details: { reasoning_tokens: 7 } } });
  });
  const result = await new OpenAIChatAdapter().generate({ messages: [{ role: "user", content: "Hello" }] }, { ...profile, baseUrl: profile.baseUrl + "///" });
  assert.equal(calls, 1);
  assert.equal(result.finishReason, "tool_calls");
  assert.deepEqual(result.usage, { inputTokens: 100, outputTokens: 20, reasoningTokens: 7 });
  assert.deepEqual(result.toolCalls, [{ id: "call_http", name: "lookup", input: { q: "sample" } }]);
  assert.deepEqual(result.assistantMessage, { role: "assistant", content: null, toolCalls: result.toolCalls });
});

test("chat response content arrays keep only textual parts", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({
    choices: [{
      message: { content: [{ type: "text", text: "First" }, { type: "refusal", refusal: "ignored" }, { text: " second" }] },
      finish_reason: null,
    }],
  }));
  const result = await new OpenAIChatAdapter().generate({ messages: [] }, profile);
  assert.equal(result.text, "First second");
  assert.equal(result.finishReason, "unknown");
  assert.deepEqual(result.assistantMessage, { role: "assistant", content: "First second" });
});

test("chat HTTP supports unauthenticated compatible endpoints", async (t) => {
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    assert.equal(new Headers(init.headers).has("authorization"), false);
    return Response.json({ choices: [{ message: { content: "Local response" }, finish_reason: "stop" }] });
  });
  const result = await new OpenAIChatAdapter().generate(
    { messages: [{ role: "user", content: "Hello" }] },
    { ...profile, auth: "none", apiKey: "" },
  );
  assert.equal(result.text, "Local response");
});

test("chat HTTP rejects missing bearer credentials before sending", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return Response.json({});
  });
  await assert.rejects(
    new OpenAIChatAdapter().generate({ messages: [] }, { ...profile, apiKey: "" }),
    /requires an API key/,
  );
  assert.equal(calls, 0);
});


test("chat HTTP propagates caller cancellation without retrying", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    calls++;
    return new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    });
  });
  const controller = new AbortController();
  const pending = new OpenAIChatAdapter().generate({ messages: [], signal: controller.signal }, profile);
  controller.abort(new Error("cancelled by test"));
  await assert.rejects(pending, /cancelled by test/);
  assert.equal(calls, 1);
});

test("chat HTTP errors do not retry permanent failures", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return new Response("Unauthorized", { status: 401 });
  });
  await assert.rejects(new OpenAIChatAdapter().generate({ messages: [] }, profile), /401 after 1 attempt/);
  assert.equal(calls, 1);
});

test("chat HTTP retries temporary failures on the same model and endpoint", async (t) => {
  const requests: unknown[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    requests.push({ url, body: init.body });
    if (requests.length < 3) return new Response("Busy", { status: 429, headers: { "retry-after": "0" } });
    return Response.json({ choices: [{ message: { content: "Recovered" }, finish_reason: "stop" }] });
  });
  const result = await new OpenAIChatAdapter().generate({ messages: [] }, profile);
  assert.equal(result.text, "Recovered");
  assert.equal(requests.length, 3);
  assert.deepEqual(requests[0], requests[1]);
  assert.deepEqual(requests[1], requests[2]);
  assert.deepEqual(result.usage, { inputTokens: 0, outputTokens: 0, reasoningTokens: 0 });
});

test("chat HTTP preserves the transport cause after bounded retries", async (t) => {
  let calls = 0;
  const transportError = Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    throw transportError;
  });
  await assert.rejects(
    new OpenAIChatAdapter().generate({ messages: [] }, profile),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /request failed after 3 attempts/);
      assert.equal(error.cause, transportError);
      return true;
    },
  );
  assert.equal(calls, 3);
});

test("chat HTTP stops after three temporary failures", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return new Response("Unavailable", { status: 503, headers: { "retry-after": "0" } });
  });
  await assert.rejects(new OpenAIChatAdapter().generate({ messages: [] }, profile), /503 after 3 attempt/);
  assert.equal(calls, 3);
});

test("chat rejects malformed JSON and missing assistant messages", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return calls === 1 ? new Response("not-json", { status: 200 }) : Response.json({ choices: [] });
  });
  await assert.rejects(new OpenAIChatAdapter().generate({ messages: [] }, profile), SyntaxError);
  await assert.rejects(new OpenAIChatAdapter().generate({ messages: [] }, profile), /no assistant message/);
  assert.equal(calls, 2);
});

test("chat adapter completes a request through a real local OpenAI-compatible HTTP server", async (t) => {
  let receivedAuthorization = "";
  let receivedBody: Record<string, unknown> = {};
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", chunk => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      receivedAuthorization = request.headers.authorization ?? "";
      receivedBody = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        choices: [{ message: { content: "Integration response" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 3, completion_tokens: 2 },
      }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  }));

  const address = server.address();
  assert.ok(address && typeof address === "object");
  const result = await new OpenAIChatAdapter().generate(
    { messages: [{ role: "user", content: "Integration request" }] },
    { ...profile, baseUrl: `http://127.0.0.1:${address.port}/v1` },
  );

  assert.equal(receivedAuthorization, "Bearer test-only");
  assert.equal(receivedBody.model, "test-model");
  assert.equal(result.text, "Integration response");
  assert.deepEqual(result.usage, { inputTokens: 3, outputTokens: 2, reasoningTokens: 0 });
});
