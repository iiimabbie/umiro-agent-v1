import {
  Client, GatewayIntentBits, Events, REST, Routes,
  SlashCommandBuilder, MessageFlags, EmbedBuilder, ActivityType, PresenceStatusData,
  type Message, type Interaction, type TextBasedChannel,
} from "discord.js";
import { discordPeopleVisibility } from "./people-context.js";
import { ask, compactSession } from "./agent.js";
import { Session } from "./session.js";
import { SESSION_SUMMARIZE_PROMPT } from "./prompt.js";
import { logger } from "./logger.js";
import { loadConfig, REASONING_EFFORTS, type ReasoningEffort } from "./config.js";
import { activeLlmProfile, sessionLlmProfile } from "./llm/profile.js";
import { listConversationModels } from "./llm/models.js";
import { setDiscordClient } from "./tools/builtin/discord.js";
import { executeTool } from "./tools/registry.js";
import { runWithContext } from "./tools/context.js";
import { handleDiscordButtonInteraction, initializeDiscordButtonStore } from "./discord-buttons.js";
import { fixMarkdownLinks } from "./utils/format.js";
import { chunkMessage } from "./utils/chunk-message.js";
import { extractMessageAttachments, extractMessageText, editPayload, interactionPayload, legacyComponentWebhookEditBody, messagePayload, webhookEditBody } from "./utils/discord-message.js";
import type { ExtractedMessageAttachment } from "./utils/discord-message.js";
import { boundedImageUrl } from "./utils/image-url.js";
import { imageIndexInstruction, parseImageIndexBlock, stripImageIndexBlock } from "./utils/image-index-block.js";
import { normalizeMentions, formatName } from "./utils/discord-mentions.js";
import { stamp } from "./utils/time.js";
import { isNoReplySentinel } from "./utils/no-reply.js";
import { isIgnoredChannel } from "./utils/ignored-channels.js";
import {
  executePluginSlashCommand,
  getPluginRuntimeStatus,
  getPluginSlashCommands,
  isPluginSlashCommandOwnerOnly,
} from "./tools/plugin-loader.js";
import {
  installPlugin,
  listManagedPluginNames,
  removeManagedPlugin,
  updatePlugins,
} from "./plugin-manager.js";
import { syncApplicationEmojis, resolveEmojiMarkup } from "./emoji.js";
import { KeyedSerialQueue } from "./utils/keyed-serial-queue.js";
import { activeRuns, RunStoppedError } from "./active-runs.js";
import { loadToolActivityPools, mergeToolActivityPools, ToolActivityPicker } from "./utils/tool-activity.js";
import { shouldOnboard, buildOnboardingContext, isWorkspaceUnconfigured } from "./onboarding.js";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT } from "./paths.js";

import { loadCrons } from "./tools/builtin/cron.js";
import { getAuthClient, getAuthUrl, exchangeCode } from "./google/auth.js";
import { google } from "googleapis";
import { loadReminders } from "./tools/builtin/reminder.js";
import type { AttachmentReference, DiscordQueueMode, TokenUsage, ProgressEvent } from "./types.js";
import { prepareRemoteAttachmentReferences, type RemoteAttachmentInput, applyInlineImageDescriptions } from "./attachment-index.js";

function buildChannelContext(channelId: string, sessionId: string, extra?: string): string {
  const lines = [
    `<discord-context>`,
    `Channel ID: ${channelId}`,
    ...(extra ? [extra] : []),
    `Session: ${sessionId}`,
    `Use this channel_id when creating reminders or cron jobs for this conversation.`,
    `</discord-context>`,
  ];
  return lines.join("\n");
}

function getChannelTypeInfo(channel: TextBasedChannel | null | undefined): string {
  if (!channel) return "";
  const channelType = channel.isThread()
    ? (channel.parent && "type" in channel.parent && channel.parent.type === 15 ? "forum post" : "thread")
    : (channel.isDMBased() ? "DM" : "channel");
  const parentInfo = channel.isThread() && channel.parentId ? `Parent channel: ${channel.parentId}` : "";
  const threadName = channel.isThread() ? `Thread name: "${channel.name}"` : "";
  return [
    `Channel type: ${channelType}`,
    parentInfo,
    threadName,
  ].filter(Boolean).join("\n");
}

const SLASH_COMMANDS = [
  new SlashCommandBuilder()
    .setName("new")
    .setDescription("Start a new conversation and archive the current session")
    .toJSON(),
  new SlashCommandBuilder()
    .setName("status")
    .setDescription("Show bot status")
    .toJSON(),
  new SlashCommandBuilder()
    .setName("stop")
    .setDescription("Stop the active run in the current session")
    .toJSON(),
  new SlashCommandBuilder()
    .setName("queue")
    .setDescription("Set the message handling mode for the current session")
    .addStringOption(opt => opt.setName("mode").setDescription("followup, steer, or reset").setRequired(true).addChoices(
      { name: "followup (queue a new run)", value: "followup" },
      { name: "steer (merge at the next safe boundary)", value: "steer" },
      { name: "reset (use the global default)", value: "reset" },
    ))
    .toJSON(),
  new SlashCommandBuilder()
    .setName("restart")
    .setDescription("Restart the Umiro gateway (owner only)")
    .toJSON(),
  new SlashCommandBuilder()
    .setName("model")
    .setDescription("Switch the AI model (owner only)")
    .addStringOption(opt =>
      opt.setName("name").setDescription("Model name").setRequired(true).setAutocomplete(true)
    )
    .addStringOption(opt =>
      opt.setName("effort")
        .setDescription("Reasoning effort (omit to use the model default)")
        .setRequired(false)
        .addChoices(...REASONING_EFFORTS.map(value => ({
          name: value === "default" ? "default (model default)" : value,
          value,
        })))
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName("google-auth")
    .setDescription("Authorize Google OAuth (owner only)")
    .addStringOption(opt =>
      opt.setName("callback").setDescription("Redirect URL after authorization").setRequired(false)
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName("task")
    .setDescription("List Google Tasks")
    .toJSON(),
  new SlashCommandBuilder()
    .setName("compact")
    .setDescription("Compact the current session while preserving recent messages")
    .toJSON(),
  new SlashCommandBuilder()
    .setName("plugin")
    .setDescription("Install, update, or remove Umiro plugins (owner only)")
    .addStringOption(opt =>
      opt.setName("action")
        .setDescription("Plugin operation")
        .setRequired(true)
        .addChoices(
          { name: "install", value: "install" },
          { name: "update", value: "update" },
          { name: "remove", value: "remove" },
        )
    )
    .addStringOption(opt =>
      opt.setName("target")
        .setDescription("GitHub URL for install, or plugin name for update/remove")
        .setRequired(false)
        .setAutocomplete(true)
    )
    .toJSON(),
];

const BUILTIN_SLASH_COMMAND_NAMES = new Set(SLASH_COMMANDS.map(command => command.name));

function buildPluginSlashCommands(): ReturnType<SlashCommandBuilder["toJSON"]>[] {
  return getPluginSlashCommands().flatMap(registration => {
    if (BUILTIN_SLASH_COMMAND_NAMES.has(registration.name)) {
      logger.error({ command: registration.name }, "plugin slash command conflicts with a built-in command; skipping registration");
      return [];
    }
    const builder = new SlashCommandBuilder()
      .setName(registration.name)
      .setDescription(registration.description);
    for (const option of registration.options ?? []) {
      if (option.type === "string") {
        builder.addStringOption(input => {
          input.setName(option.name).setDescription(option.description).setRequired(option.required === true);
          const choices = option.choices?.filter(choice => typeof choice.value === "string") as Array<{ name: string; value: string }> | undefined;
          if (choices?.length) input.addChoices(...choices);
          return input;
        });
      } else if (option.type === "integer") {
        builder.addIntegerOption(input => {
          input.setName(option.name).setDescription(option.description).setRequired(option.required === true);
          const choices = option.choices?.filter(choice => typeof choice.value === "number") as Array<{ name: string; value: number }> | undefined;
          if (choices?.length) input.addChoices(...choices);
          return input;
        });
      } else if (option.type === "boolean") {
        builder.addBooleanOption(input => input
          .setName(option.name)
          .setDescription(option.description)
          .setRequired(option.required === true));
      } else {
        builder.addChannelOption(input => input
          .setName(option.name)
          .setDescription(option.description)
          .setRequired(option.required === true));
      }
    }
    return [builder.toJSON()];
  });
}

const OWNER_ONLY_MSG = "只有 owner 能用這個指令！";
// Discord.js does not await async MessageCreate listeners. Serialize all work that
// touches the same session so a later message cannot enter the session or start an
// agent request before the previous reply has been fully delivered.
const discordSessionQueue = new KeyedSerialQueue();

interface PendingRestart {
  applicationId: string;
  token: string;
  createdAt: number;
}

const RESTART_STATE_FILE = join(tmpdir(), `umiro-restart-${process.getuid?.() ?? "unknown"}.json`);
const RESTART_TOKEN_TTL_MS = 14 * 60 * 1000;
const execFileAsync = promisify(execFile);

async function savePendingRestart(applicationId: string, token: string): Promise<void> {
  const state: PendingRestart = { applicationId, token, createdAt: Date.now() };
  await writeFile(RESTART_STATE_FILE, JSON.stringify(state), { mode: 0o600 });
}

async function completePendingRestart(botName: string): Promise<void> {
  let state: PendingRestart;
  try {
    state = JSON.parse(await readFile(RESTART_STATE_FILE, "utf8")) as PendingRestart;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      logger.error({ err: (err as Error).message }, "failed to read pending restart state");
    }
    return;
  }

  const isValid = typeof state.applicationId === "string"
    && typeof state.token === "string"
    && typeof state.createdAt === "number";
  if (!isValid || Date.now() - state.createdAt > RESTART_TOKEN_TTL_MS) {
    await unlink(RESTART_STATE_FILE).catch(() => {});
    logger.warn("discarded invalid or expired pending restart state");
    return;
  }

  const url = `https://discord.com/api/v10/webhooks/${encodeURIComponent(state.applicationId)}/${encodeURIComponent(state.token)}/messages/@original`;
  const completion = `${botName} says Hi again 🫶🏻`;
  let response = await fetch(url, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(webhookEditBody(completion)),
  });

  // A restart started before the V1 rollback has a component-only interaction
  // response. Discord rejects `content` for that historical response, so retry
  // only this completion edit with its original representation. New /restart
  // responses never take this branch.
  if (!response.ok) {
    const failure = await response.text();
    if (!failure.includes("MESSAGE_CANNOT_USE_LEGACY_FIELDS_WITH_COMPONENTS_V2")) {
      throw new Error(`Discord interaction edit failed: ${response.status} ${failure}`);
    }
    response = await fetch(url, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(legacyComponentWebhookEditBody(completion)),
    });
    if (!response.ok) {
      throw new Error(`Discord historical interaction edit failed: ${response.status} ${await response.text()}`);
    }
    logger.info("pending historical restart message updated successfully");
  } else {
    logger.info("pending restart message updated successfully");
  }

  await unlink(RESTART_STATE_FILE).catch(() => {});
}

/** 讓 process 退出，由 systemd (Restart=always) 負責重啟。 */
function selfRestart(): void {
  logger.info("self-restart: exiting, systemd will restart");
  process.exit(0);
}

async function registerSlashCommands(token: string, clientId: string, guildIds: string[]): Promise<void> {
  const rest = new REST({ version: "10" }).setToken(token);
  try {
    await rest.put(Routes.applicationCommands(clientId), { body: [] });
    const commands = [...SLASH_COMMANDS, ...buildPluginSlashCommands()];
    for (const guildId of guildIds) {
      await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
      logger.info({ guildId, count: commands.length }, "slash commands registered to guild");
    }
  } catch (err) {
    logger.error({ err: (err as Error).message }, "slash command registration failed");
  }
}

async function parseGitHubPluginSource(source: string): Promise<{ repository: string; workspace?: string; ref?: string }> {
  const url = new URL(source);
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com") {
    throw new Error("Discord installation only accepts an HTTPS GitHub link");
  }
  if (url.username || url.password) {
    throw new Error("Do not put credentials or tokens in the GitHub link");
  }
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length < 2) throw new Error("Enter a complete GitHub repository link");

  const owner = segments[0];
  const repositoryName = segments[1].replace(/\.git$/i, "");
  const repository = `https://github.com/${owner}/${repositoryName}.git`;
  if (segments.length === 2) return { repository };

  if (segments[2] !== "tree" || segments.length < 5) {
    throw new Error("Use a repository link or a GitHub /tree/<branch>/<package> link");
  }

  const treePath = segments.slice(3).map(segment => decodeURIComponent(segment)).join("/");
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync("git", ["ls-remote", "--heads", repository], {
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    }));
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Unable to inspect GitHub branches: ${detail}`);
  }

  const refs = stdout
    .split("\n")
    .map(line => line.match(/\trefs\/heads\/(.+)$/)?.[1])
    .filter((ref): ref is string => Boolean(ref))
    .sort((a, b) => b.length - a.length);
  const ref = refs.find(candidate => treePath.startsWith(`${candidate}/`));
  if (!ref) {
    throw new Error("The GitHub tree link does not contain a valid branch and package path");
  }

  const workspace = treePath.slice(ref.length + 1);
  return { repository, workspace, ref };
}

function truncateInteractionReply(content: string): string {
  const limit = 1_900;
  return content.length <= limit ? content : `${content.slice(0, limit)}\n…output truncated`;
}

function sessionIdForMessage(msg: Message): string {
  return msg.guild
    ? `discord-channel-${msg.channelId}`
    : `discord-dm-${msg.author.id}`;
}

function effectiveQueueMode(session: Session, config = loadConfig()): { mode: DiscordQueueMode; source: "session" | "global" } {
  const override = session.getQueueModeOverride();
  return override ? { mode: override, source: "session" } : { mode: config.discord.queue_mode, source: "global" };
}

export async function startBot(token: string, beforeCommandRegistration?: () => Promise<void>): Promise<void> {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
  });

  setDiscordClient(client);
  let acceptingTraffic = false;

  const readyInitialization = new Promise<void>((resolve, reject) => {
    client.once(Events.ClientReady, async (c) => {
      try {
        logger.info({ user: c.user.tag }, "discord bot ready");
        console.log(`Discord bot logged in as ${c.user.tag}`);

        const config = loadConfig();
        c.user.setPresence({
          status: (config.discord.status || "online") as PresenceStatusData,
          activities: [{ name: config.discord.activity || "Burrowing around", type: ActivityType.Custom }],
        });

        // Migrate legacy JSON button state before reporting restart completion or
        // accepting interactions. The old file is archived only after a full import.
        await initializeDiscordButtonStore();

        await completePendingRestart(c.user.username).catch(err =>
          logger.error({ err: (err as Error).message }, "failed to update restart completion message")
        );

        // Plugin lifecycle hooks may publish messages, so they start only after the
        // Discord client is ready. Their commands are registered immediately after.
        await beforeCommandRegistration?.();
        const guildIds = c.guilds.cache.map(g => g.id);
        await registerSlashCommands(token, c.user.id, guildIds);

        // Sync Application Emojis into the in-memory cache. Failure is non-fatal: the
        // helper logs the original Error and leaves the cache empty (safe no-emoji mode),
        // so the bot never fails to start over this.
        await syncApplicationEmojis(c);

        if (!config.discord.owner_id) {
          console.log("Discord owner is not configured. Run `umiro onbord` locally, then use the bot in Discord.");
          logger.warn("fresh install awaiting local onboarding command");
        }
        acceptingTraffic = true;
        resolve();
      } catch (err) {
        reject(err);
      }
    });
  });

  client.on(Events.InteractionCreate, async (interaction: Interaction) => {
    if (!acceptingTraffic) return;
    try {
      const handled = await handleDiscordButtonInteraction(
        interaction,
        client,
        (toolName, args) => {
          const trigger = interaction.user.id === loadConfig().discord.owner_id ? "discord-owner" : "discord-other";
          return runWithContext(
            trigger,
            interaction.user.id,
            activeLlmProfile(loadConfig()),
            () => executeTool(toolName, args),
          );
        },
      );
      if (handled) return;
    } catch (err) {
      logger.error({ err, customId: "customId" in interaction ? interaction.customId : undefined }, "Discord button interaction failed");
      if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
        await interaction.reply(interactionPayload("處理按鈕互動時發生錯誤，請先不要重複操作；可查看原訊息狀態或日誌確認結果。", { ephemeral: true })).catch(() => {});
      }
      return;
    }

    if (interaction.isAutocomplete()) {
      if (interaction.commandName === "model") {
        const focused = interaction.options.getFocused();
        const config = loadConfig();
        const sessionId = interaction.guild
          ? `discord-channel-${interaction.channelId}`
          : `discord-dm-${interaction.user.id}`;
        const session = new Session(sessionId);
        const profile = sessionLlmProfile(config, session.getModelSettings());
        const models = await listConversationModels(profile);
        const needle = focused.toLowerCase();
        const filtered = models
          .filter(model => model.toLowerCase().includes(needle))
          .slice(0, 25);
        await interaction.respond(filtered.map(m => ({ name: m, value: m })));
        return;
      }

      if (interaction.commandName === "plugin") {
        if (interaction.user.id !== loadConfig().discord.owner_id) {
          await interaction.respond([]);
          return;
        }
        const action = interaction.options.getString("action");
        if (action !== "update" && action !== "remove") {
          await interaction.respond([]);
          return;
        }
        const focused = interaction.options.getFocused().toLowerCase();
        const names = listManagedPluginNames()
          .filter(name => name.toLowerCase().includes(focused))
          .slice(0, 25);
        await interaction.respond(names.map(name => ({ name, value: name })));
        return;
      }

    }

    if (!interaction.isChatInputCommand()) return;

    // Before the local installer records owner_id, reject every Discord command.
    // This is intentionally before any session write or owner-only command check.
    if (!loadConfig().discord.owner_id) {
      await interaction.reply(interactionPayload("請在主機本機執行 `umiro onbord` 完成 Discord owner 設定。", { ephemeral: true }));
      return;
    }

    const pluginOwnerOnly = BUILTIN_SLASH_COMMAND_NAMES.has(interaction.commandName)
      ? undefined
      : isPluginSlashCommandOwnerOnly(interaction.commandName);
    if (pluginOwnerOnly !== undefined) {
      if (pluginOwnerOnly && interaction.user.id !== loadConfig().discord.owner_id) {
        await interaction.reply(interactionPayload(OWNER_ONLY_MSG, { ephemeral: true }));
        return;
      }
      const registration = getPluginSlashCommands().find(command => command.name === interaction.commandName);
      if (!registration) {
        await interaction.reply(interactionPayload("外掛指令目前不可用", { ephemeral: true }));
        return;
      }
      const args = Object.fromEntries(
        interaction.options.data.map(option => [option.name, option.value as string | number | boolean | undefined]),
      );
      if (registration.ephemeral === false) await interaction.deferReply();
      else await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      try {
        const result = await executePluginSlashCommand(interaction.commandName, args, {
          userId: interaction.user.id,
          channelId: interaction.channelId,
          ...(interaction.guildId ? { guildId: interaction.guildId } : {}),
        });
        if (!result) throw new Error("外掛指令目前不可用");
        const text = truncateInteractionReply(fixMarkdownLinks(resolveEmojiMarkup(result.content)));
        await interaction.editReply(editPayload(text));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error({ err, command: interaction.commandName, user: interaction.user.id }, "plugin slash command failed");
        await interaction.editReply(editPayload(`外掛指令失敗：${msg}`));
      }
      return;
    }

    if (interaction.commandName === "new") {
      const config = loadConfig();
      if (isWorkspaceUnconfigured() && interaction.user.id !== config.discord.owner_id) {
        await interaction.reply(interactionPayload("首次設定尚未完成，只有已設定的 owner 能重開 onboarding session。", { ephemeral: true }));
        return;
      }
      const sessionId = interaction.guild
        ? `discord-channel-${interaction.channelId}`
        : `discord-dm-${interaction.user.id}`;

      // Defer before waiting behind an in-flight reply so the interaction token
      // remains valid, then mutate/archive the session inside the same FIFO queue.
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await discordSessionQueue.enqueue(sessionId, async () => {
        const peopleVisibility = discordPeopleVisibility(interaction.user.id, config.discord.owner_id);
        const trigger = peopleVisibility === "owner" ? "discord-owner" : "discord-other";
        const session = new Session(sessionId);
        const channelContext = buildChannelContext(interaction.channelId, sessionId, getChannelTypeInfo(interaction.channel));
        const ts = stamp();

        // 歸檔前：silent memory flush — 讓 agent 自由整理記憶
        if (session.length > 0) {
          const flushContext = `${channelContext}\n\n[System] ${SESSION_SUMMARIZE_PROMPT}`;
          session.append({ role: "user", content: "[System] Session ending — flush memory now.", time: ts });
          await ask(null, { session, systemPrompt: flushContext, trigger, userId: interaction.user.id, peopleVisibility }).catch(err =>
            logger.error({ err: (err as Error).message }, "memory flush before /new failed")
          );
        }

        session.archive();
        logger.info({ sessionId }, "session archived via /new");

        if (shouldOnboard(session.getMessages())) {
          session.append({
            role: "user",
            content: buildOnboardingContext(interaction.user.id, interaction.user.username),
            time: ts,
            isOnboarding: true,
          });
        }
        const newSessionContent = `[System] <@${interaction.user.id}>(${interaction.user.username}) started a new session via /new. Follow the Session Initialization steps in your instructions (MEMORY.md and PEOPLE.md are already in your prompt — read only the recent daily memory), then greet them in character.`;
        session.append({ role: "user", content: newSessionContent, time: ts });

        try {
          const response = await ask(null, { session, systemPrompt: channelContext, trigger, userId: interaction.user.id, peopleVisibility });
          const text = response.text || "（新對話開始）";
          const formatted = fixMarkdownLinks(resolveEmojiMarkup(text));
          const chunks = chunkMessage(formatted, 2000);
          await interaction.editReply(editPayload(chunks[0]));
          for (let i = 1; i < chunks.length; i++) {
            await interaction.followUp(interactionPayload(chunks[i], { ephemeral: true }));
          }
        } catch (err) {
          logger.error({ err: (err as Error).message }, "/new failed");
          await interaction.deleteReply().catch(() => {});
        }
      }).catch(err => {
        logger.error({ err, sessionId }, "queued /new handling failed");
      });
    }

    if (interaction.commandName === "stop") {
      const config = loadConfig();
      const sessionId = interaction.guild
        ? `discord-channel-${interaction.channelId}`
        : `discord-dm-${interaction.user.id}`;
      const result = activeRuns.requestStop(sessionId, interaction.user.id, config.discord.owner_id);
      const text = result === "stopping" ? "已要求停止；目前的模型請求會立即取消，工具若已開始則會在安全邊界停下。"
        : result === "already-stopping" ? "這個 session 已經在停止中了。"
        : result === "forbidden" ? "只有目前工作的觸發者或 owner 能停止它。"
        : "這個 session 現在沒有執行中的工作。";
      await interaction.reply(interactionPayload(text, { ephemeral: true }));
    }

    if (interaction.commandName === "queue") {
      const config = loadConfig();
      const sessionId = interaction.guild
        ? `discord-channel-${interaction.channelId}`
        : `discord-dm-${interaction.user.id}`;
      const mode = interaction.options.getString("mode", true);
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await discordSessionQueue.enqueue(sessionId, async () => {
        const session = new Session(sessionId);
        session.setQueueModeOverride(mode === "reset" ? undefined : mode as DiscordQueueMode);
        const effective = effectiveQueueMode(session, config);
        await interaction.editReply(editPayload(`Queue mode：\`${effective.mode}\`（${effective.source === "session" ? "session override" : "global default"}）`));
      });
    }

    if (interaction.commandName === "status") {
      const config = loadConfig();
      const sessionId = interaction.guild
        ? `discord-channel-${interaction.channelId}`
        : `discord-dm-${interaction.user.id}`;
      const session = new Session(sessionId);
      const usage = session.getUsage();
      const sessionProfile = sessionLlmProfile(config, session.getModelSettings());
      const crons = loadCrons();
      const reminders = loadReminders();
      const activeSessions = Session.listActive();
      const skills = config.skills;
      const pluginStatus = getPluginRuntimeStatus();
      const queueMode = effectiveQueueMode(session, config);
      const activeRun = activeRuns.snapshot(sessionId);

      const totalTokens = usage.inputTokens + usage.outputTokens;
      const embed = new EmbedBuilder()
        .setTitle("Umiro Status")
        .setColor(0x5865f2)
        .addFields(
          { name: "Model", value: `\`${sessionProfile.model}\``, inline: true },
          { name: "Reasoning", value: `\`${sessionProfile.reasoningEffort}\``, inline: true },
          { name: "Queue Mode", value: `\`${queueMode.mode}\` (${queueMode.source})`, inline: true },
          { name: "Current Run", value: activeRun ? (activeRun.stopRequested ? "stopping" : `running · ${activeRun.pendingInputs} pending steer`) : "idle", inline: true },
          { name: "Tokens", value: `${totalTokens.toLocaleString()} (in: ${usage.inputTokens.toLocaleString()} / out: ${usage.outputTokens.toLocaleString()})`, inline: false },
          { name: "Active Sessions", value: `${activeSessions.length}`, inline: true },
          { name: "Crons", value: `${crons.filter(c => c.enabled).length} active / ${crons.length} total`, inline: true },
          { name: "Reminders", value: `${reminders.length} pending`, inline: true },
          { name: "Plugin Jobs", value: `${pluginStatus.activeSchedules} scheduled / ${pluginStatus.runningJobs} running`, inline: true },
          { name: "Plugins", value: pluginStatus.plugins.length > 0
            ? pluginStatus.plugins.map(p => `${p.name} (${p.state})`).join(", ")
            : "none", inline: false },
          { name: "Skills", value: skills.length > 0 ? skills.join(", ") : "none", inline: false },
        )
        .setTimestamp();

      await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }

    if (interaction.commandName === "restart") {
      const config = loadConfig();
      if (config.discord.owner_id && interaction.user.id !== config.discord.owner_id) {
        await interaction.reply(interactionPayload(OWNER_ONLY_MSG, { ephemeral: true }));
        return;
      }
      logger.info({ user: interaction.user.id }, "/restart triggered");
      await interaction.reply(interactionPayload("Restarting... wait for me!", { ephemeral: true }));
      try {
        await savePendingRestart(interaction.applicationId, interaction.token);
      } catch (err) {
        logger.error({ err: (err as Error).message }, "failed to save pending restart state");
        await interaction.editReply(editPayload("重啟取消：無法保存重啟狀態。"));
        return;
      }
      selfRestart();
    }

    if (interaction.commandName === "model") {
      const config = loadConfig();
      if (config.discord.owner_id && interaction.user.id !== config.discord.owner_id) {
        await interaction.reply(interactionPayload(OWNER_ONLY_MSG, { ephemeral: true }));
        return;
      }
      const sessionId = interaction.guild
        ? `discord-channel-${interaction.channelId}`
        : `discord-dm-${interaction.user.id}`;
      const name = interaction.options.getString("name", true);
      const effort = (interaction.options.getString("effort") ?? "default") as ReasoningEffort;
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await discordSessionQueue.enqueue(sessionId, async () => {
        const session = new Session(sessionId);
        const previous = session.getModelSettings();
        session.setModelSettings(name, effort);
        logger.info({ sessionId, profile: previous.profile, prev: previous.model, next: name, prevEffort: previous.reasoningEffort, effort, user: interaction.user.id }, "/model switched for session");
        await interaction.editReply(editPayload(
          `這個 session 的模型已切換：\`${previous.model} (${previous.reasoningEffort})\` → \`${name} (${effort})\``,
        ));
      }).catch(async err => {
        logger.error({ err, sessionId }, "queued /model handling failed");
        await interaction.editReply(editPayload("模型切換失敗，請查看日誌。")).catch(() => {});
      });
    }

    if (interaction.commandName === "google-auth") {
      const config = loadConfig();
      if (config.discord.owner_id && interaction.user.id !== config.discord.owner_id) {
        await interaction.reply(interactionPayload(OWNER_ONLY_MSG, { ephemeral: true }));
        return;
      }
      const callback = interaction.options.getString("callback");
      if (!callback) {
        const authed = getAuthClient();
        if (authed) {
          await interaction.reply(interactionPayload("Google API 已經授權過了。", { ephemeral: true }));
          return;
        }
        const url = getAuthUrl();
        if (!url) {
          await interaction.reply(interactionPayload("請先在 .env 設定 GOOGLE_CLIENT_ID 和 GOOGLE_CLIENT_SECRET 後重啟。", { ephemeral: true }));
          return;
        }
        await interaction.reply(interactionPayload(
          `點這個連結授權：\n${url}\n\n授權後瀏覽器會跳到 \`http://localhost?code=xxx\`，把整個網址貼回來：\n\`/google-auth callback:<貼上整個網址>\``,
          { ephemeral: true },
        ));
      } else {
        try {
          await exchangeCode(callback);
          await interaction.reply(interactionPayload("Google API 授權成功！", { ephemeral: true }));
          logger.info({ user: interaction.user.id }, "google oauth completed via /google-auth");
        } catch (err) {
          await interaction.reply(interactionPayload(`授權失敗：${(err as Error).message}`, { ephemeral: true }));
        }
      }
    }

    if (interaction.commandName === "task") {
      const auth = getAuthClient();
      if (!auth) {
        await interaction.reply(interactionPayload("Google API 未授權，請先用 /google-auth 授權。", { ephemeral: true }));
        return;
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      try {
        const tasks = google.tasks({ version: "v1", auth });
        const res = await tasks.tasks.list({
          tasklist: "@default",
          maxResults: 20,
          showCompleted: false,
          showHidden: false,
        });
        const items = res.data.items || [];
        if (items.length === 0) {
          await interaction.editReply(editPayload("沒有待辦事項 🎉"));
          return;
        }
        const lines = items.map(t => {
          const due = t.due ? ` (${t.due.split("T")[0]})` : "";
          return `• ${t.title}${due}`;
        });
        const embed = new EmbedBuilder()
          .setTitle("Google Tasks")
          .setDescription(lines.join("\n"))
          .setTimestamp();
        await interaction.editReply({ embeds: [embed] });
      } catch (err) {
        await interaction.editReply(editPayload(`取得 Tasks 失敗：${(err as Error).message}`));
      }
    }

    if (interaction.commandName === "compact") {
      const sessionId = interaction.guild
        ? `discord-channel-${interaction.channelId}`
        : `discord-dm-${interaction.user.id}`;
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await discordSessionQueue.enqueue(sessionId, async () => {
        const session = new Session(sessionId);
        if (session.length === 0) {
          await interaction.editReply(editPayload("Session 是空的，不需要壓縮。"));
          return;
        }
        const summary = await compactSession(session);
        if (summary) {
          await interaction.editReply(editPayload(`Session 已壓縮（${session.length} 則訊息保留）。`));
        } else {
          await interaction.editReply(editPayload("Session 太短，不需要壓縮。"));
        }
      }).catch(async err => {
        logger.error({ err, sessionId }, "queued /compact handling failed");
        await interaction.editReply(editPayload("Session 壓縮失敗，請查看日誌。")).catch(() => {});
      });
    }

    if (interaction.commandName === "plugin") {
      const config = loadConfig();
      if (interaction.user.id !== config.discord.owner_id) {
        await interaction.reply(interactionPayload(OWNER_ONLY_MSG, { ephemeral: true }));
        return;
      }

      const action = interaction.options.getString("action", true);
      const target = interaction.options.getString("target")?.trim() || undefined;
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      try {
        if (action === "install") {
          if (!target) throw new Error("請在「目標」貼上 GitHub repository 或 package 網址");
          const source = await parseGitHubPluginSource(target);
          const result = await installPlugin(source.repository, { workspace: source.workspace, ref: source.ref });
          logger.info({ operation: "install", user: interaction.user.id }, "/plugin interaction completed");
          await interaction.editReply(editPayload(truncateInteractionReply(result)));
          return;
        }

        if (action === "update") {
          if (target && !listManagedPluginNames().includes(target)) {
            throw new Error(`Managed plugin ${target} is not installed`);
          }
          const result = await updatePlugins(target);
          logger.info({ operation: "update", plugin: target, user: interaction.user.id }, "/plugin interaction completed");
          await interaction.editReply(editPayload(truncateInteractionReply(result)));
          return;
        }

        if (action !== "remove") throw new Error("未知的外掛操作");
        if (!target) throw new Error("請在「目標」選擇要卸載的外掛");
        if (!listManagedPluginNames().includes(target)) {
          throw new Error(`Managed plugin ${target} is not installed`);
        }
        const result = removeManagedPlugin(target);
        logger.info({ operation: "remove", plugin: target, user: interaction.user.id }, "/plugin interaction completed");
        await interaction.editReply(editPayload(truncateInteractionReply(result)));
      } catch (err) {
        const message = (err as Error).message;
        logger.error({ err, operation: action, user: interaction.user.id }, "/plugin interaction failed");
        const label = action === "install" ? "外掛安裝失敗" : action === "update" ? "外掛更新失敗" : "外掛卸載失敗";
        await interaction.editReply(editPayload(truncateInteractionReply(`${label}：${message}`)));
      }
    }
  });

  client.on(Events.MessageCreate, async (message) => {
    if (!acceptingTraffic) return;
    // 自己的訊息不處理
    if (message.author.id === client.user?.id) return;

    const config = loadConfig();

    // 完全忽略的頻道 / thread：在任何觸發判定、session 建立或記錄之前最早期放棄。
    // 命中時即使訊息 @ bot、reply bot、來自 DM，或該頻道之後被列入 ambient，也一律不觸發
    // 也不記錄。只精確比對 channel/thread ID 本身，thread 不繼承 parent。
    if (isIgnoredChannel(message.channelId, config)) return;

    const sessionId = sessionIdForMessage(message);
    const isMentioned = client.user ? message.mentions.has(client.user) : false;
    const isDM = !message.guild;
    const isBot = message.author.bot;
    // ambient 頻道：不需 @ 即觸發。只比對 channel ID 本身，thread 不繼承 parent
    const isAmbient = !isDM && config.discord.ambient_channels.includes(message.channelId);
    const isTrigger = (isMentioned || isDM || isAmbient) && (!isBot || config.discord.respond_to_bots);

    // A fresh gateway accepts no ordinary Discord traffic until the installer
    // has configured owner_id locally. This happens before session creation, so
    // strangers cannot poison a future owner session.
    if (!config.discord.owner_id) {
      if (isTrigger) logger.info({ userId: message.author.id, sessionId }, "message ignored while fresh-install setup is pending");
      return;
    }

    // DM 只回 owner
    if (isDM && message.author.id !== config.discord.owner_id) {
      logger.info({ userId: message.author.id }, "DM from non-owner rejected");
      return;
    }
    // owner 一律不受白名單限制——白名單是用來擋別人的，不是擋自己
    if (message.author.id !== config.discord.owner_id) {
      if (message.guild && config.discord.allowed_guilds.length > 0
          && !config.discord.allowed_guilds.includes(message.guild.id)) return;
      if (!isDM && !isAmbient && config.discord.allowed_channels.length > 0
          && !config.discord.allowed_channels.includes(message.channelId)) return;
    }

    // （只有 bot 被 @mention / reply / DM 後才會開啟這個 channel 的 session；
    //   之後該 channel 的所有訊息才會納入記錄，作為 reply chain 的上下文）
    // A context message arriving behind a queued trigger must not be dropped merely
    // because that trigger has not created the session file yet.
    if (!isTrigger && !Session.exists(sessionId) && !discordSessionQueue.has(sessionId)) return;

    // Steer bypasses the serial queue only for a trigger by the same verified author.
    // It is formatted here but persisted by the active agent at the next turn boundary.
    if (isTrigger && activeRuns.has(sessionId)) {
      const probe = new Session(sessionId);
      if (effectiveQueueMode(probe, config).mode === "steer") {
        const fmt = await formatIncomingMessage(message, sessionId);
        const accepted = activeRuns.steer(sessionId, message.author.id, {
          message: {
            role: "user", content: fmt.content, time: fmt.time, msgId: fmt.msgId,
            ...(fmt.replyTo ? { replyTo: fmt.replyTo } : {}),
            ...(fmt.attachments?.length ? { attachments: fmt.attachments } : {}),
          },
          images: fmt.images,
          files: fmt.files,
          order: message.id,
        });
        if (accepted) {
          logger.info({ sessionId, messageId: message.id }, "Discord trigger steered into active run");
          return;
        }
      }
    }

    await discordSessionQueue.enqueue(sessionId, async () => {
      const session = new Session(sessionId);
      // 檔名帶上頻道名，方便在 sessions/ 裡辨識；頻道改名會自動 rename
      const channelName = (message.channel as { name?: string }).name;
      if (channelName) session.setChannelName(channelName);

      // Setup context remains resumable until OWNER.md is completed.
      const needsOnboarding = isTrigger && shouldOnboard(session.getMessages());

      // Thread/論壇貼文的第一次進入：抓初始訊息作為 context
      if (session.length === 0 && message.channel.isThread()) {
        try {
          const starter = await message.channel.fetchStarterMessage();
          if (starter) {
            const ts = stamp(new Date(starter.createdTimestamp));
            const authorName = formatName(starter.author.username, starter.member?.displayName);
            const threadName = message.channel.name;
            let starterAttachments: AttachmentReference[] = [];
            try {
              starterAttachments = prepareRemoteAttachmentReferences(
                sessionId,
                starter.id,
                extractMessageAttachments(starter).map(item => ({ ...item, relation: "upload" as const })),
              );
            } catch (error) {
              logger.error({ err: error, sessionId, messageId: starter.id }, "forum starter attachment reference preparation failed");
            }
            session.append({
              role: "user",
              content: `[System] This is the initial message of forum post "${threadName}" (by ${authorName}) [thread_id: ${message.channelId}]:\n${extractMessageText(starter)}`,
              time: ts,
              msgId: starter.id,
              ...(starterAttachments.length > 0 ? { attachments: starterAttachments } : {}),
            });
          }
        } catch { /* starter message not available */ }
      }

      // Inject one-time onboarding context before the user's actual message
      if (needsOnboarding) {
        const onboardingCtx = buildOnboardingContext(
          message.author.id,
          message.author.username,
          message.member?.displayName,
        );
        session.append({ role: "user", content: onboardingCtx, time: stamp(), isOnboarding: true });
        logger.info({ sessionId, userId: message.author.id }, "onboarding context injected");
      }

      const fmt = await formatIncomingMessage(message, sessionId);
      const content = isTrigger ? fmt.content : `[context] ${fmt.content}`;
      session.append({
        role: "user", content, time: fmt.time, msgId: fmt.msgId,
        ...(fmt.replyTo ? { replyTo: fmt.replyTo } : {}),
        ...(fmt.attachments?.length ? { attachments: fmt.attachments } : {}),
      });

      if (!isTrigger) return;

      await handleTrigger(message, session, fmt.images, fmt.files);
    }).catch(async err => {
      logger.error({ err, sessionId, messageId: message.id }, "queued Discord message handling failed before agent delivery");
      if (isTrigger) {
        try {
          await message.reply(messagePayload("這則訊息無法保存，因此沒有啟動處理。請稍後再試一次。"));
        } catch {
          await message.react("🤕").catch(() => {});
        }
      }
    });
  });

  await client.login(token);
  await readyInitialization;
}

interface FormattedMessage {
  content: string;
  time: string;
  msgId: string;
  replyTo?: string;
  images?: string[];
  files?: Array<{ url: string; name: string; contentType: string; size?: number }>;
  attachments?: AttachmentReference[];
}

async function formatIncomingMessage(message: Message, sessionId: string): Promise<FormattedMessage> {
  const authorName = formatName(message.author.username, message.member?.displayName);
  const authorId = message.author.id;

  const ts = stamp(new Date(message.createdTimestamp));
  const content = await normalizeMentions(extractMessageText(message), message.client, message.guild);
  const attachments = extractMessageAttachments(message);
  const attach = attachments.length > 0
    ? ` [附件: ${attachments.map(item => item.url).join(", ")}]`
    : "";

  const imageExts = [".png", ".jpg", ".jpeg", ".gif", ".webp"];
  const isImage = (attachment: { url: string; contentType?: string; name?: string }) =>
    attachment.contentType?.startsWith("image/")
    || imageExts.some(extension => (attachment.name || new URL(attachment.url).pathname).toLowerCase().endsWith(extension));

  // Bound the rendition here, where Discord's reported dimensions are still available:
  // downstream only carries URLs, and image tokens scale with the pixels actually sent.
  const toModelImageUrl = (attachment: ExtractedMessageAttachment): string =>
    boundedImageUrl(attachment.url, attachment.width, attachment.height);
  const images = attachments.filter(isImage).map(toModelImageUrl);
  const isPdf = (attachment: { url: string; contentType?: string; name?: string }) =>
    attachment.contentType?.split(";")[0].trim().toLowerCase() === "application/pdf"
    || (attachment.name || new URL(attachment.url).pathname).toLowerCase().endsWith(".pdf");
  const toModelFile = (attachment: ExtractedMessageAttachment) => ({
    url: attachment.url,
    name: attachment.name || "document.pdf",
    contentType: "application/pdf",
    ...(typeof attachment.size === "number" ? { size: attachment.size } : {}),
  });
  const files = attachments.filter(isPdf).map(toModelFile);
  const indexInputs: RemoteAttachmentInput[] = attachments.map(item => ({ ...item, relation: "upload" }));

  // reply 的訊息如果有圖片，也加進來；另保留 reference metadata，
  // 即使原訊息不在目前 session，日後仍能追溯這次對話看過哪張圖。
  if (message.reference?.messageId) {
    try {
      const replied = await message.channel.messages.fetch(message.reference.messageId);
      const replyAttachments = extractMessageAttachments(replied);
      images.push(...replyAttachments.filter(isImage).map(toModelImageUrl));
      files.push(...replyAttachments.filter(isPdf).map(toModelFile));
      indexInputs.push(...replyAttachments.map(item => ({ ...item, relation: "reply_reference" as const })));
    } catch { /* replied message not available */ }
  }

  let attachmentReferences: AttachmentReference[] = [];
  try {
    attachmentReferences = prepareRemoteAttachmentReferences(sessionId, message.id, indexInputs);
  } catch (error) {
    logger.error({ err: error, sessionId, messageId: message.id }, "Discord attachment reference preparation failed");
  }

  return {
    content: `[msg:${message.id} ${ts}] <@${authorId}>(${authorName}):${message.reference?.messageId ? ` (reply to msg:${message.reference.messageId})` : ""} ${content}${attach}`,
    time: ts,
    msgId: message.id,
    ...(message.reference?.messageId ? { replyTo: message.reference.messageId } : {}),
    ...(images.length > 0 ? { images: [...new Set(images)] } : {}),
    ...(files.length > 0 ? { files: [...new Map(files.map(file => [file.url, file])).values()] } : {}),
    ...(attachmentReferences.length > 0 ? { attachments: attachmentReferences } : {}),
  };
}

// --- Tool activity message editing ---

const INTERIM_TEXT_LIMIT = 300;

/** A temporary Discord activity line. Tool names and arguments are deliberately absent. */
export type ProgressLine =
  | { kind: "activity"; id: string; text: string; failed?: boolean }
  | { kind: "text"; text: string };

export async function deliverFinalDiscordReply(
  source: Pick<Message, "reply">,
  payload: ReturnType<typeof messagePayload>,
  activity?: Pick<Message, "delete">,
): Promise<Pick<Message, "id">> {
  // Do not delete the temporary activity UI until Discord has acknowledged a new
  // canonical message. If sending fails, the caller receives the error and the
  // activity remains visible as evidence that the run did not vanish silently.
  const sent = await source.reply(payload);
  if (activity) {
    await activity.delete().catch(deleteErr =>
      logger.warn({ err: deleteErr }, "failed to delete temporary tool activity message after final delivery")
    );
  }
  return sent;
}

export function renderProgress(lines: ProgressLine[]): string {
  const line = lines.at(-1);
  if (!line) return "✨ Working on it...";
  const body = line.kind === "text"
    ? `> ${line.text.replace(/\n+/g, "\n> ")}`
    : `${line.failed ? "✗ " : ""}${line.text}`;
  return body.length > 1900 ? body.slice(-1900) : body;
}

// 靜默哨符判定集中在 utils/no-reply.ts，一般對話與排程共用同一套語意。
// 這裡 re-export，讓既有的 import path（含測試）維持不變。
export { isNoReplySentinel };

/**
 * Persist descriptions the reply produced for this turn's images.
 *
 * The image attachments of the newest user message are matched positionally against the
 * numbered block, because that is the order they were uploaded in. Anything missing is left
 * untouched so the background vision worker still picks it up.
 */
function storeInlineImageDescriptions(session: Session, text: string, imageCount: number): void {
  try {
    const descriptions = parseImageIndexBlock(text, imageCount);
    if (descriptions.every(value => !value)) return;
    const messages = session.getMessages();
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index];
      if (message.role !== "user") continue;
      const imageRefs = (message.attachments ?? []).filter(
        reference => reference.contentType?.startsWith("image/"),
      );
      if (imageRefs.length === 0) return;
      const applied = applyInlineImageDescriptions(
        imageRefs.slice(0, descriptions.length).map((reference, position) => ({
          id: reference.id,
          description: descriptions[position] ?? "",
        })),
      );
      if (applied > 0) logger.info({ sessionId: session.id, applied }, "inline image descriptions stored");
      return;
    }
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "inline image description storage failed");
  }
}

async function handleTrigger(
  message: Message,
  session: Session,
  images?: string[],
  files?: Array<{ url: string; name: string; contentType: string; size?: number }>,
): Promise<void> {
  logger.info({
    sessionId: session.id,
    author: message.author.tag,
    content: message.content.slice(0, 200),
  }, "discord trigger");

  const channel = message.channel;

  // 持續 typing indicator
  const typingInterval = setInterval(() => {
    if ("sendTyping" in channel) {
      (channel as { sendTyping: () => Promise<void> }).sendTyping().catch(() => {});
    }
  }, 8000);
  if ("sendTyping" in channel) {
    await (channel as { sendTyping: () => Promise<void> }).sendTyping().catch(() => {});
  }

  // 進度訊息狀態
  let progressMsg: Message | undefined;
  const progressLines: ProgressLine[] = [];
  const toolActivityConfig = loadConfig().discord.tool_activity;
  let activityPools;
  try {
    activityPools = loadToolActivityPools({
      inline: toolActivityConfig.pools,
      file: toolActivityConfig.pools_file,
      mode: toolActivityConfig.mode,
      root: ROOT,
    });
  } catch (err) {
    logger.error({ err }, "tool activity pools file could not be loaded; using inline/default pools");
    activityPools = mergeToolActivityPools(toolActivityConfig.pools, toolActivityConfig.mode);
  }
  const activityPicker = new ToolActivityPicker(activityPools);
  let flushChain: Promise<void> = Promise.resolve();
  const flushProgress = async (body: string) => {
    try {
      if (!progressMsg) {
        progressMsg = await message.reply(messagePayload(body));
      } else {
        await progressMsg.edit(editPayload(body));
      }
    } catch {
      // 編輯失敗不影響，最終回覆才是權威
    }
  };

  const onProgress = (event: ProgressEvent) => {
    if (!toolActivityConfig.enabled) return;
    if (event.type === "tool_start") {
      progressLines.push({ kind: "activity", id: event.toolCallId, text: activityPicker.pick(event.toolName) });
    } else if (event.type === "text") {
      const text = event.text.length > INTERIM_TEXT_LIMIT
        ? `${event.text.slice(0, INTERIM_TEXT_LIMIT)}…`
        : event.text;
      const visible = stripImageIndexBlock(text);
      if (visible.trim()) progressLines.push({ kind: "text", text: visible });
    } else {
      const line = progressLines.find(l => l.kind === "activity" && l.id === event.toolCallId);
      if (line?.kind === "activity") line.failed = event.isError;
      // Successful completion leaves the current status alone. A failure refreshes
      // only when that tool is still the newest visible activity.
      if (!event.isError || line !== progressLines.at(-1)) return;
    }
    // Capture this event's status before later events mutate the in-memory list,
    // then serialize Discord edits without delaying the underlying tool flow.
    const body = renderProgress(progressLines);
    flushChain = flushChain.then(() => flushProgress(body));
  };

  const run = activeRuns.start(session.id, message.author.id);
  try {
    const baseContext = buildChannelContext(message.channelId, session.id, getChannelTypeInfo(channel));
    // Describe images in the same turn that already uploaded them; the background vision
    // worker stays as the fallback for anything this does not produce.
    const imageCount = images?.length ?? 0;
    const channelContext = imageCount > 0
      ? `${baseContext}\n\n${imageIndexInstruction(imageCount)}`
      : baseContext;
    const ownerId = loadConfig().discord.owner_id;
    const peopleVisibility = discordPeopleVisibility(message.author.id, ownerId);
    const response = await ask(null, {
      session,
      systemPrompt: channelContext,
      images,
      files,
      onProgress,
      trigger: peopleVisibility === "owner" ? "discord-owner" : "discord-other",
      userId: message.author.id,
      peopleVisibility,
      runControl: {
        signal: run.controller.signal,
        isStopRequested: () => run.isStopRequested(),
        drainPendingInputs: () => run.drainPending(),
        drainPendingInputsOrSeal: () => run.drainPendingOrSeal(),
      },
    });
    if (imageCount > 0 && response.text) {
      storeInlineImageDescriptions(session, response.text, imageCount);
      response.text = stripImageIndexBlock(response.text);
    }
    await flushChain; // 確保進度訊息已發送完成
    logger.info({
      sessionId: session.id,
      textLength: response.text?.length ?? 0,
      textPreview: response.text?.slice(0, 200) ?? "(empty)",
      toolsUsed: response.toolsUsed.map(t => t.tool),
    }, "discord agent response");

    if (!response.text) {
      // 沒有文字回覆：刪掉進度訊息，加 emoji
      if (progressMsg) await progressMsg.delete().catch(() => {});
      await message.react("🤔").catch(() => {});
      return;
    }

    // 靜默哨符：模型最終文字整則就是 [no_reply]（trim + 大小寫不敏感）時，不送任何訊息。
    // 只在 Discord 最終輸出邊界攔截，不影響 session 記錄與 agent 執行流程。
    if (isNoReplySentinel(response.text)) {
      if (progressMsg) await progressMsg.delete().catch(() => {});
      logger.info({ sessionId: session.id }, "discord reply suppressed by [no_reply] sentinel");
      return;
    }

    // 若 AI 輸出 <@id>(帳號名｜暱稱) 格式，清掉括號讓 Discord 正常渲染 mention
    const stripped = response.text.replace(/(<@!?\d+>)[\(（][^\)）]*[\)）]/g, "$1");
    // 把 :name: 形式的 Application Emoji 引用解析成 Discord markup。
    // 在 chunk 前對整段文字做，才能正確跳過跨行的 code fence；名稱不存在則保留原文。
    const withEmojis = resolveEmojiMarkup(stripped);
    const formatted = fixMarkdownLinks(withEmojis);
    const chunks = chunkMessage(formatted, 2000);
    const sentIds: string[] = [];
    const attachments = response.attachments;

    // The activity message is temporary UI, never the canonical answer. Always create
    // a fresh Discord message for the final response so MESSAGE_CREATE-only consumers
    // receive the completed answer. Delete the activity message only after delivery.
    const firstMessagePayload = messagePayload(chunks[0], { files: attachments });
    const sent = await deliverFinalDiscordReply(message, firstMessagePayload, progressMsg);
    sentIds.push(sent.id);
    progressMsg = undefined;

    // 剩餘 chunks：用 reply 發新訊息
    for (let i = 1; i < chunks.length; i++) {
      const sent = await message.reply(messagePayload(chunks[i]));
      sentIds.push(sent.id);
    }

    if (sentIds.length > 0) {
      try {
        session.setLastAssistantMsgId(sentIds.join(","));
      } catch (err) {
        // The Discord reply is already visible. Transport metadata persistence is
        // best-effort and must never delete or suppress the delivered answer.
        logger.error({ err, sessionId: session.id, sentIds }, "assistant Discord message ID persistence failed after delivery");
      }
    }
    logger.info({ sessionId: session.id, chunks: chunks.length, sentIds }, "discord reply sent");
  } catch (err) {
    if (err instanceof RunStoppedError || run.isStopRequested()) {
      logger.info({ sessionId: session.id }, "discord active run stopped");
      await flushChain;
      if (progressMsg) await progressMsg.delete().catch(() => {});
      await message.reply(messagePayload("已停止。"));
    } else {
      logger.error({ err }, "discord handle trigger failed");
      if (progressMsg) await progressMsg.delete().catch(() => {});
      await message.react("🤕").catch(() => {});
    }
  } finally {
    activeRuns.finish(run);
    clearInterval(typingInterval);
  }
}
