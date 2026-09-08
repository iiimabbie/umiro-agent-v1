import { mkdirSync, readdirSync, existsSync, renameSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { logger } from "./logger.js";
import { getDb } from "./db.js";
import { SESSIONS_DIR, ARCHIVE_DIR } from "./paths.js";
import {
  atomicWriteFileSync,
  commitSession,
  readSnapshot,
  type SessionData,
} from "./session-store.js";
import type { AttachmentReference, DiscordQueueMode, Message, RunCheckpoint, RunCheckpointToolEvidence, SessionModelSettings, TokenUsage, ToolHistoryEvent } from "./types.js";
import { loadConfig, REASONING_EFFORTS, type ReasoningEffort } from "./config.js";
import { defaultSessionModelSettings } from "./llm/profile.js";
import {
  assignNewMessageSearchId,
  ensureMessageSearchId,
  indexCompactSummary,
  indexConversationWindow,
  indexSessionMessage,
  indexToolHistoryEvent,
  reconcileSessionIndex,
} from "./session-index.js";
import { prepareLocalAttachmentReferences, reconcileAttachmentReferences } from "./attachment-index.js";

// 檔名格式：`{stem}.json` 或 `{stem}__{slug}.json`。
// stem 是把 routing id 的長前綴縮寫的結果（discord-channel- → dc-、discord-dm- → dm-），
// 讓資料夾裡的檔名短又可辨識；內部 id 本身不變。
// id 與縮寫都不含底線，所以用 `__` 當 stem 與頻道名 slug 的分界，掃檔時能在邊界精確比對，
// 避免 `...123` 誤match `...1234`。
function idToStem(id: string): string {
  return id.replace(/^discord-channel-/, "dc-").replace(/^discord-dm-/, "dm-");
}

function stemToId(stem: string): string {
  const base = stem.split("__")[0];
  // 相容舊檔名（未縮寫的完整 id）：沒有縮寫前綴時原樣回傳。
  return base.replace(/^dc-/, "discord-channel-").replace(/^dm-/, "discord-dm-");
}

/** 把頻道名轉成可放進檔名的 slug；保留中文，去掉路徑分隔與控制字元。 */
function slugify(name: string): string {
  return name
    .replace(/[/\\\x00-\x1f]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/^\.+/, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

/** 找出磁碟上屬於這個 id 的 session 檔名（含 slug 後綴），沒有則回 null。 */
function findSessionFile(id: string): string | null {
  try {
    const files = readdirSync(SESSIONS_DIR).filter(f => f.endsWith(".json"));
    return files.find(f => stemToId(f.slice(0, -5)) === id) ?? null;
  } catch {
    return null;
  }
}

/** A compact summary is bookkeeping, not conversation: it is never archived as history. */
function isCompactSummary(message: Message): boolean {
  return message.isCompactSummary === true;
}

export class Session {
  readonly id: string;
  private filePath: string;
  private modelSettings: SessionModelSettings;
  private messages: Message[] = [];
  private usage: TokenUsage = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0 };
  private toolHistory: ToolHistoryEvent[] = [];
  private runCheckpoint?: RunCheckpoint;

  /**
   * Revision + base snapshot this instance last observed on disk. `save()` performs a
   * lock + CAS commit against `baseRevision`; if a concurrent writer (another instance
   * in this process, or a separate process) advanced the file, session-store merges
   * this instance's appended state onto the newer on-disk state and returns the merged
   * result, which we adopt so no update is lost. `baseData` is a deep copy taken at load
   * (and refreshed after every commit) so the merge can compute this instance's delta.
   */
  private baseRevision = 0;
  private baseData: SessionData;

  constructor(id: string) {
    this.id = id;
    this.modelSettings = defaultSessionModelSettings(loadConfig());
    this.baseData = { modelSettings: { ...this.modelSettings }, messages: [], usage: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0 }, toolHistory: [] };
    const existing = findSessionFile(id);
    this.filePath = existing ? resolve(SESSIONS_DIR, existing) : resolve(SESSIONS_DIR, `${idToStem(id)}.json`);
    this.load();
  }

  /** Snapshot current in-memory state as the merge base after a successful commit. */
  private snapshotBase(): SessionData {
    return {
      modelSettings: { ...this.modelSettings },
      messages: [...this.messages],
      usage: { ...this.usage },
      toolHistory: [...this.toolHistory],
      ...(this.runCheckpoint ? { runCheckpoint: structuredClone(this.runCheckpoint) } : {}),
    };
  }

  /** 設定頻道名：把檔名同步成 `{id}__{slug}.json`，頻道改名時自動 rename 舊檔。 */
  setChannelName(name: string): void {
    const slug = slugify(name);
    if (!slug) return;
    const target = resolve(SESSIONS_DIR, `${idToStem(this.id)}__${slug}.json`);
    if (target === this.filePath) return;
    try {
      mkdirSync(SESSIONS_DIR, { recursive: true });
      if (existsSync(this.filePath)) renameSync(this.filePath, target);
      this.filePath = target;
      // The lock and revision are path-derived. renameSync moves this instance's own
      // file (content and embedded revision intact) to the new path, so baseRevision is
      // still valid there; re-read to adopt whatever revision now lives at the new path
      // (covers the case where the source file did not yet exist and no rename occurred).
      this.baseRevision = readSnapshot(this.filePath, this.modelSettings).revision;
    } catch (err) {
      logger.error({ err: (err as Error).message, sessionId: this.id }, "session rename failed");
    }
  }

  getModelSettings(): SessionModelSettings {
    return { ...this.modelSettings };
  }

  setModelSettings(model: string, reasoningEffort: ReasoningEffort): void {
    const normalizedModel = model.trim();
    if (!normalizedModel) throw new Error("model must not be empty");
    if (!REASONING_EFFORTS.includes(reasoningEffort)) throw new Error(`invalid reasoning effort: ${reasoningEffort}`);
    const previous = this.modelSettings;
    this.modelSettings = {
      ...previous,
      model: normalizedModel,
      reasoningEffort,
      revision: previous.revision + 1,
    };
    try { this.save(); }
    catch (error) { this.modelSettings = previous; throw error; }
  }

  resetModelSettings(): void {
    const previous = this.modelSettings;
    const defaults = defaultSessionModelSettings(loadConfig());
    this.modelSettings = { ...defaults, revision: previous.revision + 1 };
    try { this.save(); }
    catch (error) { this.modelSettings = previous; throw error; }
  }

  getQueueModeOverride(): DiscordQueueMode | undefined {
    return this.modelSettings.queueMode;
  }

  setQueueModeOverride(mode: DiscordQueueMode | undefined): void {
    const previous = this.modelSettings;
    const next = { ...previous, revision: previous.revision + 1 };
    if (mode) next.queueMode = mode;
    else delete next.queueMode;
    this.modelSettings = next;
    try { this.save(); }
    catch (error) { this.modelSettings = previous; throw error; }
  }

  getMessages(): Message[] {
    return this.messages;
  }

  /** Remove completed bootstrap context from the durable active session. */
  removeOnboardingMessages(): boolean {
    const filtered = this.messages.filter(message => message.isOnboarding !== true);
    if (filtered.length === this.messages.length) return false;
    const previous = this.messages;
    this.messages = filtered;
    try { this.save(); }
    catch (error) { this.messages = previous; throw error; }
    logger.info({ sessionId: this.id, removed: previous.length - filtered.length }, "onboarding context removed from session");
    return true;
  }

  append(message: Message): void {
    assignNewMessageSearchId(message);
    this.messages.push(message);
    try { this.save(); }
    catch (error) { this.messages.pop(); throw error; }
    try {
      indexSessionMessage(this.id, message, this.messages.length - 1);
    } catch (err) {
      logger.error({ err: (err as Error).message, sessionId: this.id }, "session message indexing failed");
    }
    if (message.attachments?.length) {
      const parentId = ensureMessageSearchId(this.id, message, this.messages.length - 1);
      try {
        reconcileAttachmentReferences(this.id, parentId, message.attachments);
      } catch (err) {
        logger.error({ err: (err as Error).message, sessionId: this.id, parentId }, "attachment projection pending after session save");
      }
    }
  }

  /** Attach locally produced files to the newest assistant message and index them. */
  attachFilesToLastAssistant(paths: string[], relation: AttachmentReference["relation"] = "tool_output"): void {
    if (paths.length === 0) return;
    for (let index = this.messages.length - 1; index >= 0; index--) {
      const message = this.messages[index];
      if (message.role !== "assistant") continue;
      const parentId = ensureMessageSearchId(this.id, message, index);
      const references = prepareLocalAttachmentReferences(this.id, parentId, paths, relation);
      if (references.length === 0) return;
      const previous = message.attachments;
      const existing = new Set((previous ?? []).map(reference => reference.id));
      message.attachments = [...(previous ?? []), ...references.filter(reference => !existing.has(reference.id))];
      try { this.save(); }
      catch (error) { message.attachments = previous; throw error; }
      try {
        reconcileAttachmentReferences(this.id, parentId, message.attachments);
      } catch (err) {
        logger.error({ err: (err as Error).message, sessionId: this.id, parentId }, "attachment projection pending after session save");
      }
      return;
    }
  }

  /** Index one completed request as a context-rich conversation window. */
  indexConversationWindow(startIndex: number): void {
    try {
      indexConversationWindow(this.id, this.messages.slice(Math.max(0, startIndex)));
    } catch (err) {
      logger.error({ err: (err as Error).message, sessionId: this.id }, "conversation window indexing failed");
    }
  }

  /** Idempotently rebuild all active message/tool projections for this session. */
  reconcileSearchIndex(): void {
    // Assign deterministic IDs to legacy messages and persist them before creating
    // rebuildable projections. If durable persistence fails, no ghost search rows
    // are allowed to represent data that the source session does not contain.
    this.messages.forEach((message, ordinal) => ensureMessageSearchId(this.id, message, ordinal));
    this.save();
    reconcileSessionIndex(this.id, this.messages, this.toolHistory);
  }

  addUsage(usage: TokenUsage): void {
    const previous = { ...this.usage };
    this.usage.inputTokens += usage.inputTokens;
    this.usage.outputTokens += usage.outputTokens;
    this.usage.reasoningTokens += usage.reasoningTokens;
    try { this.save(); }
    catch (error) { this.usage = previous; throw error; }
  }

  getUsage(): TokenUsage {
    return { ...this.usage };
  }

  /** Append an immutable local-tool execution record without adding it to chat history. */
  recordToolEvent(event: ToolHistoryEvent): void {
    this.toolHistory.push(event);
    try { this.save(); }
    catch (error) { this.toolHistory.pop(); throw error; }
    try {
      indexToolHistoryEvent(this.id, event, this.toolHistory.length - 1);
    } catch (err) {
      logger.error({ err: (err as Error).message, sessionId: this.id, tool: event.tool }, "tool history indexing failed");
    }
  }

  /** Return the newest tool events, with their full input and output intact. */
  getRecentToolEvents(limit = 8): ToolHistoryEvent[] {
    return this.toolHistory.slice(-limit);
  }


  /** Return a copy of the unfinished-run handoff, if one exists. */
  getRunCheckpoint(): RunCheckpoint | undefined {
    return this.runCheckpoint ? structuredClone(this.runCheckpoint) : undefined;
  }

  /** Start a new foreground request after the caller captured any previous failed handoff. */
  beginRunCheckpoint(originalTask: string, resumeFrom?: RunCheckpoint): void {
    const now = new Date().toISOString();
    const previous = this.runCheckpoint;
    const inheritedNotes = resumeFrom
      ? [`Resuming interrupted predecessor task: ${resumeFrom.originalTask}`, ...resumeFrom.progressNotes]
      : [];
    this.runCheckpoint = {
      id: randomUUID(),
      status: "active",
      startedAt: now,
      updatedAt: now,
      originalTask: originalTask.slice(0, 8_000),
      progressNotes: inheritedNotes.slice(-6).map(note => note.slice(0, 2_000)),
      toolEvidence: resumeFrom?.toolEvidence.slice(-12) ?? [],
    };
    try { this.save(); }
    catch (error) { this.runCheckpoint = previous; throw error; }
  }

  /** Persist bounded evidence after each safe agent/tool boundary. */
  updateRunCheckpoint(event?: ToolHistoryEvent, progressNote?: string): void {
    if (!this.runCheckpoint) return;
    const previous = structuredClone(this.runCheckpoint);
    const next = structuredClone(this.runCheckpoint);
    next.updatedAt = new Date().toISOString();
    if (progressNote?.trim()) {
      next.progressNotes.push(progressNote.trim().slice(0, 2_000));
      next.progressNotes = next.progressNotes.slice(-6);
    }
    if (event) {
      const input = JSON.stringify(event.input).replace(/\s+/g, " ");
      const result = event.result.trim();
      const inputLimit = 1_000;
      const resultLimit = 4_000;
      const evidence: RunCheckpointToolEvidence = {
        id: event.id,
        time: event.time,
        tool: event.tool,
        isError: event.isError,
        inputHint: input.slice(0, inputLimit),
        resultHint: result.slice(0, resultLimit),
        truncated: input.length > inputLimit || result.length > resultLimit,
      };
      next.toolEvidence.push(evidence);
      // Keep the handoff bounded while preserving enough recent source evidence to
      // avoid re-reading ordinary files after a transport failure.
      next.toolEvidence = next.toolEvidence.slice(-12);
    }
    this.runCheckpoint = next;
    try { this.save(); }
    catch (error) { this.runCheckpoint = previous; throw error; }
  }

  /** Keep the bounded handoff for the next turn and record why this request stopped. */
  failRunCheckpoint(error: unknown): void {
    if (!this.runCheckpoint) return;
    const previous = structuredClone(this.runCheckpoint);
    const err = error instanceof Error ? error : new Error(String(error));
    this.runCheckpoint = {
      ...this.runCheckpoint,
      status: "failed",
      updatedAt: new Date().toISOString(),
      failure: { name: err.name, message: err.message.slice(0, 2_000) },
    };
    try { this.save(); }
    catch (saveError) { this.runCheckpoint = previous; throw saveError; }
  }

  /** Clear recovery state after final delivery, explicit cancellation, or archive/new. */
  clearRunCheckpoint(): void {
    if (!this.runCheckpoint) return;
    const previous = this.runCheckpoint;
    this.runCheckpoint = undefined;
    try { this.save(); }
    catch (error) { this.runCheckpoint = previous; throw error; }
  }

  /** 在最後一則 assistant message 上設定 msgId */
  setLastAssistantMsgId(msgId: string): void {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      if (this.messages[i].role === "assistant") {
        const previous = this.messages[i].msgId;
        this.messages[i].msgId = msgId;
        try { this.save(); }
        catch (error) { this.messages[i].msgId = previous; throw error; }
        return;
      }
    }
  }

  /**
   * Clear conversation state after a durable archive while retaining the channel's
   * selected model and queue settings. `/model` is a channel preference, not part
   * of a single conversation transcript, so `/new` and the daily journal must not
   * silently fall back to the active-profile default.
   */
  clear(): void {
    const previous = { messages: this.messages, usage: this.usage, toolHistory: this.toolHistory, runCheckpoint: this.runCheckpoint };
    this.messages = [];
    this.usage = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0 };
    this.toolHistory = [];
    this.runCheckpoint = undefined;
    try { this.save(); }
    catch (error) {
      this.messages = previous.messages;
      this.usage = previous.usage;
      this.toolHistory = previous.toolHistory;
      this.runCheckpoint = previous.runCheckpoint;
      throw error;
    }
    logger.info({ sessionId: this.id, model: this.modelSettings.model }, "session cleared while preserving settings");
  }

  archive(): string | null {
    this.reconcileSearchIndex();
    // Compact summaries are context caches, not original conversation. Their source
    // messages were saved at compaction time, so never archive the synthetic summary.
    const messages = this.messages.filter(m => !isCompactSummary(m));
    if (messages.length === 0) {
      logger.info({ sessionId: this.id }, "session archive skipped (empty)");
      this.clear();
      return null;
    }

    const archivePath = this.persistArchive(messages, "session");
    // Do not erase the active session if its durable archive could not be written.
    if (archivePath) this.clear();
    else logger.error({ sessionId: this.id }, "session retained because archive write failed");
    return archivePath;
  }

  /**
   * Persist the part about to be replaced by compaction without ending the active
   * session. This makes compaction a cache optimisation rather than data loss.
   *
   * Returns false when the JSON archive could not be written; callers must then
   * leave the active history untouched.
   */
  archiveForCompaction(messages: Message[], summary: string): boolean {
    const originalMessages = messages.filter(m => !isCompactSummary(m));
    if (originalMessages.length === 0) return true;
    this.reconcileSearchIndex();
    const archived = this.persistArchive(originalMessages, "compaction", summary) !== null;
    if (archived) {
      try { indexCompactSummary(this.id, summary); }
      catch (err) { logger.error({ err: (err as Error).message, sessionId: this.id }, "compact summary indexing failed"); }
    }
    return archived;
  }

  /** 壓縮 session：用摘要替換前半段 messages，保留最近的 keepRecent 則 */
  compact(summary: string, keepRecent: number): void {
    if (this.messages.length <= keepRecent) return;
    const kept = this.messages.slice(-keepRecent);
    const previous = this.messages;
    this.messages = [
      {
        role: "user",
        content: `[System] Previous conversation summary:
${summary}`,
        isCompactSummary: true,
      },
      ...kept,
    ];
    try { this.save(); }
    catch (error) { this.messages = previous; throw error; }
    logger.info({ sessionId: this.id, kept: kept.length, totalAfter: this.messages.length }, "session compacted");
  }

  get length(): number {
    return this.messages.length;
  }

  /** Write an immutable archive segment and index it for session search. */
  private persistArchive(messages: Message[], kind: "session" | "compaction", summary?: string): string | null {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const suffix = kind === "compaction" ? "-compact" : "";
    const archivePath = resolve(ARCHIVE_DIR, `${this.id}${suffix}-${timestamp}.json`);
    const archivedAt = new Date().toISOString();

    try {
      mkdirSync(ARCHIVE_DIR, { recursive: true });
      // Archives are uniquely-named, write-once files, so they need no lock/CAS — only
      // crash durability. atomicWriteFileSync gives unique-temp + fsync + atomic rename +
      // dir fsync so a half-written archive can never be mistaken for a complete one.
      atomicWriteFileSync(archivePath, JSON.stringify({
        sessionId: this.id,
        archivedAt,
        kind,
        ...(summary ? { summary } : {}),
        modelSettings: this.modelSettings,
        messages,
        usage: this.usage,
        toolHistory: this.toolHistory,
      }, null, 2));
      logger.info({ sessionId: this.id, archivePath, kind, count: messages.length, usage: this.usage }, "session archive written");
    } catch (err) {
      logger.error({ err, sessionId: this.id, kind }, "session archive write failed");
      return null;
    }

    // SQLite is an index/search copy. The JSON archive above is the durable source
    // of truth, so a database failure must not make compaction lose history.
    try {
      const db = getDb();
      const insert = db.prepare("INSERT INTO session_archive (session_id, role, content, time, msg_id, reply_to) VALUES (?, ?, ?, ?, ?, ?)");
      const tx = db.transaction(() => {
        for (const m of messages) {
          const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
          insert.run(this.id, m.role, content, m.time ?? null, m.msgId ?? null, m.replyTo ?? null);
        }
      });
      tx();
      logger.info({ sessionId: this.id, kind, count: messages.length }, "session archive indexed");
    } catch (err) {
      logger.error({ err: (err as Error).message, sessionId: this.id, kind }, "session archive db index failed");
    }

    return archivePath;
  }

  private load(): void {
    // readSnapshot is crash-safe and canonical-first: a missing or corrupt file yields
    // an empty snapshot at revision 0 rather than throwing, so a partially-written or
    // absent file never aborts session startup.
    const snapshot = readSnapshot(this.filePath, this.modelSettings);
    this.modelSettings = snapshot.modelSettings;
    this.messages = snapshot.messages;
    this.usage = snapshot.usage;
    this.toolHistory = snapshot.toolHistory;
    this.runCheckpoint = snapshot.runCheckpoint;
    this.baseRevision = snapshot.revision;
    this.baseData = this.snapshotBase();
    logger.info({ sessionId: this.id, count: this.messages.length, revision: this.baseRevision }, "session loaded");
  }


  /** 檢查 session 檔是否已存在（用於區分「從未觸發過」跟「已有對話歷史」） */
  static exists(id: string): boolean {
    return findSessionFile(id) !== null;
  }

  /** 列出所有 active session ID */
  static listActive(): string[] {
    try {
      const files = readdirSync(SESSIONS_DIR).filter(f => f.endsWith(".json"));
      return files.map(f => stemToId(f.slice(0, -5)));
    } catch {
      return [];
    }
  }

  private save(): void {
    // Durable, concurrency-safe commit: cross-process lock + revision CAS + append-only
    // merge + unique-temp write + fsync(file) + atomic rename + fsync(dir). commitSession
    // returns the state actually written — which may include a concurrent writer's
    // appended messages merged onto ours — so we adopt it and refresh our merge base.
    try {
      const result = commitSession(
        this.filePath,
        this.baseData,
        this.baseRevision,
        { modelSettings: this.modelSettings, messages: this.messages, usage: this.usage, toolHistory: this.toolHistory, ...(this.runCheckpoint ? { runCheckpoint: this.runCheckpoint } : {}) },
      );
      if (result.merged) {
        // Another writer advanced the file; adopt the merged result so this instance's
        // in-memory view matches disk and no appended history is silently dropped.
        this.modelSettings = result.data.modelSettings;
        this.messages = result.data.messages;
        this.usage = result.data.usage;
        this.toolHistory = result.data.toolHistory;
        this.runCheckpoint = result.data.runCheckpoint;
      }
      this.baseRevision = result.revision;
      this.baseData = this.snapshotBase();
    } catch (err) {
      logger.error({ err, sessionId: this.id }, "session save failed");
      throw err;
    }
  }
}
