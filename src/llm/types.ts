import type { TokenUsage } from "../types.js";

export type LlmProtocol = "openai_chat_completions" | "openai_responses";
export type LlmAuthStrategy = "bearer" | "none";
export type LlmCapability = "vision" | "function_tools" | "responses" | "hosted_web_search" | "hosted_image_generation" | "hosted_code_execution";
export type TokenLimitField = "max_completion_tokens" | "max_tokens";

export interface LlmProfile {
  name: string;
  protocol: LlmProtocol;
  baseUrl: string;
  apiKey: string;
  auth: LlmAuthStrategy;
  model: string;
  reasoningEffort: import("../config.js").ReasoningEffort;
  tokenLimitField: TokenLimitField;
  capabilities: Record<LlmCapability, boolean>;
}

export type LlmTextPart = { type: "text"; text: string };
export type LlmImagePart = { type: "image"; url: string; detail?: "auto" | "low" | "high" };
export type LlmFilePart = { type: "file"; data: string; filename: string };
export type LlmContent = string | Array<LlmTextPart | LlmImagePart | LlmFilePart>;

export interface LlmFunctionTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface LlmToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  argumentError?: string;
}

export type LlmMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: LlmContent }
  | { role: "assistant"; content: string | null; toolCalls?: LlmToolCall[] }
  | { role: "tool"; toolCallId: string; content: string };

export type LlmFinishReason = "stop" | "tool_calls" | "length" | "content_filter" | "unknown";

export interface LlmRequest {
  messages: LlmMessage[];
  tools?: LlmFunctionTool[];
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface LlmResponse {
  text: string;
  toolCalls: LlmToolCall[];
  finishReason: LlmFinishReason;
  usage: TokenUsage;
  assistantMessage: Extract<LlmMessage, { role: "assistant" }>;
}

export interface LlmAdapter {
  generate(request: LlmRequest, profile: LlmProfile): Promise<LlmResponse>;
}
