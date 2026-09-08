import {
  openSync, closeSync, fsyncSync, writeSync, readFileSync, writeFileSync,
  renameSync, mkdirSync, existsSync, unlinkSync, statSync,
} from "node:fs";
import { dirname, basename } from "node:path";
import { randomBytes } from "node:crypto";
import { logger } from "./logger.js";
import type { Message, RunCheckpoint, SessionModelSettings, TokenUsage, ToolHistoryEvent } from "./types.js";

/**
 * Durable, concurrency-safe on-disk representation for a single session file.
 *
 * Two problems this layer solves that a plain writeFile/rename did not:
 *
 * 1. Durability across crashes. A temp file is written, fsync'd, atomically renamed
 *    onto the final path, and then the containing directory is fsync'd so the rename
 *    itself survives power loss. The temp name is unique per write (pid + monotonic
 *    counter + random) so two writers in the SAME process cannot clobber each other's
 *    temp file mid-write.
 *
 * 2. Stale snapshot / lost update. Each persisted payload carries a monotonic
 *    `revision`. Writes take a cross-process advisory lock, re-read the on-disk
 *    revision, and if it advanced past the base the writer loaded, the writer's
 *    changes are MERGED onto the newer on-disk state (append-only reconciliation of
 *    messages and toolHistory, additive usage) instead of blindly overwriting. This
 *    holds for multiple Session instances in one process and for separate processes.
 *
 * A bare UUID would only detect *identity* collisions, not concurrent edits to the
 * same session — merge + revision is required, per the durability requirement.
 */

export interface SessionData {
  modelSettings: SessionModelSettings;
  messages: Message[];
  usage: TokenUsage;
  toolHistory: ToolHistoryEvent[];
  runCheckpoint?: RunCheckpoint;
}

/** A snapshot loaded from disk, tagged with the revision it was read at. */
export interface SessionSnapshot extends SessionData {
  revision: number;
}

interface PersistedShape {
  modelSettings?: SessionModelSettings;
  messages?: Message[];
  usage?: TokenUsage;
  toolHistory?: ToolHistoryEvent[];
  runCheckpoint?: RunCheckpoint;
  revision?: number;
}

const LOCK_STALE_MS = 30_000;
const LOCK_RETRY_MS = 25;
const LOCK_MAX_WAIT_MS = 10_000;

let tempCounter = 0;

function uniqueTempPath(finalPath: string): string {
  tempCounter = (tempCounter + 1) % Number.MAX_SAFE_INTEGER;
  const rand = randomBytes(6).toString("hex");
  return `${finalPath}.${process.pid}.${Date.now()}.${tempCounter}.${rand}.tmp`;
}

function fsyncDir(dir: string): void {
  // Directory fsync makes the rename durable. On platforms/filesystems that reject
  // an fsync on a directory fd, degrade gracefully rather than fail the whole write.
  let fd: number | undefined;
  try {
    fd = openSync(dir, "r");
    fsyncSync(fd);
  } catch (err) {
    logger.debug({ err: (err as Error).message, dir }, "directory fsync skipped");
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* already closed */ }
    }
  }
}

/**
 * Write bytes to `finalPath` atomically and durably: unique temp → fsync temp →
 * rename → fsync dir. The temp file is removed on any failure so a partial write can
 * never be mistaken for the real file.
 */
export function atomicWriteFileSync(finalPath: string, contents: string): void {
  const dir = dirname(finalPath);
  mkdirSync(dir, { recursive: true });
  const temp = uniqueTempPath(finalPath);
  let fd: number | undefined;
  try {
    fd = openSync(temp, "wx");
    writeFileSync(fd, contents, { encoding: "utf8" });
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temp, finalPath);
    fsyncDir(dir);
  } catch (err) {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
    try { if (existsSync(temp)) unlinkSync(temp); } catch { /* best effort */ }
    throw err;
  }
}

function lockPath(finalPath: string): string {
  return `${finalPath}.lock`;
}

/**
 * Acquire a cross-process advisory lock for `finalPath` via an O_EXCL lock file.
 * Handles a crashed holder by reclaiming a lock older than LOCK_STALE_MS. Returns a
 * release function. Uses a bounded busy-wait; session writes are short.
 */
function acquireLock(finalPath: string): () => void {
  const lock = lockPath(finalPath);
  mkdirSync(dirname(finalPath), { recursive: true });
  const deadline = Date.now() + LOCK_MAX_WAIT_MS;
  for (;;) {
    try {
      const fd = openSync(lock, "wx");
      try { writeSync(fd, `${process.pid}:${Date.now()}`); } catch { /* metadata only */ }
      closeSync(fd);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        try { unlinkSync(lock); } catch { /* already gone */ }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      // Reclaim a stale lock left by a crashed holder.
      try {
        const age = Date.now() - statSync(lock).mtimeMs;
        if (age > LOCK_STALE_MS) {
          logger.warn({ lock, age }, "reclaiming stale session lock");
          unlinkSync(lock);
          continue;
        }
      } catch { /* lock vanished between checks; retry acquisition */ }
      if (Date.now() > deadline) {
        throw new Error(`Timed out acquiring session lock: ${basename(finalPath)}`);
      }
      // Small synchronous backoff. Session writes are sub-millisecond; a blocking
      // spin keeps the CAS section simple and avoids interleaving async writers.
      const until = Date.now() + LOCK_RETRY_MS;
      while (Date.now() < until) { /* busy wait */ }
    }
  }
}

function parse(contents: string): PersistedShape {
  return JSON.parse(contents) as PersistedShape;
}

function normalizeModelSettings(value: SessionModelSettings | undefined): SessionModelSettings {
  if (!value
    || typeof value.profile !== "string" || !value.profile.trim()
    || typeof value.model !== "string" || !value.model.trim()
    || typeof value.reasoningEffort !== "string"
    || typeof value.revision !== "number" || !Number.isInteger(value.revision) || value.revision < 0) {
    throw new Error("session file is missing valid modelSettings");
  }
  const queueMode = value.queueMode === "followup" || value.queueMode === "steer" ? value.queueMode : undefined;
  return { ...value, profile: value.profile.trim(), model: value.model.trim(), ...(queueMode ? { queueMode } : {}) };
}

function normalizeRunCheckpoint(value: RunCheckpoint | undefined): RunCheckpoint | undefined {
  if (!value || typeof value !== "object") return undefined;
  if (typeof value.id !== "string" || !value.id
    || (value.status !== "active" && value.status !== "failed")
    || typeof value.startedAt !== "string"
    || typeof value.updatedAt !== "string"
    || typeof value.originalTask !== "string"
    || !Array.isArray(value.progressNotes)
    || !value.progressNotes.every(note => typeof note === "string")
    || !Array.isArray(value.toolEvidence)) return undefined;

  const toolEvidence = value.toolEvidence.filter(event => event
    && typeof event.id === "string"
    && typeof event.time === "string"
    && typeof event.tool === "string"
    && typeof event.isError === "boolean"
    && typeof event.inputHint === "string"
    && typeof event.resultHint === "string"
    && typeof event.truncated === "boolean").slice(-12);
  const failure = value.failure
    && typeof value.failure.name === "string"
    && typeof value.failure.message === "string"
    ? { name: value.failure.name.slice(0, 2_000), message: value.failure.message.slice(0, 2_000) }
    : undefined;
  return {
    id: value.id.slice(0, 200),
    status: value.status,
    startedAt: value.startedAt.slice(0, 100),
    updatedAt: value.updatedAt.slice(0, 100),
    originalTask: value.originalTask.slice(0, 8_000),
    progressNotes: value.progressNotes.slice(-6).map(note => note.slice(0, 2_000)),
    toolEvidence: toolEvidence.map(event => ({
      id: event.id.slice(0, 200), time: event.time.slice(0, 100), tool: event.tool.slice(0, 200),
      isError: event.isError, inputHint: event.inputHint.slice(0, 1_000),
      resultHint: event.resultHint.slice(0, 4_000), truncated: event.truncated,
    })),
    ...(failure ? { failure } : {}),
  };
}

function emptySnapshot(modelSettings: SessionModelSettings): SessionSnapshot {
  return {
    modelSettings: { ...modelSettings },
    messages: [],
    usage: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0 },
    toolHistory: [],
    revision: 0,
  };
}

function normalize(shape: PersistedShape): SessionSnapshot {
  const runCheckpoint = normalizeRunCheckpoint(shape.runCheckpoint);
  return {
    modelSettings: normalizeModelSettings(shape.modelSettings),
    messages: shape.messages ?? [],
    usage: shape.usage ? { ...shape.usage, reasoningTokens: shape.usage.reasoningTokens ?? 0 } : { inputTokens: 0, outputTokens: 0, reasoningTokens: 0 },
    toolHistory: shape.toolHistory ?? [],
    ...(runCheckpoint ? { runCheckpoint } : {}),
    revision: typeof shape.revision === "number" && shape.revision >= 0 ? shape.revision : 0,
  };
}

/** Read the current snapshot. A missing or malformed file starts empty; an existing
 * session with invalid model settings is rejected instead of being silently rewritten. */
export function readSnapshot(finalPath: string, newSessionSettings: SessionModelSettings): SessionSnapshot {
  let contents: string;
  try {
    contents = readFileSync(finalPath, "utf-8");
  } catch {
    return emptySnapshot(newSessionSettings);
  }
  let shape: PersistedShape;
  try {
    shape = parse(contents);
  } catch {
    return emptySnapshot(newSessionSettings);
  }
  return normalize(shape);
}

function serialize(data: SessionData, revision: number): string {
  return JSON.stringify({
    modelSettings: data.modelSettings,
    messages: data.messages,
    usage: data.usage,
    toolHistory: data.toolHistory,
    ...(data.runCheckpoint ? { runCheckpoint: data.runCheckpoint } : {}),
    revision,
  }, null, 2);
}

/**
 * Merge locally-intended `desired` state onto a newer on-disk `current` snapshot.
 *
 * `base` is the snapshot the caller originally loaded. Messages and tool history are
 * append-only logs, so the merge keeps everything on disk plus anything the caller
 * added beyond the base length. Usage is additive: the caller's delta over base is
 * applied on top of the current on-disk totals. This prevents a concurrent writer's
 * appended messages from being lost when this writer flushes.
 */
export function mergeSessionState(
  base: SessionData,
  desired: SessionData,
  current: SessionData,
): SessionData {
  const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

  function mergeLog<T>(label: string, baseLog: T[], desiredLog: T[], currentLog: T[]): T[] {
    // A shrink/clear/compact is destructive. If another writer advanced the file, silently
    // applying the stale rewrite would erase its new events; require the caller to reload.
    if (desiredLog.length < baseLog.length) {
      throw new Error(`concurrent session conflict during destructive ${label} rewrite`);
    }
    if (currentLog.length < baseLog.length) {
      throw new Error(`concurrent session conflict: on-disk ${label} was destructively rewritten`);
    }

    const merged = [...currentLog];
    for (let i = 0; i < baseLog.length; i++) {
      const localChanged = !equal(desiredLog[i], baseLog[i]);
      if (!localChanged) continue;
      const remoteChanged = !equal(currentLog[i], baseLog[i]);
      if (remoteChanged && !equal(currentLog[i], desiredLog[i])) {
        throw new Error(`concurrent session conflict at ${label}[${i}]`);
      }
      merged[i] = desiredLog[i];
    }
    for (const item of desiredLog.slice(baseLog.length)) merged.push(item);
    return merged;
  }

  const localSettingsChanged = !equal(desired.modelSettings, base.modelSettings);
  const remoteSettingsChanged = !equal(current.modelSettings, base.modelSettings);
  let modelSettings = current.modelSettings;
  if (localSettingsChanged && !remoteSettingsChanged) {
    modelSettings = desired.modelSettings;
  } else if (localSettingsChanged && remoteSettingsChanged) {
    if (equal(desired.modelSettings, current.modelSettings)) {
      modelSettings = current.modelSettings;
    } else {
      throw new Error("concurrent session conflict while changing model settings");
    }
  }

  const messages = mergeLog("messages", base.messages, desired.messages, current.messages);
  const toolHistory = mergeLog("toolHistory", base.toolHistory, desired.toolHistory, current.toolHistory);

  const localCheckpointChanged = !equal(desired.runCheckpoint, base.runCheckpoint);
  const remoteCheckpointChanged = !equal(current.runCheckpoint, base.runCheckpoint);
  let runCheckpoint = current.runCheckpoint;
  if (localCheckpointChanged && !remoteCheckpointChanged) {
    runCheckpoint = desired.runCheckpoint;
  } else if (localCheckpointChanged && remoteCheckpointChanged) {
    if (equal(desired.runCheckpoint, current.runCheckpoint)) runCheckpoint = current.runCheckpoint;
    else throw new Error("concurrent session conflict while changing run checkpoint");
  }

  const usage: TokenUsage = {
    inputTokens: current.usage.inputTokens + (desired.usage.inputTokens - base.usage.inputTokens),
    outputTokens: current.usage.outputTokens + (desired.usage.outputTokens - base.usage.outputTokens),
    reasoningTokens: (current.usage.reasoningTokens ?? 0) + ((desired.usage.reasoningTokens ?? 0) - (base.usage.reasoningTokens ?? 0)),
  };
  if (usage.inputTokens < 0 || usage.outputTokens < 0 || usage.reasoningTokens < 0) {
    throw new Error("concurrent session conflict produced negative usage");
  }
  return { modelSettings, messages, usage, toolHistory, ...(runCheckpoint ? { runCheckpoint } : {}) };
}

export interface CommitResult {
  data: SessionData;
  revision: number;
  merged: boolean;
}

/**
 * Persist `desired` for a session file with lock + revision CAS + merge, then a durable
 * atomic write. `base` is the snapshot the caller last observed. Returns the committed
 * state (which may differ from `desired` if a concurrent writer's changes were merged
 * in) and the new revision so the caller can refresh its in-memory base.
 */
export function commitSession(finalPath: string, base: SessionData, baseRevision: number, desired: SessionData): CommitResult {
  const release = acquireLock(finalPath);
  try {
    const current = readSnapshot(finalPath, base.modelSettings);
    let committed = desired;
    let merged = false;
    if (current.revision !== baseRevision) {
      // Someone else advanced the file since we loaded. Merge instead of overwriting.
      committed = mergeSessionState(base, desired, current);
      merged = true;
      logger.warn(
        { finalPath: basename(finalPath), baseRevision, currentRevision: current.revision },
        "session write merged onto newer on-disk revision (lost-update prevented)",
      );
    }
    const nextRevision = current.revision + 1;
    atomicWriteFileSync(finalPath, serialize(committed, nextRevision));
    return { data: committed, revision: nextRevision, merged };
  } finally {
    release();
  }
}
