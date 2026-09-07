import { OpenAIChatAdapter } from "./adapters/openai-chat.js";
import { OpenAIResponsesAdapter } from "./adapters/openai-responses.js";
import type { LlmAdapter, LlmProfile, LlmRequest, LlmResponse } from "./types.js";

const adapters: Partial<Record<LlmProfile["protocol"], LlmAdapter>> = {
  openai_chat_completions: new OpenAIChatAdapter(),
  openai_responses: new OpenAIResponsesAdapter(),
};

export async function generateLlmResponse(request: LlmRequest, profile: LlmProfile): Promise<LlmResponse> {
  const adapter = adapters[profile.protocol];
  if (!adapter) throw new Error(`Unsupported LLM protocol: ${profile.protocol}`);
  return adapter.generate(request, profile);
}
