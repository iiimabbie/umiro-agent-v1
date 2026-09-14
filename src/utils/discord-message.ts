import { basename, extname } from "node:path";
import {
  AttachmentBuilder,
  MessageFlags,
  type InteractionReplyOptions,
  type MessageCreateOptions,
  type MessageEditOptions,
  type Message,
} from "discord.js";

type MessageComponent = NonNullable<MessageCreateOptions["components"]>[number];

export const DISCORD_TEXT_LIMIT = 2000;

export function assertDiscordV1Text(content: string, label = "message content"): void {
  if (!content) throw new Error(`${label} must not be empty`);
  if (content.length > DISCORD_TEXT_LIMIT) {
    throw new Error(`${label} exceeds Discord's ${DISCORD_TEXT_LIMIT}-character V1 limit (${content.length})`);
  }
}

export interface DiscordMessageOptions {
  files?: readonly string[];
  components?: readonly MessageComponent[];
  allowedMentions?: MessageCreateOptions["allowedMentions"];
  reply?: MessageCreateOptions["reply"];
  ephemeral?: boolean;
  replaceAttachments?: boolean;
}

interface MessageCorePayload {
  content?: string;
  components?: readonly MessageComponent[];
  files?: AttachmentBuilder[];
}

function uniqueAttachmentName(path: string, used: Set<string>): string {
  const original = basename(path) || "attachment";
  const extension = extname(original);
  const stem = extension ? original.slice(0, -extension.length) : original;
  let candidate = original;
  let suffix = 2;
  while (used.has(candidate)) {
    candidate = `${stem}-${suffix}${extension}`;
    suffix++;
  }
  used.add(candidate);
  return candidate;
}

function buildCore(content: string | undefined, options: DiscordMessageOptions): MessageCorePayload {
  const payload: MessageCorePayload = {};
  if (content !== undefined) payload.content = content;
  if (options.components !== undefined) payload.components = options.components;

  if (!options.files?.length) return payload;
  if (options.files.length > 10) throw new Error("Discord messages support at most 10 attachments");

  const usedNames = new Set<string>();
  payload.files = options.files.map(path =>
    new AttachmentBuilder(path).setName(uniqueAttachmentName(path, usedNames)),
  );
  return payload;
}

/** Build a standard Discord (legacy/V1) channel-message payload. */
export function messagePayload(content?: string, options: DiscordMessageOptions = {}): MessageCreateOptions {
  return {
    ...buildCore(content, options),
    ...(options.allowedMentions ? { allowedMentions: options.allowedMentions } : {}),
    ...(options.reply ? { reply: options.reply } : {}),
  };
}

/** Build a standard Discord (legacy/V1) interaction response payload. */
export function interactionPayload(content?: string, options: DiscordMessageOptions = {}): InteractionReplyOptions {
  return {
    ...buildCore(content, options),
    ...(options.ephemeral ? { flags: MessageFlags.Ephemeral } : {}),
    ...(options.allowedMentions ? { allowedMentions: options.allowedMentions } : {}),
  };
}

/** Build a standard Discord (legacy/V1) message edit payload. */
export function editPayload(content?: string, options: DiscordMessageOptions = {}): MessageEditOptions {
  return {
    ...buildCore(content, options),
    ...(options.allowedMentions ? { allowedMentions: options.allowedMentions } : {}),
    ...(options.replaceAttachments ? { attachments: [] } : {}),
  };
}


export interface TextMessageEditResult {
  messageId: string;
  migratedFromComponentsV2: boolean;
  historicalMessageDeleted: boolean;
}

/**
 * Edit a normal V1 message in place. Historical Components V2 messages cannot
 * accept legacy `content`, so migrate them by creating a V1 replacement first
 * and deleting the old message only after the replacement succeeds.
 */
export async function editTextMessageAsV1(
  message: Message,
  content: string | undefined,
  options: DiscordMessageOptions = {},
): Promise<TextMessageEditResult> {
  if (!message.flags.has(MessageFlags.IsComponentsV2)) {
    await message.edit(editPayload(content, options));
    return {
      messageId: message.id,
      migratedFromComponentsV2: false,
      historicalMessageDeleted: true,
    };
  }

  const migratedContent = content ?? extractMessageText(message);
  if (!migratedContent && !options.files?.length) {
    throw new Error("historical Components V2 message has no text or files to migrate");
  }

  if (!("send" in message.channel)) {
    throw new Error("historical Components V2 message channel cannot send a V1 replacement");
  }
  const replacement = await message.channel.send(messagePayload(migratedContent || undefined, options));
  let historicalMessageDeleted = true;
  try {
    await message.delete();
  } catch {
    // The V1 replacement is already authoritative. Return its ID instead of
    // throwing, so callers do not retry by creating another replacement.
    historicalMessageDeleted = false;
  }
  return {
    messageId: replacement.id,
    migratedFromComponentsV2: true,
    historicalMessageDeleted,
  };
}

/** Raw JSON body for direct Discord webhook PATCH requests. */
export function webhookEditBody(content: string): Record<string, unknown> {
  return { content };
}

/**
 * Compatibility body for an interaction response created before the V1 rollback.
 * This is deliberately limited to replacing one historical Text Display during
 * restart completion; all current outbound message paths use `content` payloads.
 */
export function legacyComponentWebhookEditBody(content: string): Record<string, unknown> {
  return {
    components: [{ type: 10, content }],
    flags: 1 << 15,
  };
}

/** Read all user-visible text from standard messages, embeds, and historical component-only messages. */
export function extractMessageText(message: {
  content?: string | null;
  embeds?: readonly { toJSON?: () => unknown }[];
  components?: readonly { toJSON?: () => unknown }[];
  messageSnapshots?: { values(): Iterable<{
    content?: string | null;
    embeds?: readonly { toJSON?: () => unknown }[];
    components?: readonly { toJSON?: () => unknown }[];
  }> };
}): string {
  const texts: string[] = [];
  const addText = (value: unknown): void => {
    if (typeof value === "string" && value.trim()) texts.push(value);
  };

  addText(message.content);

  for (const embedValue of message.embeds ?? []) {
    const embed = (embedValue.toJSON ? embedValue.toJSON() : embedValue) as {
      author?: { name?: unknown };
      title?: unknown;
      description?: unknown;
      fields?: unknown;
      footer?: { text?: unknown };
    };
    addText(embed.author?.name);
    addText(embed.title);
    addText(embed.description);
    if (Array.isArray(embed.fields)) {
      for (const fieldValue of embed.fields) {
        if (!fieldValue || typeof fieldValue !== "object") continue;
        const field = fieldValue as { name?: unknown; value?: unknown };
        addText(field.name);
        addText(field.value);
      }
    }
    addText(embed.footer?.text);
  }

  // Read-only backwards compatibility for messages emitted before all outbound
  // paths returned to V1. No outbound builder calls this traversal or produces
  // component-only payloads.
  const visitHistoricalComponent = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    const component = value as { type?: unknown; content?: unknown; components?: unknown };
    if (component.type === 10) addText(component.content);
    if (Array.isArray(component.components)) {
      for (const child of component.components) visitHistoricalComponent(child);
    }
  };
  for (const component of message.components ?? []) {
    visitHistoricalComponent(component.toJSON ? component.toJSON() : component);
  }

  // Discord includes the original content of forwarded messages in
  // messageSnapshots. The snapshot is a partial Message, so run the same
  // extraction against it instead of relying on the forwarding message's
  // usually-empty content.
  for (const snapshot of message.messageSnapshots?.values() ?? []) {
    const snapshotText = extractMessageText(snapshot);
    if (snapshotText) texts.push(snapshotText);
  }

  return texts.join("\n");
}

export interface ExtractedMessageAttachment {
  url: string;
  name?: string;
  contentType?: string;
  size?: number;
  /**
   * Discord provenance for real uploads (not embeds). `discordAttachmentId` is the stable
   * per-attachment ID; combined with the source message/channel IDs it lets the background
   * worker re-resolve a fresh signed CDN URL after the stored one expires. Embed image/
   * thumbnail URLs carry no attachment ID and therefore no provenance.
   */
  discordAttachmentId?: string;
  discordMessageId?: string;
  discordChannelId?: string;
  /** Source pixel dimensions when Discord reports them; absent for embeds. */
  width?: number;
  height?: number;
}

/** Read user-visible attachments from standard Discord uploads and embeds. */
export function extractMessageAttachments(message: {
  id?: string;
  channelId?: string;
  attachments?: { values?: () => Iterable<{ id?: string; url: string; name?: string | null; contentType?: string | null; size?: number; width?: number | null; height?: number | null }> };
  embeds?: readonly { toJSON?: () => unknown }[];
}): ExtractedMessageAttachment[] {
  const results: ExtractedMessageAttachment[] = [];
  const seen = new Set<string>();
  const messageId = typeof message.id === "string" ? message.id : undefined;
  const channelId = typeof message.channelId === "string" ? message.channelId : undefined;
  const add = (
    url: unknown,
    name?: unknown,
    contentType?: unknown,
    size?: unknown,
    attachmentId?: unknown,
    width?: unknown,
    height?: unknown,
  ): void => {
    if (typeof url !== "string" || seen.has(url)) return;
    seen.add(url);
    // Only real uploads (with a stable attachment ID and a known source message)
    // carry provenance usable for CDN refresh. Embeds get none.
    const hasProvenance = typeof attachmentId === "string" && messageId !== undefined;
    results.push({
      url,
      ...(typeof name === "string" ? { name } : {}),
      ...(typeof contentType === "string" ? { contentType } : {}),
      ...(typeof size === "number" ? { size } : {}),
      ...(typeof width === "number" && typeof height === "number" ? { width, height } : {}),
      ...(hasProvenance ? { discordAttachmentId: attachmentId as string, discordMessageId: messageId } : {}),
      ...(hasProvenance && channelId !== undefined ? { discordChannelId: channelId } : {}),
    });
  };

  const attachmentValues = message.attachments?.values?.();
  if (attachmentValues) {
    for (const attachment of attachmentValues) {
      add(attachment.url, attachment.name, attachment.contentType, attachment.size, attachment.id, attachment.width, attachment.height);
    }
  }

  for (const embedValue of message.embeds ?? []) {
    const embed = (embedValue.toJSON ? embedValue.toJSON() : embedValue) as {
      image?: { url?: unknown };
      thumbnail?: { url?: unknown };
    };
    add(embed.image?.url);
    add(embed.thumbnail?.url);
  }
  return results;
}
