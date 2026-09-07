// --- Tool ---

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>) => Promise<string>;
}

// --- Durable conversation content ---

export interface AttachmentReference {
  id: string;
  url?: string;
  name?: string;
  contentType?: string;
  localPath?: string;
  size?: number;
  contentHash?: string;
  relation?: "upload" | "embed" | "reply_reference" | "generated" | "tool_output";
  /**
   * Discord provenance, present only for attachments that came from a Discord message.
   * These let the background worker re-fetch a fresh signed CDN URL when the stored one
   * expires (Discord CDN URLs are time-limited): re-fetch the ORIGINAL message by
   * `discordChannelId`/`discordMessageId`, match the attachment by `discordAttachmentId`,
   * and read its current `url`. They are never used to fetch arbitrary caller-chosen
   * messages — only the exact IDs recorded when the attachment was first ingested.
   */
  discordChannelId?: string;
  discordMessageId?: string;
  discordAttachmentId?: string;
}


/** New sessions write only text/image blocks. Remaining variants are read-only compatibility
 * for sessions containing provider-specific blocks written by earlier releases. */
export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; signature?: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string }
  | { type: "server_tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "web_search_tool_result"; tool_use_id?: string; content: Array<{ type: string; url?: string; title?: string; encrypted_content?: string }> }
  | { type: "web_fetch_tool_result"; tool_use_id?: string; content: unknown }
  | { type: "code_execution_tool_result"; tool_use_id?: string; content: unknown }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } };

export type Message = {
  role: "user" | "assistant";
  content: string | ContentBlock[];
  time?: string;       // MM/DD HH:mm
  msgId?: string;      // Discord message ID
  replyTo?: string;    // replied message ID
  /** Stable local identity for idempotent search indexing. */
  searchId?: string;
  /** True only for the synthetic summary inserted by Session.compact(). */
  isCompactSummary?: boolean;
  /** True only for the one-time onboarding context injected on first session in a fresh workspace. */
  isOnboarding?: boolean;
  /** Durable references to uploaded, embedded, generated, or tool-produced files. */
  attachments?: AttachmentReference[];
};

// --- Token Usage ---

export type DiscordQueueMode = "followup" | "steer";

export interface SessionModelSettings {
  profile: string;
  model: string;
  reasoningEffort: import("./config.js").ReasoningEffort;
  /** Monotonic session-local revision used to detect concurrent setting changes. */
  revision: number;
  /** Optional per-session Discord message handling override. */
  queueMode?: DiscordQueueMode;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  /** Reasoning tokens are a subset/detail of outputTokens and must not be added again to totals. */
  reasoningTokens: number;
}

/** Immutable record of a locally executed tool call. Full input/output remain in the
 * session file for audit and later inspection; only a concise projection is sent
 * back to the model on subsequent turns. */
export interface ToolHistoryEvent {
  id: string;
  time: string;
  tool: string;
  input: Record<string, unknown>;
  result: string;
  isError: boolean;
}

// --- Agent ---

export interface ToolActivity {
  tool: string;
  input: Record<string, unknown>;
}

export interface AgentResponse {
  text: string;
  toolsUsed: ToolActivity[];
  durationMs: number;
  usage: TokenUsage;
  /** 工具在這次請求中排隊的檔案附件（由 ask() 從 request context 收集） */
  attachments: string[];
}

export type ProgressEvent =
  | { type: "tool_start"; toolCallId: string; toolName: string }
  | { type: "tool_end"; toolCallId: string; isError: boolean }
  /**
   * Agent 在 tool call 之間產生的文字。只進 session，不在 ask() 的回傳值裡，
   * 需要靠這個事件才看得到。純過場，最終回覆會覆蓋掉。
   */
  | { type: "text"; text: string };

export type TriggerSource = "cli" | "discord-owner" | "discord-other" | "cron" | "reminder" | "journal" | "plugin" | "unknown";

export interface AgentOptions {
  systemPrompt?: string;
  maxTurns?: number;
  model?: string;
  /** Fully resolved internal profile override for background work such as journal. */
  llmProfile?: import("./llm/types.js").LlmProfile;
  session?: import("./session.js").Session;
  onToolUse?: (tool: string, input: Record<string, unknown>) => void;
  onProgress?: (event: ProgressEvent) => void;
  images?: string[];
  /** Files that the active protocol can pass directly to the model for this turn. */
  files?: Array<{ url: string; name: string; contentType: string; size?: number }>;
  trigger?: TriggerSource;
  /** 發話的 Discord 使用者 ID，供 tools.bash_allowed_users 判定用 */
  userId?: string;
  /** Explicit runtime-verified PEOPLE.md visibility; omitted means fail-closed (none). */
  peopleVisibility?: import("./people-context.js").PeopleVisibilityPolicy;
  /** Cooperative run control checked at safe model/tool turn boundaries. */
  runControl?: {
    signal?: AbortSignal;
    isStopRequested: () => boolean;
    drainPendingInputs: () => Array<{ message: Message; images?: string[]; files?: Array<{ url: string; name: string; contentType: string; size?: number }> }>;
    drainPendingInputsOrSeal: () => Array<{ message: Message; images?: string[]; files?: Array<{ url: string; name: string; contentType: string; size?: number }> }>;
  };
}
