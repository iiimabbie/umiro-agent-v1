import assert from "node:assert/strict";
import { test } from "node:test";
import {
  OpenAIResponsesAdapter,
  buildOpenAIResponsesBody,
  callResponsesWebSearch,
  normalizeResponsesFinishReason,
  normalizeResponsesToolCalls,
  responsesOutputText,
} from "../src/llm/adapters/openai-responses.js";
import { generateLlmResponse } from "../src/llm/client.js";
import type { LlmProfile, LlmRequest } from "../src/llm/types.js";

const profile: LlmProfile = {
  name: "responses-test",
  protocol: "openai_responses",
  baseUrl: "https://example.invalid/v1",
  apiKey: "test-only",
  auth: "bearer",
  model: "test-model",
  reasoningEffort: "default",
  tokenLimitField: "max_completion_tokens",
  capabilities: {
    vision: true,
    function_tools: true,
    responses: true,
    hosted_web_search: true,
    hosted_image_generation: false,
    hosted_code_execution: false,
  },
};

test("responses request maps instructions, conversation items, images and tool results", () => {
  const request: LlmRequest = {
    messages: [
      { role: "system", content: "System one" },
      { role: "system", content: "System two" },
      { role: "user", content: [
        { type: "text", text: "Inspect" },
        { type: "image", url: "data:image/png;base64,AA==", detail: "low" },
        { type: "file", filename: "sample.pdf", data: "data:application/pdf;base64,JVBERi0=" },
      ] },
      { role: "assistant", content: "Working", toolCalls: [{ id: "call_1", name: "lookup", input: { query: "sample" } }] },
      { role: "tool", toolCallId: "call_1", content: "result" },
    ],
    tools: [{ name: "lookup", description: "Lookup", parameters: { type: "object" } }],
    maxTokens: 321,
  };
  const body = buildOpenAIResponsesBody(request, { ...profile, reasoningEffort: "high" });
  assert.equal(body.model, "test-model");
  assert.equal(body.instructions, "System one\n\nSystem two");
  assert.equal(body.max_output_tokens, 321);
  assert.deepEqual(body.reasoning, { effort: "high" });
  assert.deepEqual(body.input, [
    { role: "user", content: [
      { type: "input_text", text: "Inspect" },
      { type: "input_image", image_url: "data:image/png;base64,AA==", detail: "low" },
      { type: "input_file", filename: "sample.pdf", file_data: "data:application/pdf;base64,JVBERi0=" },
    ] },
    { role: "assistant", content: [{ type: "output_text", text: "Working" }] },
    { type: "function_call", call_id: "call_1", name: "lookup", arguments: '{"query":"sample"}' },
    { type: "function_call_output", call_id: "call_1", output: "result" },
  ]);
  assert.deepEqual(body.tools, [{ type: "function", name: "lookup", description: "Lookup", parameters: { type: "object" } }]);
});

test("responses normalizers parse text, calls and finish reasons", () => {
  const raw = {
    status: "completed",
    output: [
      { type: "message", content: [{ type: "output_text", text: " First " }, { type: "refusal", text: "ignored" }] },
      { type: "message", content: [{ type: "output_text", text: "second" }] },
      { type: "function_call", call_id: "call_1", name: "lookup", arguments: '{"q":"value"}' },
    ],
  };
  assert.equal(responsesOutputText(raw), "First\nsecond");
  const calls = normalizeResponsesToolCalls(raw.output);
  assert.deepEqual(calls, [{ id: "call_1", name: "lookup", input: { q: "value" } }]);
  assert.equal(normalizeResponsesFinishReason(raw, calls), "tool_calls");
  assert.equal(normalizeResponsesFinishReason({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }, []), "length");
  assert.equal(normalizeResponsesFinishReason({ status: "completed" }, []), "stop");
});

test("responses malformed tool arguments remain non-executable errors", () => {
  for (const args of ["{", "[]", "null", "42"]) {
    const calls = normalizeResponsesToolCalls([{ type: "function_call", call_id: "call_1", name: "lookup", arguments: args }]);
    assert.equal(calls.length, 1);
    assert.ok(calls[0].argumentError);
  }
  assert.deepEqual(normalizeResponsesToolCalls(undefined), []);
});

test("responses HTTP contract preserves endpoint, auth, output and usage", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    calls++;
    assert.equal(url, "https://example.invalid/v1/responses");
    assert.equal(init.method, "POST");
    assert.equal(new Headers(init.headers).get("authorization"), "Bearer test-only");
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    assert.equal(body.model, "test-model");
    assert.equal(String(init.body).includes("test-only"), false);
    return Response.json({
      status: "completed",
      output: [
        { type: "message", content: [{ type: "output_text", text: "Calling" }] },
        { type: "function_call", call_id: "call_http", name: "lookup", arguments: '{"q":"sample"}' },
      ],
      usage: { input_tokens: 100, output_tokens: 20, output_tokens_details: { reasoning_tokens: 7 } },
    });
  });
  const result = await generateLlmResponse({ messages: [{ role: "user", content: "Hello" }] }, profile);
  assert.equal(calls, 1);
  assert.equal(result.text, "Calling");
  assert.equal(result.finishReason, "tool_calls");
  assert.deepEqual(result.usage, { inputTokens: 100, outputTokens: 20, reasoningTokens: 7 });
  assert.deepEqual(result.toolCalls, [{ id: "call_http", name: "lookup", input: { q: "sample" } }]);
  assert.deepEqual(result.assistantMessage, { role: "assistant", content: "Calling", toolCalls: result.toolCalls });
});

test("responses adapter supports unauthenticated endpoints and cancellation", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    calls++;
    assert.equal(new Headers(init.headers).has("authorization"), false);
    if (!init.signal) return Response.json({ status: "completed", output_text: "Local response", output: [] });
    return new Promise<Response>((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true }));
  });
  const local = await new OpenAIResponsesAdapter().generate(
    { messages: [{ role: "user", content: "Hello" }] },
    { ...profile, auth: "none", apiKey: "" },
  );
  assert.equal(local.text, "Local response");

  const controller = new AbortController();
  const pending = new OpenAIResponsesAdapter().generate(
    { messages: [], signal: controller.signal },
    { ...profile, auth: "none", apiKey: "" },
  );
  controller.abort(new Error("cancelled by test"));
  await assert.rejects(pending, /cancelled by test/);
  assert.equal(calls, 2);
});

test("responses adapter rejects API errors and empty output", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return calls === 1
      ? Response.json({ error: { message: "unsupported route" } })
      : Response.json({ status: "completed", output: [] });
  });
  await assert.rejects(new OpenAIResponsesAdapter().generate({ messages: [] }, profile), /unsupported route/);
  await assert.rejects(new OpenAIResponsesAdapter().generate({ messages: [] }, profile), /no assistant output/);
});

test("hosted web search sends structured input items, never a bare string", async (t) => {
  let sentBody: Record<string, unknown> = {};
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.equal(url, "https://example.invalid/v1/responses");
    sentBody = JSON.parse(String(init.body)) as Record<string, unknown>;
    return Response.json({
      id: "resp_1",
      status: "completed",
      output: [{
        type: "message",
        content: [{
          type: "output_text",
          text: "Paris is the capital.",
          annotations: [{ type: "url_citation", url: "https://example.invalid/paris", title: "Paris" }],
        }],
      }],
    });
  });
  const result = await callResponsesWebSearch(profile, "capital of France");
  assert.deepEqual(sentBody.input, [
    { role: "user", content: [{ type: "input_text", text: "capital of France" }] },
  ]);
  assert.deepEqual(sentBody.tools, [{ type: "web_search" }]);
  assert.equal(result.text, "Paris is the capital.");
  assert.deepEqual(result.sources, [{ title: "Paris", url: "https://example.invalid/paris" }]);
  assert.equal(result.responseId, "resp_1");
});
