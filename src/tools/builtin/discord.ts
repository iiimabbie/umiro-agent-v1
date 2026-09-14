import { existsSync } from "node:fs";
import type { Client } from "discord.js";
import { logger } from "../../logger.js";
import type { Tool } from "../../types.js";
import { normalizeMentions, formatName } from "../../utils/discord-mentions.js";
import { queueAttachment } from "../context.js";
import { createDiscordButtonMessage, type DiscordButtonDefinition } from "../../discord-buttons.js";
import { resolveEmojiMarkup } from "../../emoji.js";
import { editTextMessageAsV1, extractMessageAttachments, extractMessageText, messagePayload } from "../../utils/discord-message.js";

let discordClient: Client | null = null;

export function setDiscordClient(client: Client): void {
  discordClient = client;
}

export function getDiscordClient(): Client | null {
  return discordClient;
}

function getClient(): Client {
  if (!discordClient) throw new Error("Discord client not initialized (bot not running)");
  return discordClient;
}

async function getTextChannel(channelId: string) {
  const channel = await getClient().channels.fetch(channelId);
  if (!channel || !channel.isTextBased() || !("send" in channel))
    throw new Error(`channel ${channelId} not found or not text-based`);
  return channel;
}

export const discordFetchMessage: Tool = {
  name: "discord_fetch_message",
  description: "Fetch a Discord message by channel and message ID. Use this when you need to look up a message's content.",
  parameters: {
    type: "object",
    properties: {
      channel_id: { type: "string", description: "The Discord channel ID" },
      message_id: { type: "string", description: "The message ID to fetch" },
    },
    required: ["channel_id", "message_id"],
  },
  execute: async (args) => {
    const { channel_id, message_id } = args as { channel_id: string; message_id: string };
    logger.info({ channel_id, message_id }, "discord_fetch_message");
    try {
      const channel = await getTextChannel(channel_id);
      const msg = await channel.messages.fetch(message_id);
      const authorName = formatName(msg.author.username, msg.member?.displayName);
      const content = await normalizeMentions(extractMessageText(msg), getClient(), msg.guild);
      return JSON.stringify({
        messageId: msg.id,
        channelId: msg.channelId,
        author: { id: msg.author.id, name: authorName, isBot: msg.author.bot },
        content,
        timestamp: new Date(msg.createdTimestamp).toISOString(),
        editedTimestamp: msg.editedTimestamp ? new Date(msg.editedTimestamp).toISOString() : null,
        attachments: extractMessageAttachments(msg).map(attachment => attachment.url),
        replyToMessageId: msg.reference?.messageId,
        referenceChannelId: msg.reference?.channelId,
      }, null, 2);
    } catch (err) {
      return `Error: ${(err as Error).message}`;
    }
  },
};

export const discordSendMessage: Tool = {
  name: "discord_send_message",
  description: "Send a message to a Discord channel. Supports text, file attachments (images, documents), or both.",
  parameters: {
    type: "object",
    properties: {
      channel_id: { type: "string", description: "The Discord channel ID" },
      content: { type: "string", description: "The message content to send (optional if files provided)" },
      reply_to: { type: "string", description: "Optional message ID to reply to" },
      files: {
        type: "array",
        items: { type: "string" },
        description: "Optional array of local file paths to attach (images, documents, etc.)",
      },
    },
    required: ["channel_id"],
  },
  execute: async (args) => {
    const { channel_id, content, reply_to, files } = args as {
      channel_id: string; content?: string; reply_to?: string; files?: string[];
    };
    if (!content && (!files || files.length === 0)) return "Error: must provide content or files";
    logger.info({ channel_id, content: content?.slice(0, 100), reply_to, files }, "discord_send_message");
    try {
      const channel = await getTextChannel(channel_id);
      const sent = await channel.send(messagePayload(
        content ? resolveEmojiMarkup(content) : undefined,
        {
          files,
          ...(reply_to ? { reply: { messageReference: reply_to } } : {}),
        },
      ));
      return `Message sent (msg:${sent.id})`;
    } catch (err) {
      return `Error: ${(err as Error).message}`;
    }
  },
};

export const discordSendButtons: Tool = {
  name: "discord_send_buttons",
  description: "Send a Discord message with 1-5 configurable buttons. Buttons are generic interaction primitives: execute a registered tool, open a modal to edit one string argument of another button, or close the button set without executing anything. Labels and styles are fully caller-defined; this tool is not limited to confirmation flows.",
  parameters: {
    type: "object",
    properties: {
      channel_id: { type: "string", description: "Discord channel ID where the message should be sent" },
      content: { type: "string", description: "Message content displayed above the buttons" },
      allowed_user_ids: { type: "array", items: { type: "string" }, description: "Optional Discord user IDs allowed to click. Defaults to the configured owner." },
      buttons: {
        type: "array",
        minItems: 1,
        maxItems: 5,
        description: "Configurable buttons. Use behavior=execute to run a tool, edit to modify a target execute button's string argument, or close to end without an action.",
        items: {
          type: "object",
          properties: {
            id: { type: "string", description: "Unique button ID using letters, numbers, underscore, or hyphen (max 32 chars)" },
            label: { type: "string", description: "Visible button label (max 80 chars)" },
            style: { type: "string", enum: ["primary", "secondary", "success", "danger"], description: "Discord button style" },
            behavior: { type: "string", enum: ["execute", "edit", "close"], description: "What clicking the button does" },
            action_tool: { type: "string", description: "For execute: registered tool to run" },
            action_args: { type: "object", description: "For execute: arguments passed to action_tool" },
            target_button_id: { type: "string", description: "For edit: ID of the execute button whose action_args will be edited" },
            editable_field: { type: "string", description: "For edit: top-level string field in the target button's action_args" },
            editable_label: { type: "string", description: "For edit: modal title/input label" },
            result_text: { type: "string", description: "Optional text shown after execute or close; otherwise the tool result/button label is shown" },
            disable_all_on_complete: { type: "boolean", description: "Independent mode only: when this execute button succeeds, disable every actionable button in the set (e.g. an Approve All button)" },
          },
          required: ["id", "label", "style", "behavior"],
        },
      },
      interaction_mode: { type: "string", enum: ["group", "independent"], description: "'group' (default): the first execute/close ends the whole set. 'independent': each button acts on its own; acted-on buttons grey out while the rest stay clickable until all are done." },
      preview_button_id: { type: "string", description: "Optional execute button ID whose string argument should be previewed in the message" },
      preview_field: { type: "string", description: "Optional string field from preview_button_id action_args to display and refresh after edits" },
      preview_label: { type: "string", description: "Optional label above the dynamic preview" },
      expires_in_minutes: { type: "number", description: "Optional expiry, 1-10080 minutes (default 1440 / 24 hours)" },
    },
    required: ["channel_id", "content", "buttons"],
  },
  execute: async (args) => {
    const {
      channel_id, content, allowed_user_ids, buttons, interaction_mode, preview_button_id, preview_field, preview_label, expires_in_minutes,
    } = args as {
      channel_id: string;
      content: string;
      allowed_user_ids?: string[];
      buttons: Array<{
        id: string;
        label: string;
        style: "primary" | "secondary" | "success" | "danger";
        behavior: "execute" | "edit" | "close";
        action_tool?: string;
        action_args?: Record<string, unknown>;
        target_button_id?: string;
        editable_field?: string;
        editable_label?: string;
        result_text?: string;
        disable_all_on_complete?: boolean;
      }>;
      interaction_mode?: "group" | "independent";
      preview_button_id?: string;
      preview_field?: string;
      preview_label?: string;
      expires_in_minutes?: number;
    };
    const definitions: DiscordButtonDefinition[] = buttons.map(button => ({
      id: button.id,
      label: button.label,
      style: button.style,
      behavior: button.behavior,
      actionTool: button.action_tool,
      actionArgs: button.action_args,
      targetButtonId: button.target_button_id,
      editableField: button.editable_field,
      editableLabel: button.editable_label,
      resultText: button.result_text,
      disableAllOnComplete: button.disable_all_on_complete,
    }));
    logger.info({ channel_id, buttonCount: definitions.length }, "discord_send_buttons");
    try {
      const record = await createDiscordButtonMessage(getClient(), {
        channelId: channel_id,
        content,
        buttons: definitions,
        allowedUserIds: allowed_user_ids,
        interactionMode: interaction_mode,
        previewButtonId: preview_button_id,
        previewField: preview_field,
        previewLabel: preview_label,
        expiresInMinutes: expires_in_minutes,
      });
      return `Button message sent (buttons:${record.id}, msg:${record.messageId})`;
    } catch (err) {
      return `Error: ${(err as Error).message}`;
    }
  },
};

export const discordReact: Tool = {
  name: "discord_react",
  description: "Add one or more emoji reactions to a Discord message. Supports single emoji or array of emojis.",
  parameters: {
    type: "object",
    properties: {
      channel_id: { type: "string", description: "The Discord channel ID" },
      message_id: { type: "string", description: "The message ID to react to" },
      emoji: {
        oneOf: [
          { type: "string", description: "Single emoji" },
          { type: "array", items: { type: "string" }, description: "Multiple emojis" },
        ],
        description: "Emoji(s) to react with (e.g. '👍' or ['👍', '❤️', '🔥'])",
      },
    },
    required: ["channel_id", "message_id", "emoji"],
  },
  execute: async (args) => {
    const { channel_id, message_id, emoji } = args as { channel_id: string; message_id: string; emoji: string | string[] };
    const emojis = Array.isArray(emoji) ? emoji : [emoji];
    logger.info({ channel_id, message_id, emojis }, "discord_react");
    try {
      const channel = await getTextChannel(channel_id);
      const msg = await channel.messages.fetch(message_id);
      for (const e of emojis) await msg.react(resolveEmojiMarkup(e));
      return `Reacted with ${emojis.join(" ")}`;
    } catch (err) {
      return `Error: ${(err as Error).message}`;
    }
  },
};

export const discordPin: Tool = {
  name: "discord_pin",
  description: "Pin a message in a Discord channel.",
  parameters: {
    type: "object",
    properties: {
      channel_id: { type: "string", description: "The Discord channel ID" },
      message_id: { type: "string", description: "The message ID to pin" },
    },
    required: ["channel_id", "message_id"],
  },
  execute: async (args) => {
    const { channel_id, message_id } = args as { channel_id: string; message_id: string };
    logger.info({ channel_id, message_id }, "discord_pin");
    try {
      const channel = await getTextChannel(channel_id);
      const msg = await channel.messages.fetch(message_id);
      await msg.pin();
      return `Message pinned`;
    } catch (err) {
      return `Error: ${(err as Error).message}`;
    }
  },
};

export const discordUnpin: Tool = {
  name: "discord_unpin",
  description: "Unpin a message in a Discord channel.",
  parameters: {
    type: "object",
    properties: {
      channel_id: { type: "string", description: "The Discord channel ID" },
      message_id: { type: "string", description: "The message ID to unpin" },
    },
    required: ["channel_id", "message_id"],
  },
  execute: async (args) => {
    const { channel_id, message_id } = args as { channel_id: string; message_id: string };
    logger.info({ channel_id, message_id }, "discord_unpin");
    try {
      const channel = await getTextChannel(channel_id);
      const msg = await channel.messages.fetch(message_id);
      await msg.unpin();
      return `Message unpinned`;
    } catch (err) {
      return `Error: ${(err as Error).message}`;
    }
  },
};

export const discordCreateThread: Tool = {
  name: "discord_create_thread",
  description: "Create a thread from a message in a Discord channel.",
  parameters: {
    type: "object",
    properties: {
      channel_id: { type: "string", description: "The Discord channel ID" },
      message_id: { type: "string", description: "The message ID to create a thread from" },
      name: { type: "string", description: "The thread name" },
    },
    required: ["channel_id", "message_id", "name"],
  },
  execute: async (args) => {
    const { channel_id, message_id, name } = args as { channel_id: string; message_id: string; name: string };
    logger.info({ channel_id, message_id, name }, "discord_create_thread");
    try {
      const channel = await getTextChannel(channel_id);
      const msg = await channel.messages.fetch(message_id);
      if (!("startThread" in msg)) return "Error: cannot create thread from this message";
      const thread = await msg.startThread({ name });
      return `Thread created: ${thread.name} (${thread.id})`;
    } catch (err) {
      return `Error: ${(err as Error).message}`;
    }
  },
};

export const discordCreateForumPost: Tool = {
  name: "discord_create_forum_post",
  description: "Create a new post (thread) in a Discord forum channel.",
  parameters: {
    type: "object",
    properties: {
      channel_id: { type: "string", description: "The forum channel ID" },
      title: { type: "string", description: "The post title" },
      content: { type: "string", description: "The initial message content of the post" },
    },
    required: ["channel_id", "title", "content"],
  },
  execute: async (args) => {
    const { channel_id, title, content } = args as { channel_id: string; title: string; content: string };
    logger.info({ channel_id, title }, "discord_create_forum_post");
    try {
      const channel = await getClient().channels.fetch(channel_id);
      if (!channel || !("threads" in channel)) return `Error: channel ${channel_id} is not a forum channel`;
      const thread = await (channel as import("discord.js").ForumChannel).threads.create({
        name: title,
        message: messagePayload(resolveEmojiMarkup(content)),
      });
      return `Forum post created: "${thread.name}" (thread:${thread.id})`;
    } catch (err) {
      return `Error: ${(err as Error).message}`;
    }
  },
};

export const discordDeleteThread: Tool = {
  name: "discord_delete_thread",
  description: "Delete a thread in a Discord channel. IRREVERSIBLE — the whole thread and its history go with it. To just take it out of the active list, use discord_archive_thread instead.",
  parameters: {
    type: "object",
    properties: {
      thread_id: { type: "string", description: "The thread ID to delete" },
    },
    required: ["thread_id"],
  },
  execute: async (args) => {
    const { thread_id } = args as { thread_id: string };
    logger.info({ thread_id }, "discord_delete_thread");
    try {
      const channel = await getClient().channels.fetch(thread_id);
      if (!channel || !channel.isThread()) return `Error: ${thread_id} is not a thread`;
      await channel.delete();
      return `Thread deleted`;
    } catch (err) {
      return `Error: ${(err as Error).message}`;
    }
  },
};

export const discordArchiveThread: Tool = {
  name: "discord_archive_thread",
  description: "Archive or unarchive a thread/forum post in Discord.",
  parameters: {
    type: "object",
    properties: {
      thread_id: { type: "string", description: "The thread ID to archive/unarchive" },
      archived: { type: "boolean", description: "true to archive, false to unarchive (default: true)" },
    },
    required: ["thread_id"],
  },
  execute: async (args) => {
    const { thread_id, archived = true } = args as { thread_id: string; archived?: boolean };
    logger.info({ thread_id, archived }, "discord_archive_thread");
    try {
      const channel = await getClient().channels.fetch(thread_id);
      if (!channel || !channel.isThread()) return `Error: ${thread_id} is not a thread`;
      await channel.setArchived(archived);
      return `Thread ${archived ? "archived" : "unarchived"}`;
    } catch (err) {
      return `Error: ${(err as Error).message}`;
    }
  },
};

export const discordEditMessage: Tool = {
  name: "discord_edit_message",
  description: "Edit one of the bot's own messages. Can update text and/or replace attachments.",
  parameters: {
    type: "object",
    properties: {
      channel_id: { type: "string", description: "The Discord channel ID" },
      message_id: { type: "string", description: "The message ID to edit (must be the bot's own message)" },
      content: { type: "string", description: "The new message content" },
      files: {
        type: "array",
        items: { type: "string" },
        description: "Optional array of local file paths to attach (replaces existing attachments)",
      },
    },
    required: ["channel_id", "message_id"],
  },
  execute: async (args) => {
    const { channel_id, message_id, content, files } = args as {
      channel_id: string; message_id: string; content?: string; files?: string[];
    };
    if (!content && (!files || files.length === 0)) return "Error: must provide content or files";
    logger.info({ channel_id, message_id, content: content?.slice(0, 100), files }, "discord_edit_message");
    try {
      const channel = await getTextChannel(channel_id);
      const msg = await channel.messages.fetch(message_id);
      if (msg.author.id !== getClient().user?.id) return "Error: can only edit own messages";
      const nextText = content !== undefined ? resolveEmojiMarkup(content) : undefined;
      const result = await editTextMessageAsV1(msg, nextText, {
        files,
        replaceAttachments: Boolean(files?.length),
      });
      if (result.migratedFromComponentsV2 && !result.historicalMessageDeleted) {
        return `Message migrated to V1 and edited (msg:${result.messageId}), but the historical message could not be deleted`;
      }
      return result.migratedFromComponentsV2
        ? `Message migrated to V1 and edited (msg:${result.messageId})`
        : `Message edited (msg:${result.messageId})`;
    } catch (err) {
      return `Error: ${(err as Error).message}`;
    }
  },
};

export const discordDeleteMessage: Tool = {
  name: "discord_delete_message",
  description: "Delete one of the bot's own messages. IRREVERSIBLE. To fix wording or redact content, prefer discord_edit_message — and after redacting, do not re-mention the removed content in your reply.",
  parameters: {
    type: "object",
    properties: {
      channel_id: { type: "string", description: "The Discord channel ID" },
      message_id: { type: "string", description: "The message ID to delete (must be the bot's own message)" },
    },
    required: ["channel_id", "message_id"],
  },
  execute: async (args) => {
    const { channel_id, message_id } = args as { channel_id: string; message_id: string };
    logger.info({ channel_id, message_id }, "discord_delete_message");
    try {
      const channel = await getTextChannel(channel_id);
      const msg = await channel.messages.fetch(message_id);
      if (msg.author.id !== getClient().user?.id) return "Error: can only delete own messages";
      await msg.delete();
      return `Message deleted`;
    } catch (err) {
      return `Error: ${(err as Error).message}`;
    }
  },
};

export const discordFetchChannelMessages: Tool = {
  name: "discord_fetch_channel_messages",
  description: "Fetch recent messages from a Discord channel. Returns up to `limit` messages (default 20, max 100), always ordered newest-first regardless of before/after mode. Optionally fetch messages before or after a given message ID for pagination.",
  parameters: {
    type: "object",
    properties: {
      channel_id: { type: "string", description: "The Discord channel ID" },
      limit: { type: "number", description: "Number of messages to fetch (default 20, max 100)" },
      before: { type: "string", description: "Fetch messages before this message ID (for pagination)" },
      after: { type: "string", description: "Fetch messages after this message ID" },
    },
    required: ["channel_id"],
  },
  execute: async (args) => {
    const { channel_id, limit = 20, before, after } = args as {
      channel_id: string;
      limit?: number;
      before?: string;
      after?: string;
    };
    logger.info({ channel_id, limit, before, after }, "discord_fetch_channel_messages");
    try {
      const channel = await getTextChannel(channel_id);
      const fetchOptions: { limit: number; before?: string; after?: string } = {
        limit: Math.min(Math.max(1, limit), 100),
      };
      if (before) fetchOptions.before = before;
      if (after) fetchOptions.after = after;
      const messages = await channel.messages.fetch(fetchOptions);
      const client = getClient();
      // 統一 newest-first：after 模式 Discord API 回傳是舊到新，在這裡強制排序
      const sorted = Array.from(messages.values()).sort((a, b) => b.createdTimestamp - a.createdTimestamp);
      const result = await Promise.all(sorted.map(async msg => {
        const authorName = formatName(msg.author.username, msg.member?.displayName);
        const content = await normalizeMentions(extractMessageText(msg), client, msg.guild);
        return {
          messageId: msg.id,
          author: { id: msg.author.id, name: authorName, isBot: msg.author.bot },
          content,
          timestamp: new Date(msg.createdTimestamp).toISOString(),
          editedTimestamp: msg.editedTimestamp ? new Date(msg.editedTimestamp).toISOString() : null,
          replyToMessageId: msg.reference?.messageId ?? null,
          referenceChannelId: msg.reference?.channelId ?? null,
          attachments: extractMessageAttachments(msg).map(attachment => attachment.url),
        };
      }));
      return JSON.stringify(result, null, 2);
    } catch (err) {
      return `Error: ${(err as Error).message}`;
    }
  },
};

export const discordAttachToReply: Tool = {
  name: "discord_attach_to_reply",
  description: "Queue a local file to be included in your final Discord reply message. The file will be attached to the SAME message as your text response (not a separate message). Always prefer this over discord_send_message with files when you want to combine text + attachment in one reply. Supports any file type (images, documents, etc.).",
  parameters: {
    type: "object",
    properties: {
      file: { type: "string", description: "Local file path to attach (e.g. /tmp/image.png, /tmp/report.pdf)" },
    },
    required: ["file"],
  },
  execute: async (args) => {
    const { file } = args as { file: string };
    logger.info({ file }, "discord_attach_to_reply");
    if (!existsSync(file)) return `Error: file not found: ${file}`;
    queueAttachment(file);
    return `Queued ${file} for attachment`;
  },
};
