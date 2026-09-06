import { createHash, randomUUID } from "node:crypto";
import type { ContentBlock, Message, ToolHistoryEvent } from "./types.js";
import {
  createSearchDocumentId,
  ingestSearchDocuments,
  type SearchDocumentInput,
} from "./search-index.js";
import { logger } from "./logger.js";
import { reconcileAttachmentReferences, registerInlineImageAttachments } from "./attachment-index.js";

const MAX_CHUNK_CHARS = 6_000;
const CHUNK_OVERLAP_CHARS = 400;

const IGNORED_SYSTEM_PREFIXES = [
  "[System] Session ending — flush memory now.",
  "[System] Previous conversation summary:\n",
  "[System] Tools actually executed in the preceding assistant turn",
  "[System] Session is being archived",
  "[System] The following messages were proactively pushed to this channel",
];

function stableHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stringifyContent(content: Message["content"]): string {
  if (typeof content === "string") return content;
  return content.flatMap(block => {
    if (block.type === "text") return [block.text];
    return [];
  }).join("\n");
}

function stripTransportMetadata(text: string): string {
  return text
    .replace(/^\[msg:\S+\s[^\]]*\]\s*/, "")
    .replace(/^<@!?\d+>(?:\([^)]*\))?:\s*/, "")
    .replace(/^\(reply to msg:\d+\)\s*/, "")
    .trim();
}

export function searchableMessageText(message: Message): string | null {
  if (message.isOnboarding || message.isCompactSummary) return null;
  const raw = stringifyContent(message.content).trim();
  if (!raw || IGNORED_SYSTEM_PREFIXES.some(prefix => raw.startsWith(prefix))) return null;
  const text = stripTransportMetadata(raw);
  return text || null;
}

/**
 * The stable identity a search document hangs off, used as its `parent_id`.
 *
 * Messages get a UUID when they are first persisted. A message that reaches indexing
 * without one is identified by its own content instead: the same message must produce
 * the same ID on every rebuild, or its existing documents and attachment references are
 * orphaned and re-indexed. Archives are write-once, so the messages inside them keep
 * resolving through this path rather than ever gaining a stored ID.
 */
export function ensureMessageSearchId(sessionId: string, message: Message, ordinal: number): string {
  if (message.searchId) return message.searchId;
  const derivedIdentity = JSON.stringify({
    sessionId,
    ordinal,
    role: message.role,
    content: message.content,
    time: message.time ?? null,
    msgId: message.msgId ?? null,
    replyTo: message.replyTo ?? null,
  });
  // The prefix is part of the stored identity, not a label.
  message.searchId = `legacy-${stableHash(derivedIdentity)}`;
  return message.searchId;
}

export function assignNewMessageSearchId(message: Message): void {
  if (!message.searchId) message.searchId = randomUUID();
}

function sessionChannelId(sessionId: string): string | undefined {
  if (sessionId.startsWith("discord-channel-")) return sessionId.slice("discord-channel-".length);
  return undefined;
}

function sessionVisibility(_sessionId: string): string {
  // Default-deny until Discord channel membership metadata is available to the indexer.
  // Owner-only recall is safer than accidentally exposing a DM/private thread.
  return "owner_private";
}

function splitText(text: string): string[] {
  if (text.length <= MAX_CHUNK_CHARS) return [text];
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(text.length, start + MAX_CHUNK_CHARS);
    chunks.push(text.slice(start, end));
    if (end >= text.length) break;
    start = Math.max(start + 1, end - CHUNK_OVERLAP_CHARS);
  }
  return chunks;
}

function messageDocument(sessionId: string, message: Message, ordinal: number): SearchDocumentInput | null {
  const text = searchableMessageText(message);
  if (!text) return null;
  const messageId = ensureMessageSearchId(sessionId, message, ordinal);
  return {
    id: createSearchDocumentId("session-message", sessionId, messageId),
    sourceType: "session_message",
    sourceId: sessionId,
    parentId: messageId,
    sessionId,
    channelId: sessionChannelId(sessionId),
    visibilityScope: sessionVisibility(sessionId),
    ordinal,
    role: message.role,
    text,
    occurredAt: message.time,
  };
}

const EXCERPT_HEAD = 1_000;
const EXCERPT_TAIL = 500;

/**
 * Bounded excerpt of a tool result for the embedded evidence summary. The full output is
 * never embedded (see NON_EMBEDDED_SOURCE_TYPES), so this excerpt is the only semantic
 * handle on it — and a plain head slice would miss the tail, which is exactly where tool
 * output puts its errors, totals, and exit status. Keep both ends.
 */
function excerpt(text: string): string {
  if (text.length <= EXCERPT_HEAD + EXCERPT_TAIL) return text;
  return `${text.slice(0, EXCERPT_HEAD)} […] ${text.slice(-EXCERPT_TAIL)}`;
}

function toolDocuments(sessionId: string, event: ToolHistoryEvent, ordinal: number): SearchDocumentInput[] {
  const common = {
    sourceId: sessionId,
    parentId: event.id,
    sessionId,
    channelId: sessionChannelId(sessionId),
    visibilityScope: sessionVisibility(sessionId),
    occurredAt: event.time,
  };
  const inputText = `Tool: ${event.tool}\nStatus: ${event.isError ? "failed" : "succeeded"}\nArguments:\n${JSON.stringify(event.input, null, 2)}`;
  const documents: SearchDocumentInput[] = [{
    ...common,
    id: createSearchDocumentId("tool-call", sessionId, event.id),
    sourceType: "tool_call",
    ordinal,
    role: "assistant",
    text: inputText,
  }];
  const bounded = event.result.replace(/\s+/g, " ").trim();
  documents.push({
    ...common,
    id: createSearchDocumentId("tool-summary", sessionId, event.id),
    sourceType: "tool_evidence_summary",
    ordinal,
    role: "tool",
    text: `Tool ${event.tool} ${event.isError ? "failed" : "succeeded"} at ${event.time}. ${excerpt(bounded) || "No textual output."}`,
  });
  return documents;
}

export function indexSessionMessage(sessionId: string, message: Message, ordinal: number): void {
  const document = messageDocument(sessionId, message, ordinal);
  if (!document) return;
  ingestSearchDocuments([document]);
}

export function indexToolHistoryEvent(sessionId: string, event: ToolHistoryEvent, ordinal: number): void {
  ingestSearchDocuments(toolDocuments(sessionId, event, ordinal));
}

export function indexConversationWindow(sessionId: string, messages: Message[]): void {
  const parts = messages.flatMap((message, index) => {
    const text = searchableMessageText(message);
    if (!text) return [];
    ensureMessageSearchId(sessionId, message, index);
    return [`${message.role}: ${text}`];
  });
  if (parts.length === 0) return;
  const firstId = messages.find(message => searchableMessageText(message))?.searchId;
  const lastId = [...messages].reverse().find(message => searchableMessageText(message))?.searchId;
  const chunks = splitText(parts.join("\n\n"));
  ingestSearchDocuments(chunks.map((text, ordinal) => ({
    id: createSearchDocumentId("conversation-window", sessionId, firstId, lastId, ordinal),
    sourceType: "conversation_window",
    sourceId: sessionId,
    parentId: `${firstId ?? "unknown"}:${lastId ?? "unknown"}`,
    sessionId,
    channelId: sessionChannelId(sessionId),
    visibilityScope: sessionVisibility(sessionId),
    ordinal,
    text,
    occurredAt: messages[0]?.time,
  })));
}

export function indexCompactSummary(sessionId: string, summary: string): void {
  const text = summary.trim();
  if (!text) return;
  ingestSearchDocuments([{
    id: createSearchDocumentId("compact-summary", sessionId, stableHash(text)),
    sourceType: "compact_summary",
    sourceId: sessionId,
    sessionId,
    channelId: sessionChannelId(sessionId),
    visibilityScope: sessionVisibility(sessionId),
    text,
  }]);
}

export function reconcileSessionIndex(
  sessionId: string,
  messages: Message[],
  toolHistory: ToolHistoryEvent[],
): void {
  try {
    const messageDocs = messages.flatMap((message, ordinal) => {
      const doc = messageDocument(sessionId, message, ordinal);
      return doc ? [doc] : [];
    });
    // Session history is append-only across active/compact/archive segments. Never use
    // removeMissingForSource here: after compaction the active JSON contains only the tail,
    // but the indexed archived messages must remain searchable.
    if (messageDocs.length > 0) ingestSearchDocuments(messageDocs);

    for (let ordinal = 0; ordinal < messages.length; ordinal++) {
      const message = messages[ordinal];
      const parentId = ensureMessageSearchId(sessionId, message, ordinal);
      if (message.attachments?.length) {
        reconcileAttachmentReferences(sessionId, parentId, message.attachments);
      }
      if (Array.isArray(message.content)) {
        const inlineImages = message.content.flatMap(block => block.type === "image"
          ? [{ mediaType: block.source.media_type, data: block.source.data }]
          : []);
        if (inlineImages.length > 0) registerInlineImageAttachments(sessionId, parentId, inlineImages);
      }
    }

    const toolDocs = toolHistory.flatMap((event, ordinal) => toolDocuments(sessionId, event, ordinal));
    for (const sourceType of ["tool_call", "tool_evidence_summary"] as const) {
      const docs = toolDocs.filter(doc => doc.sourceType === sourceType);
      if (docs.length > 0) ingestSearchDocuments(docs);
    }
  } catch (error) {
    logger.error({ sessionId, err: (error as Error).message }, "session search reconciliation failed");
  }
}
