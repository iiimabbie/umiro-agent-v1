import { postLlmJson } from "../http.js";
import type { LlmAdapter, LlmContent, LlmFinishReason, LlmMessage, LlmProfile, LlmResponse, LlmToolCall } from "../types.js";

interface OpenAIToolCall { id: string; type: "function"; function: { name: string; arguments: string } }
type OpenAIContent = string | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string; detail?: "auto" | "low" | "high" } }>;
type OpenAIMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: OpenAIContent }
  | { role: "assistant"; content: string | null; tool_calls?: OpenAIToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };
interface ChatCompletionResponse {
  choices?: Array<{ finish_reason?: string | null; message?: { content?: unknown; tool_calls?: unknown } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; completion_tokens_details?: { reasoning_tokens?: number } };
}

export function normalizeContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map(part => part && typeof part === "object" && typeof (part as Record<string, unknown>).text === "string" ? String((part as Record<string, unknown>).text) : "").join("");
}
export function normalizeFinishReason(value: unknown): LlmFinishReason {
  return value === "stop" || value === "tool_calls" || value === "length" || value === "content_filter" ? value : "unknown";
}
export function normalizeToolCalls(value: unknown): LlmToolCall[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw, index) => {
    if (!raw || typeof raw !== "object") return [];
    const item = raw as Record<string, unknown>;
    const fn = item.function;
    if (!fn || typeof fn !== "object") return [];
    const f = fn as Record<string, unknown>;
    const id = typeof item.id === "string" && item.id ? item.id : `call_missing_${index}`;
    const name = typeof f.name === "string" ? f.name : "";
    const argumentText = typeof f.arguments === "string" ? f.arguments : "{}";
    if (!name) return [{ id, name: "", input: {}, argumentError: "function name is missing" }];
    if (!argumentText.trim()) return [{ id, name, input: {} }];
    try {
      const parsed = JSON.parse(argumentText) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [{ id, name, input: {}, argumentError: "function arguments must decode to a JSON object" }];
      return [{ id, name, input: parsed as Record<string, unknown> }];
    } catch (err) {
      return [{ id, name, input: {}, argumentError: `malformed function arguments: ${(err as Error).message}` }];
    }
  });
}
function contentToWire(content: LlmContent): OpenAIContent {
  if (typeof content === "string") return content;
  return content.map(part => {
    if (part.type === "text") return part;
    if (part.type === "file") throw new Error("OpenAI Chat Completions does not support direct file input");
    return { type: "image_url", image_url: { url: part.url, ...(part.detail ? { detail: part.detail } : {}) } };
  });
}
function messageToWire(message: LlmMessage): OpenAIMessage {
  if (message.role === "system") return message;
  if (message.role === "user") return { role: "user", content: contentToWire(message.content) };
  if (message.role === "tool") return { role: "tool", tool_call_id: message.toolCallId, content: message.content };
  return {
    role: "assistant",
    content: message.content,
    ...(message.toolCalls?.length ? { tool_calls: message.toolCalls.map(call => ({ id: call.id, type: "function" as const, function: { name: call.name, arguments: JSON.stringify(call.input) } })) } : {}),
  };
}

export function buildOpenAIChatBody(request: import("../types.js").LlmRequest, profile: LlmProfile): Record<string, unknown> {
  const tokenLimit = request.maxTokens ?? 8192;
  return {
      model: profile.model,
      messages: request.messages.map(messageToWire),
      [profile.tokenLimitField]: tokenLimit,
      ...(profile.reasoningEffort !== "default" ? { reasoning_effort: profile.reasoningEffort } : {}),
    ...(request.tools?.length ? { tools: request.tools.map(tool => ({ type: "function", function: tool })) } : {}),
  };
}

export class OpenAIChatAdapter implements LlmAdapter {
  async generate(request: import("../types.js").LlmRequest, profile: LlmProfile): Promise<LlmResponse> {
    const endpoint = `${profile.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    const body = buildOpenAIChatBody(request, profile);
    const raw = await postLlmJson<ChatCompletionResponse>({ endpoint, profile, body, signal: request.signal, label: "OpenAI Chat Completions" });
    const choice = raw.choices?.[0];
    if (!choice?.message) throw new Error("OpenAI Chat Completions returned no assistant message");
    const text = normalizeContent(choice.message.content);
    const toolCalls = normalizeToolCalls(choice.message.tool_calls);
    return {
      text,
      toolCalls,
      finishReason: normalizeFinishReason(choice.finish_reason),
      usage: { inputTokens: raw.usage?.prompt_tokens ?? 0, outputTokens: raw.usage?.completion_tokens ?? 0, reasoningTokens: raw.usage?.completion_tokens_details?.reasoning_tokens ?? 0 },
      assistantMessage: { role: "assistant", content: text || null, ...(toolCalls.length ? { toolCalls } : {}) },
    };
  }
}
