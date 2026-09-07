import { postLlmJson } from "../http.js";
import type {
  LlmAdapter,
  LlmContent,
  LlmFinishReason,
  LlmMessage,
  LlmProfile,
  LlmRequest,
  LlmResponse,
  LlmToolCall,
} from "../types.js";

interface Annotation { type?: string; url?: string; title?: string }
interface ContentItem { type?: string; text?: string; annotations?: Annotation[] }
interface OutputItem {
  type?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  content?: ContentItem[];
}
interface ApiResponse {
  id?: string;
  error?: unknown;
  status?: string;
  incomplete_details?: { reason?: string };
  output?: OutputItem[];
  output_text?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    output_tokens_details?: { reasoning_tokens?: number };
  };
}

export interface ResponsesWebSearchResult {
  text: string;
  sources: Array<{ title?: string; url: string }>;
  responseId?: string;
}

function inputContent(content: LlmContent): Array<Record<string, unknown>> {
  if (typeof content === "string") return [{ type: "input_text", text: content }];
  return content.map(part => part.type === "text"
    ? { type: "input_text", text: part.text }
    : { type: "input_image", image_url: part.url, ...(part.detail ? { detail: part.detail } : {}) });
}

function messagesToInput(messages: LlmMessage[]): { instructions?: string; input: Array<Record<string, unknown>> } {
  const instructions = messages
    .filter((message): message is Extract<LlmMessage, { role: "system" }> => message.role === "system")
    .map(message => message.content)
    .join("\n\n");
  const input: Array<Record<string, unknown>> = [];

  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "user") {
      input.push({ role: "user", content: inputContent(message.content) });
      continue;
    }
    if (message.role === "tool") {
      input.push({ type: "function_call_output", call_id: message.toolCallId, output: message.content });
      continue;
    }
    if (message.content) {
      input.push({ role: "assistant", content: [{ type: "output_text", text: message.content }] });
    }
    for (const call of message.toolCalls ?? []) {
      input.push({ type: "function_call", call_id: call.id, name: call.name, arguments: JSON.stringify(call.input) });
    }
  }

  return { ...(instructions ? { instructions } : {}), input };
}

export function buildOpenAIResponsesBody(request: LlmRequest, profile: LlmProfile): Record<string, unknown> {
  const mapped = messagesToInput(request.messages);
  return {
    model: profile.model,
    ...mapped,
    max_output_tokens: request.maxTokens ?? 8192,
    ...(profile.reasoningEffort !== "default" ? { reasoning: { effort: profile.reasoningEffort } } : {}),
    ...(request.tools?.length ? {
      tools: request.tools.map(tool => ({
        type: "function",
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      })),
    } : {}),
  };
}

export function responsesOutputText(response: ApiResponse): string {
  if (typeof response.output_text === "string" && response.output_text.trim()) return response.output_text.trim();
  return (response.output ?? [])
    .flatMap(item => item.type === "message" ? item.content ?? [] : [])
    .filter(item => item.type === "output_text" && typeof item.text === "string")
    .map(item => item.text!.trim())
    .filter(Boolean)
    .join("\n");
}

export function normalizeResponsesToolCalls(output: OutputItem[] | undefined): LlmToolCall[] {
  if (!Array.isArray(output)) return [];
  return output.flatMap((item, index) => {
    if (item.type !== "function_call") return [];
    const id = typeof item.call_id === "string" && item.call_id ? item.call_id : `call_missing_${index}`;
    const name = typeof item.name === "string" ? item.name : "";
    const argumentText = typeof item.arguments === "string" ? item.arguments : "{}";
    if (!name) return [{ id, name: "", input: {}, argumentError: "function name is missing" }];
    if (!argumentText.trim()) return [{ id, name, input: {} }];
    try {
      const parsed = JSON.parse(argumentText) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return [{ id, name, input: {}, argumentError: "function arguments must decode to a JSON object" }];
      }
      return [{ id, name, input: parsed as Record<string, unknown> }];
    } catch (err) {
      return [{ id, name, input: {}, argumentError: `malformed function arguments: ${(err as Error).message}` }];
    }
  });
}

export function normalizeResponsesFinishReason(response: ApiResponse, toolCalls: LlmToolCall[]): LlmFinishReason {
  if (toolCalls.length > 0) return "tool_calls";
  if (response.status === "incomplete") {
    const reason = response.incomplete_details?.reason;
    if (reason === "max_output_tokens") return "length";
    if (reason === "content_filter") return "content_filter";
    return "unknown";
  }
  return response.status === undefined || response.status === "completed" ? "stop" : "unknown";
}

function sources(response: ApiResponse): ResponsesWebSearchResult["sources"] {
  const unique = new Map<string, { title?: string; url: string }>();
  for (const item of response.output ?? []) {
    for (const content of item.content ?? []) {
      for (const annotation of content.annotations ?? []) {
        if (annotation.type === "url_citation" && typeof annotation.url === "string" && annotation.url) {
          unique.set(annotation.url, { ...(annotation.title ? { title: annotation.title } : {}), url: annotation.url });
        }
      }
    }
  }
  return [...unique.values()];
}

export class OpenAIResponsesAdapter implements LlmAdapter {
  async generate(request: LlmRequest, profile: LlmProfile): Promise<LlmResponse> {
    const endpoint = `${profile.baseUrl.replace(/\/+$/, "")}/responses`;
    const body = buildOpenAIResponsesBody(request, profile);
    const raw = await postLlmJson<ApiResponse>({
      endpoint,
      profile,
      body,
      signal: request.signal,
      label: "OpenAI Responses",
    });
    if (raw.error) throw new Error(`OpenAI Responses failed: ${JSON.stringify(raw.error).slice(0, 2000)}`);
    const text = responsesOutputText(raw);
    const toolCalls = normalizeResponsesToolCalls(raw.output);
    if (!text && toolCalls.length === 0 && !(raw.output ?? []).some(item => item.type === "message")) {
      throw new Error("OpenAI Responses returned no assistant output");
    }
    return {
      text,
      toolCalls,
      finishReason: normalizeResponsesFinishReason(raw, toolCalls),
      usage: {
        inputTokens: raw.usage?.input_tokens ?? 0,
        outputTokens: raw.usage?.output_tokens ?? 0,
        reasoningTokens: raw.usage?.output_tokens_details?.reasoning_tokens ?? 0,
      },
      assistantMessage: { role: "assistant", content: text || null, ...(toolCalls.length ? { toolCalls } : {}) },
    };
  }
}

export async function callResponsesWebSearch(profile: LlmProfile, query: string, maxOutputTokens = 2048): Promise<ResponsesWebSearchResult> {
  const endpoint = `${profile.baseUrl.replace(/\/+$/, "")}/responses`;
  const response = await postLlmJson<ApiResponse>({
    endpoint,
    profile,
    label: "OpenAI Responses web search",
    body: { model: profile.model, input: query, tools: [{ type: "web_search" }], max_output_tokens: maxOutputTokens },
  });
  if (response.error) throw new Error(`OpenAI Responses web search failed: ${JSON.stringify(response.error).slice(0, 2000)}`);
  const text = responsesOutputText(response);
  if (!text) throw new Error("OpenAI Responses web search returned no output text");
  return { text, sources: sources(response), ...(response.id ? { responseId: response.id } : {}) };
}
