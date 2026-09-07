import type { Tool } from "../types.js";
import { logger } from "../logger.js";
import { loadConfig } from "../config.js";
export { setTrigger, getTrigger } from "./context.js";
import { getTrigger, getUserId, getRequestProfile } from "./context.js";
import { isTrustedForOwnerActions } from "./authz.js";
import type { ToolRegistration, ExposureLevel } from "./metadata.js";
import {
  GROUP_LABELS, normalizeForMatch, detectSignals, matchTools,
} from "./metadata.js";
import { createToolCatalog } from "./builtin/tool-catalog.js";
import type { PluginToolRegistration } from "./plugin-types.js";
import { TOOL_INTENTS, intentKeywords } from "./intents.js";

const OWNER_ONLY_TOOLS = new Set([
  // write_file 沒有路徑邊界，寫得進 src/ 就等於繞過 bash 的 owner-only。
  // 非 owner 也沒有寫任意檔案的正當理由——記人記事走 people_* / memory_*，
  // 那些工具的落點寫死在 paths.ts。read_file 刻意不列在這裡：整個擋掉會讓
  // 陌生人一互動就讀不到當天 daily memory 與 skill，改由 guard.ts 擋路徑。
  "write_file",
  "memory_replace", "memory_remove",
  // people_add / people_update 刻意不列 owner-only：agent 要能在非 owner 講話時
  // 記下對方是誰，鎖起來等於永遠記不了非 owner。真正的權限判定看 config.discord.owner_id，
  // 不是 PEOPLE.md，所以寫入這個檔案不會造成提權。刪除是破壞性的，維持 owner-only。
  "people_remove",
  "cron_create", "cron_delete", "cron_toggle", "cron_update",
  "reminder_create", "reminder_delete",
  "discord_send_message", "discord_send_buttons", "discord_pin", "discord_unpin",
  "discord_create_thread", "discord_create_forum_post", "discord_delete_thread",
  "discord_edit_message", "discord_delete_message", "discord_archive_thread",
  "google_calendar_list_events", "google_calendar_create_event", "google_calendar_update_event", "google_calendar_delete_event",
  "google_gmail_search", "google_gmail_read", "google_gmail_send", "google_gmail_create_draft",
  "google_drive_search", "google_drive_read", "google_drive_upload",
  "google_tasks_list", "google_tasks_create", "google_tasks_complete", "google_tasks_delete",
  "soul_guardian_approve", "soul_guardian_restore",
  "skill_install", "skill_uninstall",
  "discord_bot_mention_toggle",
  "usage_dashboard",
  "image_gen",
]);

import { bash } from "./builtin/bash.js";
import { readFileTool } from "./builtin/read-file.js";
import { writeFileTool } from "./builtin/write-file.js";
import { weather } from "./builtin/weather.js";
import { memorySearch, memoryList, memoryAdd, memoryReplace, memoryRemove } from "./builtin/memory.js";
import { peopleAdd, peopleUpdate, peopleRemove } from "./builtin/people.js";
import { cronCreate, cronList, cronDelete, cronToggle, cronUpdate } from "./builtin/cron.js";
import { reminderCreate, reminderList, reminderDelete } from "./builtin/reminder.js";
import {
  discordFetchMessage, discordSendMessage, discordSendButtons, discordReact, discordFetchChannelMessages,
  discordPin, discordUnpin,
  discordCreateThread, discordCreateForumPost, discordDeleteThread,
  discordEditMessage, discordDeleteMessage, discordAttachToReply, discordArchiveThread,
} from "./builtin/discord.js";
import { calendarListEvents, calendarCreateEvent, calendarUpdateEvent, calendarDeleteEvent } from "./builtin/google-calendar.js";
import { gmailSearch, gmailRead, gmailSend, gmailCreateDraft } from "./builtin/google-gmail.js";
import { driveSearch, driveRead, driveUpload } from "./builtin/google-drive.js";
import { tasksList, tasksCreate, tasksComplete, tasksDelete } from "./builtin/google-tasks.js";
import { soulGuardianStatus, soulGuardianCheck, soulGuardianApprove, soulGuardianRestore, soulGuardianHistory } from "./builtin/soul-guardian.js";
import { skillInstall, skillUninstall, skillList } from "./builtin/skill.js";
import { discordBotMentionToggle } from "./builtin/bot-config.js";
import { sessionSearch, sessionsByDate, journalTranscriptByDate } from "./builtin/session-search.js";
import { usageDashboard } from "./builtin/dashboard.js";
import { imageGen } from "./builtin/image-gen.js";
import { webFetch } from "./builtin/web-fetch.js";
import { codeExecutionUnavailable } from "./builtin/provider-capability.js";
import { webSearch } from "./builtin/web-search.js";
import type { LlmFunctionTool, LlmProfile } from "../llm/types.js";
import { activeLlmProfile, supportsCapability } from "../llm/profile.js";

/** Small helper to build a registration with defaults. */
function reg(
  tool: Tool,
  exposure: ExposureLevel,
  group: string,
  extra: Partial<Pick<ToolRegistration, "keywords" | "aliases" | "signals" | "capability" | "modelPredicate">> = {},
): ToolRegistration {
  return { tool, exposure, group, ...extra };
}

/**
 * The registry — single source of truth for tool classification. The `tool_catalog`
 * itself is appended below (always native); it is not listed here because its factory
 * needs a reference to this list.
 */
const baseRegistrations: ToolRegistration[] = [
  // ── native: always exposed ──
  reg(bash, "native", "filesystem-shell"),
  reg(readFileTool, "native", "filesystem-shell"),
  reg(writeFileTool, "native", "filesystem-shell"),
  reg(memorySearch, "native", "memory-people"),
  reg(peopleAdd, "native", "memory-people"),
  reg(peopleUpdate, "native", "memory-people"),
  reg(discordReact, "native", "discord-messages"),
  reg(discordAttachToReply, "native", "discord-messages"),
  reg(webFetch, "native", "web"),
  reg(webSearch, "native", "web", { capability: "hosted_web_search" }),
  reg(codeExecutionUnavailable, "native", "code-execution", { capability: "hosted_code_execution" }),

  // ── match: general & memory ──
  reg(weather, "match", "weather", { keywords: intentKeywords(TOOL_INTENTS.weather) }),
  reg(memoryList, "match", "memory-people", { keywords: intentKeywords(TOOL_INTENTS.memoryList) }),
  reg(memoryAdd, "match", "memory-people", { keywords: intentKeywords(TOOL_INTENTS.memoryAdd) }),
  reg(memoryReplace, "match", "memory-people", { keywords: intentKeywords(TOOL_INTENTS.memoryReplace) }),
  reg(memoryRemove, "match", "memory-people", { keywords: intentKeywords(TOOL_INTENTS.memoryRemove) }),
  reg(peopleRemove, "match", "memory-people", { keywords: intentKeywords(TOOL_INTENTS.peopleRemove) }),

  // ── match: schedules ──
  reg(cronCreate, "match", "schedules", { keywords: intentKeywords(TOOL_INTENTS.cronCreate, TOOL_INTENTS.cronBase), aliases: ["定期任務", "定时任务", "定期実行", "정기 작업"], signals: ["hasDateTime"] }),
  reg(cronList, "match", "schedules", { keywords: intentKeywords(TOOL_INTENTS.cronList, TOOL_INTENTS.cronBase) }),
  reg(cronDelete, "match", "schedules", { keywords: intentKeywords(TOOL_INTENTS.cronDelete) }),
  reg(cronToggle, "match", "schedules", { keywords: intentKeywords(TOOL_INTENTS.cronToggle) }),
  reg(cronUpdate, "match", "schedules", { keywords: intentKeywords(TOOL_INTENTS.cronUpdate) }),
  reg(reminderCreate, "match", "schedules", { keywords: intentKeywords(TOOL_INTENTS.reminderCreate), aliases: ["提醒我", "remind me", "リマインドして", "알림 설정"], signals: ["hasDateTime"] }),
  reg(reminderList, "match", "schedules", { keywords: intentKeywords(TOOL_INTENTS.reminderList) }),
  reg(reminderDelete, "match", "schedules", { keywords: intentKeywords(TOOL_INTENTS.reminderDelete) }),

  // ── match: discord messages ──
  reg(discordFetchMessage, "match", "discord-messages", { keywords: intentKeywords(TOOL_INTENTS.discordFetchMessage) }),
  reg(discordFetchChannelMessages, "match", "discord-messages", { keywords: intentKeywords(TOOL_INTENTS.discordFetchChannel) }),
  reg(discordSendMessage, "match", "discord-messages", { keywords: intentKeywords(TOOL_INTENTS.discordSendMessage) }),
  reg(discordSendButtons, "match", "discord-messages", { keywords: intentKeywords(TOOL_INTENTS.discordButtons) }),
  reg(discordPin, "match", "discord-messages", { keywords: intentKeywords(TOOL_INTENTS.discordPin) }),
  reg(discordUnpin, "match", "discord-messages", { keywords: intentKeywords(TOOL_INTENTS.discordUnpin) }),
  reg(discordCreateThread, "match", "discord-messages", { keywords: intentKeywords(TOOL_INTENTS.discordThread) }),
  reg(discordCreateForumPost, "match", "discord-messages", { keywords: intentKeywords(TOOL_INTENTS.discordForum) }),
  reg(discordEditMessage, "match", "discord-messages", { keywords: intentKeywords(TOOL_INTENTS.discordEdit) }),
  reg(discordArchiveThread, "match", "discord-messages", { keywords: intentKeywords(TOOL_INTENTS.discordArchive) }),

  // ── match: google calendar (non-delete) ──
  reg(calendarListEvents, "match", "google-calendar", { keywords: intentKeywords(TOOL_INTENTS.calendarList), signals: ["hasDateTime"] }),
  reg(calendarCreateEvent, "match", "google-calendar", { keywords: intentKeywords(TOOL_INTENTS.calendarCreate) }),
  reg(calendarUpdateEvent, "match", "google-calendar", { keywords: intentKeywords(TOOL_INTENTS.calendarUpdate) }),

  // ── match: gmail (non-delete) ──
  reg(gmailSearch, "match", "google-gmail", { keywords: intentKeywords(TOOL_INTENTS.gmailSearch) }),
  reg(gmailRead, "match", "google-gmail", { keywords: intentKeywords(TOOL_INTENTS.gmailRead) }),
  reg(gmailSend, "match", "google-gmail", { keywords: intentKeywords(TOOL_INTENTS.gmailSend) }),
  reg(gmailCreateDraft, "match", "google-gmail", { keywords: intentKeywords(TOOL_INTENTS.gmailDraft) }),

  // ── match: google drive ──
  reg(driveSearch, "match", "google-drive", { keywords: intentKeywords(TOOL_INTENTS.driveSearch) }),
  reg(driveRead, "match", "google-drive", { keywords: intentKeywords(TOOL_INTENTS.driveRead) }),
  reg(driveUpload, "match", "google-drive", { keywords: intentKeywords(TOOL_INTENTS.driveUpload) }),

  // ── match: google tasks ──
  reg(tasksList, "match", "google-tasks", { keywords: intentKeywords(TOOL_INTENTS.tasksList) }),
  reg(tasksCreate, "match", "google-tasks", { keywords: intentKeywords(TOOL_INTENTS.tasksCreate) }),
  reg(tasksComplete, "match", "google-tasks", { keywords: intentKeywords(TOOL_INTENTS.tasksComplete) }),

  // ── match: other explicit-intent ──
  reg(imageGen, "match", "image-generation", { capability: "hosted_image_generation", keywords: intentKeywords(TOOL_INTENTS.imageGeneration), signals: ["hasImageEditRequest"] }),
  reg(sessionSearch, "match", "history-journal", { keywords: intentKeywords(TOOL_INTENTS.sessionSearch) }),
  reg(skillList, "match", "skills", { keywords: intentKeywords(TOOL_INTENTS.skillList) }),
  reg(usageDashboard, "match", "usage", { keywords: intentKeywords(TOOL_INTENTS.usage) }),

  // ── index: known-but-not-schema ──
  reg(sessionsByDate, "index", "history-journal"),
  reg(journalTranscriptByDate, "index", "history-journal"),
  reg(soulGuardianStatus, "index", "integrity"),
  reg(soulGuardianCheck, "index", "integrity"),
  reg(soulGuardianHistory, "index", "integrity"),
  reg(discordBotMentionToggle, "index", "discord-admin"),

  // ── on-demand: rare / destructive / irreversible ──
  reg(discordDeleteThread, "on-demand", "discord-admin"),
  reg(discordDeleteMessage, "on-demand", "discord-admin"),
  reg(calendarDeleteEvent, "on-demand", "google-calendar"),
  reg(tasksDelete, "on-demand", "google-tasks"),
  reg(soulGuardianApprove, "on-demand", "integrity"),
  reg(soulGuardianRestore, "on-demand", "integrity"),
  reg(skillInstall, "on-demand", "skills"),
  reg(skillUninstall, "on-demand", "skills"),
];

const CATALOG_NAME = "tool_catalog";

// tool_catalog is always native and is the unified discovery/proxy entry point.
// Injection avoids a circular import: the catalog factory receives executeTool and
// the registration list rather than importing this module.
const toolCatalog = createToolCatalog({
  listRegistrations: () => allRegistrations(),
  executeTool: (name, args) => executeTool(name, args),
  catalogName: CATALOG_NAME,
});

const registrations: ToolRegistration[] = [
  reg(toolCatalog, "native", "catalog"),
  ...baseRegistrations,
];

/**
 * Plugin-contributed registrations. Populated at runtime by `registerPluginTools()`
 * (called from the plugin loader after dynamic import). Kept in a SEPARATE mutable array
 * so the builtin `registrations` list — and its module-load validation — stay intact, and
 * so every consumer below can fold plugins in via `allRegistrations()`.
 */
const pluginRegistrations: ToolRegistration[] = [];

/** Names of plugin tools declared owner-only (the plugin default). Mirrors the builtin
 *  OWNER_ONLY_TOOLS set for plugin tools; consulted by `isOwnerOnly()`. */
const pluginOwnerOnly = new Set<string>();

/** Runtime availability for plugin tools. Tools that require a start hook remain hidden
 *  and uncallable until that hook succeeds. Names stay reserved even when unavailable. */
const pluginAvailability = new Map<string, boolean>();

/** Builtin registrations + plugin registrations. Single iteration source for selection,
 *  <tool-index> rendering, the catalog list and the legacy full tool list. */
function activePluginRegistrations(): ToolRegistration[] {
  return pluginRegistrations.filter(r => pluginAvailability.get(r.tool.name) === true);
}

function allRegistrations(): ToolRegistration[] {
  const activePlugins = activePluginRegistrations();
  return activePlugins.length ? [...registrations, ...activePlugins] : registrations;
}

/** True when a tool name is already registered (builtin OR plugin). Used by the plugin
 *  loader to enforce global name uniqueness before accepting a plugin. */
export function hasToolName(name: string): boolean {
  return registrationMap.has(name) || pluginRegistrations.some(r => r.tool.name === name);
}

/**
 * Register a batch of validated plugin tools. Called by the plugin loader. Re-checks
 * global name uniqueness (authoritative gate) and updates the executor / registration
 * maps plus the owner-only set. Throws on a duplicate so the loader can isolate that
 * plugin; it rejects the whole batch before mutating anything, so no partial registration.
 */
export function registerPluginTools(
  regs: PluginToolRegistration[],
  options: { active?: boolean } = {},
): void {
  const batchNames = new Set<string>();
  for (const r of regs) {
    if (hasToolName(r.tool.name) || batchNames.has(r.tool.name)) {
      throw new Error(`Duplicate plugin tool name: ${r.tool.name}`);
    }
    batchNames.add(r.tool.name);
  }
  for (const r of regs) {
    const registration: ToolRegistration = {
      tool: r.tool,
      exposure: r.exposure ?? "on-demand",
      group: r.group,
      keywords: r.keywords,
      aliases: r.aliases,
      signals: r.signals,
      capability: r.capability,
      modelPredicate: r.modelPredicate,
    };
    pluginRegistrations.push(registration);
    registrationMap.set(r.tool.name, registration);
    executorMap.set(r.tool.name, r.tool.execute);
    pluginAvailability.set(r.tool.name, options.active ?? true);
    // Plugin tools default to owner-only unless the author explicitly set ownerOnly:false.
    if (r.ownerOnly !== false) pluginOwnerOnly.add(r.tool.name);
  }
}


/** Activate or deactivate a previously registered plugin's tools as one lifecycle unit. */
export function setPluginToolsActive(names: string[], active: boolean): void {
  for (const name of names) {
    if (!pluginAvailability.has(name)) {
      throw new Error(`Unknown plugin tool: ${name}`);
    }
  }
  for (const name of names) pluginAvailability.set(name, active);
}

// ── Registration validation (runs once at module load) ──
(function validateRegistrations() {
  const seen = new Set<string>();
  for (const r of registrations) {
    const name = r.tool.name;
    if (seen.has(name)) throw new Error(`Duplicate tool registration: ${name}`);
    seen.add(name);
    const valid: ExposureLevel[] = ["native", "match", "index", "on-demand"];
    if (!valid.includes(r.exposure)) throw new Error(`Invalid exposure for ${name}: ${r.exposure}`);
    // match tools should carry at least one matching signal (keyword/alias) so the
    // matcher can ever reach them; otherwise they would only be reachable via catalog.
    if (r.exposure === "match" && (r.keywords?.length ?? 0) === 0 && (r.aliases?.length ?? 0) === 0) {
      logger.warn({ tool: name }, "match tool has no keywords/aliases; only reachable via tool_catalog");
    }
  }
})();

const executorMap = new Map(registrations.map(r => [r.tool.name, r.tool.execute]));
const registrationMap = new Map(registrations.map(r => [r.tool.name, r]));

function toLlmFunctionTool(t: Tool): LlmFunctionTool {
  return { name: t.name, description: t.description, parameters: t.parameters };
}

/**
 * Legacy full tool list (exposure flag OFF). A function rather than a constant because
 * plugin registrations are added at runtime AFTER this module loads — a const captured at
 * load time would omit them. baseRegistrations excludes the exposure-only tool_catalog by
 * construction; plugin tools are folded in so the OFF path still exposes them.
 */
export function getLlmTools(): LlmFunctionTool[] {
  return [
    ...baseRegistrations.map(r => toLlmFunctionTool(r.tool)),
    ...activePluginRegistrations().map(r => toLlmFunctionTool(r.tool)),
  ];
}

export interface ToolSelectionContext {
  profile: LlmProfile;
  /** Raw prompt/trigger text used for matching (may be empty). */
  prompt: string;
  trigger: string;
  /** Whether the request carried attachments. */
  hasAttachment?: boolean;
  /** Whether the exposure feature is enabled. */
  exposureEnabled: boolean;
  /** Cap on matched tools (native excluded). */
  maxMatchedTools: number;
  /** Tool names already surfaced this request (e.g. named or catalog-described). */
  enabledTools?: Set<string>;
}

function passesProfileGate(r: ToolRegistration, profile: LlmProfile): boolean {
  if (r.capability && !supportsCapability(profile, r.capability)) return false;
  return r.modelPredicate ? r.modelPredicate(profile.model) : true;
}

/**
 * Compute the tool definitions to send this turn.
 *
 * Feature flag OFF → every registered local function tool (minus model-gated tools).
 *
 * Feature flag ON:
 * - native always included (minus failed model gate);
 * - match included when the deterministic matcher hits this turn (or already enabled);
 * - index / on-demand omitted — reached through tool_catalog;
 */
export function getToolDefinitions(ctx: ToolSelectionContext): LlmFunctionTool[] {
  if (!ctx.exposureEnabled) {
    const localTools = [...baseRegistrations, ...activePluginRegistrations()]
      .filter(r => passesProfileGate(r, ctx.profile))
      .map(r => toLlmFunctionTool(r.tool));
    return localTools;
  }

  const out: LlmFunctionTool[] = [];
  const normalized = normalizeForMatch(ctx.prompt);
  const signals = detectSignals(ctx.prompt, ctx.hasAttachment ?? false);
  const all = allRegistrations();
  const matchRegs = all.filter(r => r.exposure === "match");
  const hits = matchTools(matchRegs, normalized, signals, ctx.maxMatchedTools);
  const hitNames = new Set(hits.map(h => h.name));
  const enabled = ctx.enabledTools ?? new Set<string>();

  const included: string[] = [];
  const matchedNames: string[] = [];
  for (const r of all) {
    const name = r.tool.name;
    if (!passesProfileGate(r, ctx.profile)) continue;

    let include = false;
    if (r.exposure === "native") include = true;
    else if (r.exposure === "match" && (hitNames.has(name) || enabled.has(name))) {
      include = true;
      if (hitNames.has(name)) matchedNames.push(name);
    } else if (enabled.has(name)) {
      // index/on-demand explicitly surfaced this request → allow direct schema.
      include = true;
    }

    if (include) {
      out.push(toLlmFunctionTool(r.tool));
      included.push(name);
    }
  }


  const jsonBytes = Buffer.byteLength(JSON.stringify(out), "utf8");
  logger.info(
    {
      exposure: "on",
      profile: ctx.profile.name,
      model: ctx.profile.model,
      nativeCount: all.filter(r => r.exposure === "native" && passesProfileGate(r, ctx.profile)).length,
      matchedNames,
      toolCount: out.length,
      jsonBytes,
      promptLen: ctx.prompt.length,
    },
    "tool selection",
  );

  return out;
}

/**
 * Render the short <tool-index> block from registry metadata. Lists only `index`
 * groups (never on-demand, never native/match). Returns "" when there is nothing to
 * show (also used to skip the block when the feature flag is off — the caller decides).
 */
export function renderToolIndex(): string {
  const groups = new Set<string>();
  for (const r of allRegistrations()) {
    if (r.exposure === "index") groups.add(r.group);
  }
  if (groups.size === 0) return "";
  const labels = [...groups].map(g => GROUP_LABELS[g] ?? g).join(", ");
  return `<tool-index>
Additional tool groups are available through tool_catalog: ${labels}.
The tools listed directly are not the full capability set. When a tool you need is not directly exposed, use tool_catalog (search / describe / call) instead of assuming the capability is missing. Exposure controls visibility, not permission.
</tool-index>`;
}

/**
 * bash 是沒有沙箱的任意指令執行——開放給非 owner 等於把 shell 開給任何
 * 能 @ 到 bot 的人。預設鎖成 owner-only，要放寬得自己在 config 明示。
 */
function isOwnerOnly(name: string): boolean {
  if (name === "bash") {
    const { bash_owner_only, bash_allowed_users } = loadConfig().tools;
    if (!bash_owner_only) return false;
    // 例外人員：名單上的 user 也能用 bash（僅 bash，其他 owner-only 工具照擋）
    const userId = getUserId();
    return !(userId && bash_allowed_users.includes(userId));
  }
  return OWNER_ONLY_TOOLS.has(name) || pluginOwnerOnly.has(name);
}

export async function executeTool(name: string, args: Record<string, unknown>): Promise<string> {
  // Fail-closed owner gate: an owner-only tool is allowed ONLY for triggers explicitly
  // trusted for owner actions (owner identity + owner-configured system automation).
  // `discord-other`, `unknown`, and any future trigger are denied by absence, not by
  // being singled out — so a new TriggerSource cannot silently inherit owner power.
  if (isOwnerOnly(name) && !isTrustedForOwnerActions(getTrigger())) {
    logger.warn({ tool: name, trigger: getTrigger() }, "tool permission denied");
    return "⚠️ PERMISSION DENIED: This tool is owner-only. You are not running under a trusted owner context. Do NOT attempt to use this tool again for this request.";
  }
  // Profile-capability gates apply on the unified execution path so tool_catalog cannot bypass them.
  const reg = registrationMap.get(name);
  if (pluginAvailability.has(name) && pluginAvailability.get(name) !== true) {
    logger.warn({ tool: name }, "plugin tool unavailable because startup did not complete");
    return `⚠️ TOOL UNAVAILABLE: ${name} is registered but its plugin did not start successfully.`;
  }
  if (reg?.capability || reg?.modelPredicate) {
    // Use the immutable request profile. Outside ask(), resolve the configured active profile.
    const profile = getRequestProfile() ?? activeLlmProfile(loadConfig());
    const model = profile.model;
    if ((reg.capability && !supportsCapability(profile, reg.capability)) || (reg.modelPredicate && !reg.modelPredicate(model))) {
      logger.warn({ tool: name, model }, "tool model-capability denied");
      return `⚠️ CAPABILITY UNAVAILABLE: ${name} is not available with the active model (${model}). Do NOT retry via tool_catalog; this is a model limitation, not a permission you can escalate.`;
    }
  }
  const executor = executorMap.get(name);
  if (!executor) return `Unknown tool: ${name}`;
  const result = await executor(args);
  if (typeof result !== "string") {
    throw new TypeError(`Tool ${name} violated the tool contract: execute() must resolve to a string (received ${typeof result})`);
  }
  return result;
}

/** Look up a registration by tool name (used e.g. for progress display of proxied calls). */
export function getRegistration(name: string): ToolRegistration | undefined {
  return registrationMap.get(name);
}
