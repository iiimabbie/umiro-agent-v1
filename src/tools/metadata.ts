import type { Tool } from "../types.js";
import type { LlmCapability } from "../llm/types.js";
import { DATE_TIME_INTENTS, IMAGE_EDIT_INTENTS } from "./intents.js";

/**
 * Tool exposure level — controls how much the model sees about a tool each turn.
 *
 * IMPORTANT: exposure is *visibility*, not permission. The real security boundary is
 * still `executeTool()` + `OWNER_ONLY_TOOLS` + trigger + per-tool confirmation rules.
 * Hiding a tool never grants it; surfacing a tool never bypasses owner-only checks.
 *
 * - `native`     : always placed in the API tool list every request.
 * - `match`      : full schema is added only when this turn's prompt/trigger/signals match.
 * - `index`      : not sent as schema; its capability group is named in <tool-index>,
 *                  and the model reaches it through `tool_catalog`.
 * - `on-demand`  : never in <tool-index>; only discoverable when the user names it or the
 *                  model searches for it via `tool_catalog.search`.
 */
export type ExposureLevel = "native" | "match" | "index" | "on-demand";

/**
 * Registry-side metadata wrapping a `Tool`. The `Tool` interface itself is unchanged;
 * this keeps builtin tool files from needing edits. The registry is the single source
 * of truth for classification — no second copy lives in agent.ts or prompt.ts.
 */
export type MatchSignalName = "hasDateTime" | "hasAttachment" | "hasImageEditRequest";

export interface ToolRegistration {
  tool: Tool;
  exposure: ExposureLevel;
  /** Capability group; also used for <tool-index> grouping and matcher group hits. */
  group: string;
  /** Natural-language intent phrases that make this tool match a prompt. */
  keywords?: string[];
  /** Alternate names/phrases; an exact mention counts as a direct hit. */
  aliases?: string[];
  /** Coarse request signals that may expose a match-level tool. */
  signals?: MatchSignalName[];
  capability?: LlmCapability;
  modelPredicate?: (model: string) => boolean;
}

/** Human-readable short label for each index group, shown in <tool-index>. */
export const GROUP_LABELS: Record<string, string> = {
  "filesystem-shell": "filesystem & shell",
  "memory-people": "memory & people",
  "weather": "weather",
  "schedules": "reminders & cron schedules",
  "discord-messages": "discord messages",
  "discord-admin": "discord admin",
  "google-calendar": "google calendar",
  "google-gmail": "gmail",
  "google-drive": "google drive",
  "google-tasks": "google tasks",
  "history-journal": "session history & journal transcripts",
  "integrity": "soul-guardian file integrity",
  "skills": "skill install/manage",
  "image-generation": "image generation",
  "usage": "usage dashboard",
  "catalog": "tool catalog",
};

/** GPT family predicate — mirrors the check previously inlined in agent.ts. */
export function isGptModel(model: string): boolean {
  return /^gpt(?:-|$)/i.test(model);
}

/** Lowercase + collapse whitespace + strip common CJK/ASCII punctuation for matching. */
export function normalizeForMatch(text: string): string {
  return text
    .toLowerCase()
    .replace(/[，。、！？；：「」『』（）()[\]{}<>"'`,.!?;:]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export interface MatchSignal {
  /** Whether a date/time expression appears. */
  hasDateTime: boolean;
  /** Whether the request has image attachments. */
  hasAttachment: boolean;
  /** Whether an attached-image request asks for an edit rather than visual analysis. */
  hasImageEditRequest: boolean;
}

/**
 * Detect coarse signals from a raw prompt string.
 *
 * `hasDateTime` is deliberately scoped to *scheduling-shaped* time expressions: an
 * explicit clock time, an ISO date, or forward-looking / recurring words. The bare
 * present-day words 今天 / today are intentionally excluded — on their own they are a
 * casual reference ("今天過得好嗎", "how's your day") and would otherwise surface the
 * whole schedules + calendar group on idle chatter. Present-day scheduling still fires
 * via the clock-time / 幾點 / schedule keywords ("今天下午三點提醒我").
 */
export function detectSignals(prompt: string, hasAttachment: boolean): MatchSignal {
  const normalized = normalizeForMatch(prompt);
  return {
    hasDateTime:
      /\d{1,2}[:：]\d{2}/.test(prompt) ||
      /\d{4}-\d{2}-\d{2}/.test(prompt) ||
      DATE_TIME_INTENTS.some(phrase => normalized.includes(normalizeForMatch(phrase))) ||
      /(禮拜|星期|周)[一二三四五六日天]/.test(prompt) ||
      /(曜日|월요일|화요일|수요일|목요일|금요일|토요일|일요일)/i.test(prompt),
    hasAttachment,
    hasImageEditRequest: hasAttachment &&
      IMAGE_EDIT_INTENTS.some(phrase => normalized.includes(normalizeForMatch(phrase))),
  };
}

export interface MatchHit {
  name: string;
  group: string;
  /** Priority tier: 3 exact name/alias, 2 multi-keyword, 1 single keyword/group. */
  priority: number;
  reason: string;
}

/**
 * Deterministic matcher — no extra LLM call. Given normalized prompt text and signals,
 * returns which `match`-level tools should be exposed this turn, capped and ranked.
 *
 * Ranking for the cap: exact tool-name/alias > multiple keyword hits > single keyword
 * or group-only hit. `native` tools are NOT passed here and never count toward the cap.
 */
export function matchTools(
  registrations: ToolRegistration[],
  normalizedPrompt: string,
  signals: MatchSignal,
  maxMatched: number,
): MatchHit[] {
  const hits: MatchHit[] = [];

  for (const reg of registrations) {
    if (reg.exposure !== "match") continue;
    const name = reg.tool.name;
    const nameNorm = normalizeForMatch(name.replace(/_/g, " "));
    const aliases = (reg.aliases ?? []).map(normalizeForMatch);
    const keywords = (reg.keywords ?? []).map(normalizeForMatch);

    // Exact tool-name or alias mention → strongest hit.
    if (
      normalizedPrompt.includes(nameNorm) ||
      normalizedPrompt.includes(normalizeForMatch(name)) ||
      aliases.some(a => a && normalizedPrompt.includes(a))
    ) {
      hits.push({ name, group: reg.group, priority: 3, reason: "name/alias" });
      continue;
    }

    // Keyword hits.
    const matchedKw = keywords.filter(k => k && normalizedPrompt.includes(k));
    if (matchedKw.length >= 2) {
      hits.push({ name, group: reg.group, priority: 2, reason: `kw:${matchedKw.length}` });
      continue;
    }
    if (matchedKw.length === 1) {
      hits.push({ name, group: reg.group, priority: 1, reason: `kw:${matchedKw[0]}` });
      continue;
    }

    // Signal-based hits are explicit registry metadata, so adding a coarse signal does
    // not accidentally expose every tool in a vaguely related group.
    const matchedSignal = (reg.signals ?? []).find(signal => signals[signal]);
    if (matchedSignal) {
      hits.push({ name, group: reg.group, priority: 1, reason: `signal:${matchedSignal}` });
      continue;
    }
  }

  // Rank and cap. Stable by priority desc.
  hits.sort((a, b) => b.priority - a.priority);
  return hits.slice(0, Math.max(0, maxMatched));
}
