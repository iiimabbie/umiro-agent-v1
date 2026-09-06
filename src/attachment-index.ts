import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, extname, resolve } from "node:path";
import { getDb } from "./db.js";
import { loadConfig } from "./config.js";
import { ARCHIVE_DIR, ATTACHMENT_INDEX_DIR, SESSIONS_DIR } from "./paths.js";
import { createSearchDocumentId, ingestSearchDocuments } from "./search-index.js";
import { logger } from "./logger.js";
import type { AttachmentReference } from "./types.js";
import { OfficeParser } from "officeparser";
import { createWorker, type Worker } from "tesseract.js";
import { safeFetchBuffer } from "./utils/safe-http.js";
import { describeImageBytes, resolveVisionConfig } from "./utils/vision.js";
import { today } from "./utils/time.js";
import {
  canRefresh,
  isRefreshableCdnStatus,
  isDiscordCdnUrlExpired,
  refreshDiscordAttachmentUrl,
  type AttachmentRefreshProvenance,
} from "./utils/attachment-refresh.js";

const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;
const MAX_TEXT_BYTES = 4 * 1024 * 1024;
const MAX_ATTACHMENT_ATTEMPTS = 5;
/** Cap on refreshable (non-permanent) retries before a stale-URL job is finally given up. */
const MAX_REFRESH_ATTEMPTS = 8;
/** Marks a job failure that should be retried via CDN refresh WITHOUT draining permanent attempts. */
class RefreshableAttachmentError extends Error {
  constructor(message: string, readonly countAttempt = true, readonly retryDelayMs?: number) { super(message); }
}
const CHUNK_CHARS = 6_000;
const CHUNK_OVERLAP = 400;

export interface RemoteAttachmentInput {
  url: string;
  name?: string;
  contentType?: string;
  size?: number;
  relation?: "upload" | "embed" | "reply_reference";
  /** Discord provenance for signed-CDN-URL refresh (only present for real uploads). */
  discordChannelId?: string;
  discordMessageId?: string;
  discordAttachmentId?: string;
}

interface AttachmentRow {
  id: string;
  session_id: string;
  channel_id: string | null;
  parent_id: string;
  url: string | null;
  original_name: string | null;
  content_type: string | null;
  local_path: string | null;
  size_bytes: number | null;
  content_hash: string | null;
  visibility_scope: string;
  relation: string;
  status: string;
  ocr_text: string | null;
  visual_description: string | null;
  extracted_text: string | null;
  ocr_status: string;
  vision_status: string;
  extract_status: string;
  discord_channel_id: string | null;
  discord_message_id: string | null;
  discord_attachment_id: string | null;
}

/** Provenance projected from an attachment row, for signed-CDN-URL refresh. */
function refreshProvenance(row: AttachmentRow): AttachmentRefreshProvenance {
  return {
    channelId: row.discord_channel_id,
    messageId: row.discord_message_id,
    attachmentId: row.discord_attachment_id,
    currentUrl: row.url,
  };
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeFilename(value: string | undefined, fallback: string): string {
  const cleaned = basename(value || fallback)
    .replace(/[\\/\x00-\x1f<>:"|?*]+/g, "-")
    .replace(/^\.+/, "")
    .trim();
  return (cleaned || fallback).slice(0, 160);
}

function channelIdForSession(sessionId: string): string | undefined {
  if (sessionId.startsWith("discord-channel-")) return sessionId.slice("discord-channel-".length);
  return undefined;
}

function visibilityForSession(_sessionId: string): string {
  return "owner_private";
}

function attachmentId(sessionId: string, parentId: string, identity: string, ordinal: number): string {
  return createSearchDocumentId("attachment-reference", sessionId, parentId, identity, ordinal);
}

function splitText(text: string): string[] {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) return [];
  if (normalized.length <= CHUNK_CHARS) return [normalized];
  const chunks: string[] = [];
  let start = 0;
  while (start < normalized.length) {
    const end = Math.min(normalized.length, start + CHUNK_CHARS);
    chunks.push(normalized.slice(start, end));
    if (end >= normalized.length) break;
    start = Math.max(start + 1, end - CHUNK_OVERLAP);
  }
  return chunks;
}


function searchableUrl(value: string): string {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return "remote attachment";
  }
}

function metadataText(row: AttachmentRow): string {
  return [
    `Attachment: ${row.original_name || "unnamed"}`,
    `Content-Type: ${row.content_type || "unknown"}`,
    `Size: ${row.size_bytes ?? "unknown"} bytes`,
    `Relation: ${row.relation}`,
    row.url ? `Source: ${searchableUrl(row.url)}` : "",
    row.local_path ? "Stored locally: yes" : "",
  ].filter(Boolean).join("\n");
}

function indexAttachmentRow(row: AttachmentRow): void {
  const common = {
    sourceType: "attachment" as const,
    sourceId: row.id,
    parentId: row.parent_id,
    sessionId: row.session_id,
    channelId: row.channel_id ?? undefined,
    visibilityScope: row.visibility_scope,
  };
  const documents = [{
    ...common,
    id: createSearchDocumentId("attachment", row.id, "metadata"),
    ordinal: 0,
    text: metadataText(row),
  }];
  const sections: Array<[string, string | null]> = [
    ["ocr", row.ocr_text],
    ["visual-description", row.visual_description],
    ["extracted-text", row.extracted_text],
  ];
  let ordinal = 1;
  for (const [kind, text] of sections) {
    for (const chunk of splitText(text || "")) {
      documents.push({
        ...common,
        id: createSearchDocumentId("attachment", row.id, kind, ordinal),
        ordinal: ordinal++,
        text: `${kind}:\n${chunk}`,
      });
    }
  }
  ingestSearchDocuments(documents, { removeMissingForSource: true });
}

function upsertAttachment(reference: AttachmentReference, sessionId: string, parentId: string): void {
  const db = getDb();
  db.transaction(() => {
    db.prepare(`
      INSERT INTO attachment_records (
        id, session_id, channel_id, parent_id, url, original_name, content_type,
        local_path, size_bytes, content_hash, visibility_scope, relation, status,
        discord_channel_id, discord_message_id, discord_attachment_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        url = COALESCE(excluded.url, attachment_records.url),
        original_name = COALESCE(excluded.original_name, attachment_records.original_name),
        content_type = COALESCE(excluded.content_type, attachment_records.content_type),
        local_path = COALESCE(excluded.local_path, attachment_records.local_path),
        size_bytes = COALESCE(excluded.size_bytes, attachment_records.size_bytes),
        content_hash = COALESCE(excluded.content_hash, attachment_records.content_hash),
        relation = excluded.relation,
        discord_channel_id = COALESCE(excluded.discord_channel_id, attachment_records.discord_channel_id),
        discord_message_id = COALESCE(excluded.discord_message_id, attachment_records.discord_message_id),
        discord_attachment_id = COALESCE(excluded.discord_attachment_id, attachment_records.discord_attachment_id),
        updated_at = datetime('now')
    `).run(
      reference.id, sessionId, channelIdForSession(sessionId) ?? null, parentId,
      reference.url ?? null, reference.name ?? null, reference.contentType ?? null,
      reference.localPath ?? null, reference.size ?? null, reference.contentHash ?? null,
      visibilityForSession(sessionId), reference.relation ?? "upload",
      "pending",
      reference.discordChannelId ?? null, reference.discordMessageId ?? null, reference.discordAttachmentId ?? null,
    );
    db.prepare(`
      INSERT INTO attachment_jobs (attachment_id, status, attempts, next_retry_at, last_error, updated_at)
      VALUES (?, 'pending', 0, NULL, NULL, datetime('now'))
      ON CONFLICT(attachment_id) DO UPDATE SET
        status = CASE WHEN attachment_jobs.status = 'complete' THEN 'complete' ELSE 'pending' END,
        attempts = CASE WHEN attachment_jobs.status = 'complete' THEN attachment_jobs.attempts ELSE 0 END,
        refresh_attempts = CASE WHEN attachment_jobs.status = 'complete' THEN attachment_jobs.refresh_attempts ELSE 0 END,
        next_retry_at = NULL,
        last_error = CASE WHEN attachment_jobs.status = 'complete' THEN attachment_jobs.last_error ELSE NULL END,
        updated_at = datetime('now')
    `).run(reference.id);
  })();
  const row = db.prepare("SELECT * FROM attachment_records WHERE id = ?").get(reference.id) as AttachmentRow;
  indexAttachmentRow(row);
}

/** Build remote references for the durable session without creating projections yet. */
export function prepareRemoteAttachmentReferences(
  sessionId: string,
  parentId: string,
  inputs: RemoteAttachmentInput[],
): AttachmentReference[] {
  return inputs.map((input, ordinal) => ({
    id: attachmentId(sessionId, parentId, input.discordAttachmentId ?? input.url, ordinal),
    url: input.url,
    ...(input.name ? { name: input.name } : {}),
    ...(input.contentType ? { contentType: input.contentType } : {}),
    ...(typeof input.size === "number" ? { size: input.size } : {}),
    relation: input.relation ?? "upload",
    ...(input.discordChannelId ? { discordChannelId: input.discordChannelId } : {}),
    ...(input.discordMessageId ? { discordMessageId: input.discordMessageId } : {}),
    ...(input.discordAttachmentId ? { discordAttachmentId: input.discordAttachmentId } : {}),
  }));
}

export function registerInlineImageAttachments(
  sessionId: string,
  parentId: string,
  images: Array<{ mediaType: string; data: string }>,
): AttachmentReference[] {
  return images.flatMap((image, ordinal) => {
    try {
      const data = Buffer.from(image.data, "base64");
      if (data.length === 0 || data.length > MAX_DOWNLOAD_BYTES) {
        throw new Error(`inline image size is outside the supported range: ${data.length}`);
      }
      const hash = sha256(data);
      const extension = extensionFor(image.mediaType, null);
      const directory = resolve(ATTACHMENT_INDEX_DIR, "inline", hash.slice(0, 2));
      mkdirSync(directory, { recursive: true });
      const path = resolve(directory, `${hash.slice(0, 24)}${extension}`);
      try { writeFileSync(path, data, { flag: "wx" }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const reference: AttachmentReference = {
        id: attachmentId(sessionId, parentId, hash, ordinal),
        name: `inline-${hash.slice(0, 12)}${extension}`,
        contentType: image.mediaType,
        localPath: path,
        size: data.length,
        contentHash: hash,
        relation: "upload",
      };
      upsertAttachment(reference, sessionId, parentId);
      return [reference];
    } catch (error) {
      logger.warn({ sessionId, parentId, err: (error as Error).message }, "inline image attachment registration failed");
      return [];
    }
  });
}

/** Build durable session references without touching the projection database. */
/**
 * Record image descriptions produced by the conversation turn that already had the images in
 * context, so the background worker does not re-upload them for a second vision call. The
 * worker skips any record already marked `complete`, which makes this a replacement rather
 * than a race: anything not written here still gets described the usual way.
 */
export function applyInlineImageDescriptions(pairs: Array<{ id: string; description: string }>): number {
  if (pairs.length === 0) return 0;
  const db = getDb();
  const update = db.prepare(`
    UPDATE attachment_records SET visual_description = ?, vision_status = 'complete',
      updated_at = datetime('now')
    WHERE id = ? AND vision_status != 'complete'
  `);
  let applied = 0;
  db.transaction(() => {
    for (const pair of pairs) {
      const description = pair.description.trim();
      if (!description) continue;
      applied += update.run(description, pair.id).changes;
    }
  })();
  return applied;
}

export function prepareLocalAttachmentReferences(
  sessionId: string,
  parentId: string,
  paths: string[],
  relation: AttachmentReference["relation"] = "generated",
): AttachmentReference[] {
  return [...new Set(paths)].flatMap((path, ordinal) => {
    try {
      const info = statSync(path);
      if (!info.isFile() || info.size > MAX_DOWNLOAD_BYTES) throw new Error(`local attachment exceeds ${MAX_DOWNLOAD_BYTES} byte limit`);
      const data = readFileSync(path);
      const hash = sha256(data);
      return [{
        id: attachmentId(sessionId, parentId, hash, ordinal),
        name: basename(path),
        localPath: path,
        size: info.size,
        contentHash: hash,
        relation,
      } satisfies AttachmentReference];
    } catch (error) {
      logger.warn({ path, err: (error as Error).message }, "local attachment reference preparation failed");
      return [];
    }
  });
}

export function reconcileAttachmentReferences(sessionId: string, parentId: string, references: AttachmentReference[]): void {
  for (const reference of references) upsertAttachment(reference, sessionId, parentId);
}

function extensionFor(contentType: string | null, name: string | null): string {
  const existing = extname(name || "");
  if (existing) return existing.toLowerCase();
  const map: Record<string, string> = {
    "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp",
    "application/pdf": ".pdf", "text/plain": ".txt", "text/markdown": ".md",
    "application/json": ".json",
  };
  return map[(contentType || "").toLowerCase()] || ".bin";
}

async function downloadAttachment(row: AttachmentRow): Promise<{ path: string; contentType: string | null; size: number; hash: string }> {
  if (row.local_path) {
    const info = statSync(row.local_path);
    if (!info.isFile() || info.size > MAX_DOWNLOAD_BYTES) throw new Error(`local attachment exceeds ${MAX_DOWNLOAD_BYTES} byte limit`);
    const data = readFileSync(row.local_path);
    return { path: row.local_path, contentType: row.content_type, size: data.length, hash: sha256(data) };
  }
  if (!row.url) throw new Error("attachment has neither local path nor source URL");

  let sourceUrl = row.url;
  const provenance = refreshProvenance(row);
  const refresh = async (): Promise<boolean> => {
    const fresh = await refreshDiscordAttachmentUrl({ ...provenance, currentUrl: sourceUrl });
    if (!fresh) return false;
    sourceUrl = fresh;
    getDb().prepare("UPDATE attachment_records SET url=?, updated_at=datetime('now') WHERE id=?").run(fresh, row.id);
    return true;
  };

  if (isDiscordCdnUrlExpired(sourceUrl) && canRefresh(provenance) && !await refresh()) {
    throw new RefreshableAttachmentError("Discord attachment URL expired and could not yet be refreshed");
  }

  let response = await safeFetchBuffer(sourceUrl, {
    maxBytes: MAX_DOWNLOAD_BYTES,
    idleTimeoutMs: 30_000,
    deadlineMs: 120_000,
    maxRedirects: 4,
  });
  if (!response.ok && isRefreshableCdnStatus(response.status) && canRefresh(provenance)) {
    if (!await refresh()) throw new RefreshableAttachmentError(`Discord attachment URL returned HTTP ${response.status}; refresh unavailable`);
    response = await safeFetchBuffer(sourceUrl, {
      maxBytes: MAX_DOWNLOAD_BYTES,
      idleTimeoutMs: 30_000,
      deadlineMs: 120_000,
      maxRedirects: 4,
    });
  }
  if (!response.ok) throw new Error(`attachment download failed: HTTP ${response.status}`);

  const data = response.body;
  const contentType = response.headers["content-type"]?.split(";")[0].trim() || row.content_type;
  const hash = sha256(data);
  const directory = resolve(ATTACHMENT_INDEX_DIR, hash.slice(0, 2));
  mkdirSync(directory, { recursive: true });
  const original = safeFilename(row.original_name || undefined, `attachment${extensionFor(contentType, row.original_name)}`);
  const path = resolve(directory, `${hash.slice(0, 16)}-${original}`);
  try { writeFileSync(path, data, { flag: "wx" }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  return { path, contentType, size: data.length, hash };
}

let ocrWorkerPromise: Promise<Worker> | undefined;

async function getOcrWorker(): Promise<Worker> {
  if (!ocrWorkerPromise) {
    const cachePath = resolve(ATTACHMENT_INDEX_DIR, "ocr-cache");
    mkdirSync(cachePath, { recursive: true });
    ocrWorkerPromise = createWorker("eng+chi_tra", undefined, { cachePath }).catch(error => {
      ocrWorkerPromise = undefined;
      throw error;
    });
  }
  return ocrWorkerPromise;
}

async function imageOcr(path: string): Promise<string> {
  const worker = await getOcrWorker();
  const result = await worker.recognize(path);
  return result.data.text.trim();
}

/**
 * Resolve the media type for a stored image from its recorded content-type, falling back to
 * the file extension. Only the four types the vision transports accept are emitted.
 */
function imageMediaType(path: string, contentType: string | null): string {
  const extensionMime: Record<string, string> = {
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
    ".gif": "image/gif", ".webp": "image/webp",
  };
  return contentType && ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(contentType)
    ? contentType
    : extensionMime[extname(path).toLowerCase()] || "image/png";
}

/**
 * Produce an objective, searchable visual description for a stored image. Delegates to the
 * decoupled vision transport in `utils/vision.ts`, which reads `attachment_analysis.*`
 * (model / transport / endpoint / key / size / output tokens) independently of the `/model`
 * chat switch. The image bytes are read here and handed over as a Buffer; nothing about the
 * API key is ever surfaced to callers.
 */
async function describeImage(path: string, contentType: string | null): Promise<string> {
  const data = readFileSync(path);
  return describeImageBytes(data, imageMediaType(path, contentType));
}

const OFFICE_EXTENSIONS = new Set([
  ".pdf", ".docx", ".pptx", ".xlsx", ".odt", ".odp", ".ods", ".rtf", ".csv", ".md", ".markdown", ".html", ".htm", ".epub",
]);

async function extractDocument(path: string, contentType: string | null, name: string | null): Promise<{ text: string; ocr: string }> {
  const ext = extensionFor(contentType, name || path);
  const textual = (contentType || "").startsWith("text/")
    || [".txt", ".json", ".yaml", ".yml", ".tsv", ".xml", ".js", ".ts", ".tsx", ".jsx", ".py", ".java", ".rs", ".go", ".sql", ".log"].includes(ext);
  if (textual && !OFFICE_EXTENSIONS.has(ext)) {
    return { text: readFileSync(path).subarray(0, MAX_TEXT_BYTES).toString("utf8").trim(), ocr: "" };
  }
  if (!OFFICE_EXTENSIONS.has(ext)) return { text: "", ocr: "" };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 180_000);
  timer.unref?.();
  try {
    const fileType = ext === ".markdown" ? "md" : ext === ".htm" ? "html" : ext.slice(1);
    const ast = await OfficeParser.parseOffice(path, {
      fileType: fileType as never,
      extractAttachments: true,
      ocr: true,
      ocrConfig: {
        language: "eng+chi_tra",
        timeout: { workerLoad: 60_000, recognition: 60_000, autoTerminate: 15_000 },
      },
      decompressionLimits: {
        maxUncompressedBytes: 128 * 1024 * 1024,
        maxZipEntries: 5_000,
        maxTableCells: 250_000,
      },
      abortSignal: controller.signal,
    });
    const rendered = await ast.to("text", {
      includeFormatting: false,
      includeImages: true,
      textConfig: { preserveLayout: true, renderNotes: true },
    });
    const value = typeof rendered.value === "string" ? rendered.value : JSON.stringify(rendered.value);
    const ocr = (ast.attachments || [])
      .map(attachment => attachment.ocrText || "")
      .filter(Boolean)
      .join("\n\n");
    return { text: value.slice(0, MAX_TEXT_BYTES).trim(), ocr: ocr.slice(0, MAX_TEXT_BYTES).trim() };
  } finally {
    clearTimeout(timer);
  }
}

function isImage(contentType: string | null, name: string | null): boolean {
  return Boolean(contentType?.startsWith("image/")) || [".png", ".jpg", ".jpeg", ".gif", ".webp"].includes(extensionFor(contentType, name));
}

function retryAt(attempts: number): string {
  const seconds = Math.min(3600, 30 * 2 ** Math.max(0, attempts - 1));
  return new Date(Date.now() + seconds * 1000).toISOString();
}


/** Atomically reserve one successful-description slot for today. Release it on failure. */
function reserveVisionDescription(): boolean {
  const db = getDb();
  const cfg = resolveVisionConfig();
  if (cfg.dailyBudget <= 0) return true;
  return db.transaction(() => {
    const day = today();
    const row = db.prepare("SELECT descriptions FROM vision_usage WHERE day = ?").get(day) as { descriptions: number } | undefined;
    if ((row?.descriptions ?? 0) >= cfg.dailyBudget) return false;
    db.prepare(`
      INSERT INTO vision_usage (day, descriptions, updated_at)
      VALUES (?, 1, datetime('now'))
      ON CONFLICT(day) DO UPDATE SET descriptions = descriptions + 1, updated_at = datetime('now')
    `).run(day);
    return true;
  })();
}

function releaseVisionDescription(): void {
  const cfg = resolveVisionConfig();
  if (cfg.dailyBudget <= 0) return;
  getDb().prepare("UPDATE vision_usage SET descriptions = max(0, descriptions - 1), updated_at=datetime('now') WHERE day = ?").run(today());
}

interface ClaimedAttachmentJob extends AttachmentRow {
  attempts: number;
  refresh_attempts: number;
}

function claimAttachmentJob(): ClaimedAttachmentJob | undefined {
  const db = getDb();
  return db.transaction(() => {
    const row = db.prepare(`
      SELECT r.*, j.attempts, j.refresh_attempts
      FROM attachment_jobs j JOIN attachment_records r ON r.id = j.attachment_id
      WHERE j.attempts < ? AND j.refresh_attempts < ? AND (
        j.status = 'pending' OR
        (j.status = 'failed' AND (j.next_retry_at IS NULL OR datetime(j.next_retry_at) <= datetime('now')))
      )
      ORDER BY j.created_at, j.attachment_id LIMIT 1
    `).get(MAX_ATTACHMENT_ATTEMPTS, MAX_REFRESH_ATTEMPTS) as ClaimedAttachmentJob | undefined;
    if (!row) return undefined;
    db.prepare("UPDATE attachment_jobs SET status='processing', updated_at=datetime('now') WHERE attachment_id=?").run(row.id);
    db.prepare("UPDATE attachment_records SET status='processing', updated_at=datetime('now') WHERE id=?").run(row.id);
    return row;
  })();
}

async function processOneAttachmentJob(): Promise<"completed" | "failed" | "none"> {
  const db = getDb();
  const job = claimAttachmentJob();
  if (!job) return "none";
  try {
    const downloaded = await downloadAttachment(job);
    db.prepare("UPDATE attachment_records SET local_path=?, content_type=?, size_bytes=?, content_hash=?, updated_at=datetime('now') WHERE id=?")
      .run(downloaded.path, downloaded.contentType, downloaded.size, downloaded.hash, job.id);

    const failures: string[] = [];
    let refreshableFailure: RefreshableAttachmentError | undefined;
    if (isImage(downloaded.contentType, job.original_name)) {
      if (job.ocr_status !== "complete") {
        try {
          const value = await imageOcr(downloaded.path);
          db.prepare("UPDATE attachment_records SET ocr_text=?, ocr_status='complete', updated_at=datetime('now') WHERE id=?").run(value || null, job.id);
        } catch (error) {
          const message = `OCR: ${String(error)}`;
          db.prepare("UPDATE attachment_records SET ocr_status='failed', last_error=?, updated_at=datetime('now') WHERE id=?").run(message.slice(0, 2000), job.id);
          failures.push(message);
        }
      }

      if (job.vision_status !== "complete" && job.vision_status !== "skipped") {
        const cfg = resolveVisionConfig();
        // A model-generated image is skipped alongside the disabled/oversized cases: the prompt
        // that produced it is already an indexed part of the conversation and states the intent
        // better than a post-hoc reading of the result. OCR still runs — it is local and free.
        const skipVision = job.relation === "generated"
          || !cfg.enabled
          || downloaded.size > cfg.maxImageBytes;
        if (skipVision) {
          db.prepare("UPDATE attachment_records SET vision_status='skipped', updated_at=datetime('now') WHERE id=?").run(job.id);
        } else if (!reserveVisionDescription()) {
          refreshableFailure = new RefreshableAttachmentError("daily vision budget exhausted; retry after budget reset", false, 24 * 60 * 60 * 1000);
        } else {
          try {
            const value = await describeImage(downloaded.path, downloaded.contentType);
            db.prepare("UPDATE attachment_records SET visual_description=?, vision_status='complete', updated_at=datetime('now') WHERE id=?").run(value, job.id);
          } catch (error) {
            releaseVisionDescription();
            const message = `vision: ${String(error)}`;
            db.prepare("UPDATE attachment_records SET vision_status='failed', last_error=?, updated_at=datetime('now') WHERE id=?").run(message.slice(0, 2000), job.id);
            failures.push(message);
          }
        }
      }
      db.prepare("UPDATE attachment_records SET extract_status='complete' WHERE id=?").run(job.id);
    } else if (job.extract_status !== "complete") {
      try {
        const document = await extractDocument(downloaded.path, downloaded.contentType, job.original_name);
        db.prepare("UPDATE attachment_records SET extracted_text=?, ocr_text=?, extract_status='complete', ocr_status='complete', vision_status='complete', updated_at=datetime('now') WHERE id=?")
          .run(document.text || null, document.ocr || null, job.id);
      } catch (error) {
        const message = `document extraction: ${String(error)}`;
        db.prepare("UPDATE attachment_records SET extract_status='failed', last_error=?, updated_at=datetime('now') WHERE id=?").run(message.slice(0, 2000), job.id);
        failures.push(message);
      }
    }

    indexAttachmentRow(db.prepare("SELECT * FROM attachment_records WHERE id=?").get(job.id) as AttachmentRow);
    if (refreshableFailure) throw refreshableFailure;
    if (failures.length > 0) throw new Error(`attachment analysis incomplete: ${failures.join("; ")}`);
    db.transaction(() => {
      db.prepare("UPDATE attachment_records SET status='complete', last_error=NULL, updated_at=datetime('now') WHERE id=?").run(job.id);
      db.prepare("UPDATE attachment_jobs SET status='complete', next_retry_at=NULL, last_error=NULL, refresh_attempts=0, updated_at=datetime('now') WHERE attachment_id=?").run(job.id);
    })();
    return "completed";
  } catch (error) {
    const message = (error as Error).message.slice(0, 2000);
    const refreshableError = error instanceof RefreshableAttachmentError ? error : undefined;
    const refreshable = Boolean(refreshableError);
    const attempts = job.attempts + (refreshable ? 0 : 1);
    const refreshAttempts = job.refresh_attempts + (refreshableError?.countAttempt ? 1 : 0);
    const exhausted = attempts >= MAX_ATTACHMENT_ATTEMPTS || refreshAttempts >= MAX_REFRESH_ATTEMPTS;
    const nextRetry = refreshableError?.retryDelayMs
      ? new Date(Date.now() + refreshableError.retryDelayMs).toISOString()
      : retryAt(refreshable ? Math.max(1, refreshAttempts) : attempts);
    db.transaction(() => {
      db.prepare("UPDATE attachment_jobs SET status='failed', attempts=?, refresh_attempts=?, next_retry_at=?, last_error=?, updated_at=datetime('now') WHERE attachment_id=?")
        .run(attempts, refreshAttempts, exhausted ? null : nextRetry, message, job.id);
      db.prepare("UPDATE attachment_records SET status='failed', last_error=?, updated_at=datetime('now') WHERE id=?").run(message, job.id);
    })();
    logger.warn({ attachmentId: job.id, attempts, refreshAttempts, refreshable, exhausted, err: message }, "attachment indexing job failed");
    return "failed";
  }
}

export async function processAttachmentJobs(limit = 2): Promise<{ completed: number; failed: number; remaining: number; exhausted: number }> {
  const db = getDb();
  db.prepare(`
    UPDATE attachment_jobs SET status = 'failed', next_retry_at = datetime('now'),
      last_error = COALESCE(last_error, 'worker interrupted'), updated_at = datetime('now')
    WHERE status = 'processing' AND updated_at < datetime('now', '-20 minutes')
  `).run();
  const outcomes = await Promise.all(Array.from({ length: Math.max(0, limit) }, () => processOneAttachmentJob()));
  const completed = outcomes.filter(value => value === "completed").length;
  const failed = outcomes.filter(value => value === "failed").length;
  const remaining = (db.prepare(`
    SELECT count(*) AS c FROM attachment_jobs
    WHERE status IN ('pending', 'processing') OR
      (status = 'failed' AND attempts < ? AND refresh_attempts < ?)
  `).get(MAX_ATTACHMENT_ATTEMPTS, MAX_REFRESH_ATTEMPTS) as { c: number }).c;
  const exhausted = (db.prepare(`
    SELECT count(*) AS c FROM attachment_jobs
    WHERE status = 'failed' AND (attempts >= ? OR refresh_attempts >= ?)
  `).get(MAX_ATTACHMENT_ATTEMPTS, MAX_REFRESH_ATTEMPTS) as { c: number }).c;
  return { completed, failed, remaining, exhausted };
}

export interface AttachmentGcReport {
  scannedFiles: number;
  referencedFiles: number;
  orphanFiles: number;
  orphanBytes: number;
  deletedFiles: number;
  dryRun: boolean;
}

function collectReferencedLocalPaths(): Set<string> {
  const refs = new Set<string>();
  for (const row of getDb().prepare("SELECT local_path FROM attachment_records WHERE local_path IS NOT NULL").all() as Array<{ local_path: string }>) {
    refs.add(resolve(row.local_path));
  }
  const visitJson = (dir: string): void => {
    if (!statSafe(dir)?.isDirectory()) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = resolve(dir, entry.name);
      if (entry.isDirectory()) visitJson(path);
      else if (entry.isFile() && entry.name.endsWith(".json")) {
        try {
          const text = readFileSync(path, "utf8");
          const parsed = JSON.parse(text) as unknown;
          const walk = (value: unknown): void => {
            if (!value || typeof value !== "object") return;
            if (Array.isArray(value)) { for (const item of value) walk(item); return; }
            const obj = value as Record<string, unknown>;
            if (typeof obj.localPath === "string") refs.add(resolve(obj.localPath));
            for (const child of Object.values(obj)) walk(child);
          };
          walk(parsed);
        } catch { /* corrupt/non-session JSON is not authoritative for deletion */ }
      }
    }
  };
  visitJson(SESSIONS_DIR);
  visitJson(ARCHIVE_DIR);
  return refs;
}

function statSafe(path: string): ReturnType<typeof statSync> | undefined {
  try { return statSync(path); } catch { return undefined; }
}

/** Delete only unreferenced attachment-index files older than retentionDays. Dry-run by default. */
export function collectAttachmentGarbage(options: { retentionDays?: number; dryRun?: boolean } = {}): AttachmentGcReport {
  const retentionDays = Math.max(1, Math.floor(options.retentionDays ?? 30));
  const dryRun = options.dryRun !== false;
  const root = ATTACHMENT_INDEX_DIR;
  const refs = collectReferencedLocalPaths();
  const cutoff = Date.now() - retentionDays * 86_400_000;
  const report: AttachmentGcReport = { scannedFiles: 0, referencedFiles: 0, orphanFiles: 0, orphanBytes: 0, deletedFiles: 0, dryRun };
  const walk = (dir: string): void => {
    const info = statSafe(dir);
    if (!info?.isDirectory()) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "ocr-cache") walk(path);
        continue;
      }
      if (!entry.isFile()) continue;
      report.scannedFiles++;
      if (refs.has(path)) { report.referencedFiles++; continue; }
      const file = statSafe(path);
      if (!file || file.mtimeMs > cutoff) continue;
      report.orphanFiles++;
      report.orphanBytes += Number(file.size);
      if (!dryRun) { unlinkSync(path); report.deletedFiles++; }
    }
  };
  walk(root);
  return report;
}

let workerTimer: NodeJS.Timeout | undefined;
let workerRunning = false;

export function startAttachmentIndexWorker(intervalMs = 15_000, batchSize?: number): void {
  if (workerTimer) return;
  const effectiveBatchSize = batchSize ?? loadConfig().attachment_analysis.concurrency;
  const tick = async () => {
    if (workerRunning) return;
    workerRunning = true;
    try {
      const result = await processAttachmentJobs(effectiveBatchSize);
      if (result.completed || result.failed) logger.info(result, "attachment index worker batch finished");
    } catch (error) {
      logger.error({ err: error }, "attachment index worker tick failed");
    } finally {
      workerRunning = false;
    }
  };
  void tick();
  workerTimer = setInterval(() => { void tick(); }, Math.max(2_000, intervalMs));
  workerTimer.unref?.();
}

export function stopAttachmentIndexWorker(): void {
  if (workerTimer) clearInterval(workerTimer);
  workerTimer = undefined;
  if (ocrWorkerPromise) {
    void ocrWorkerPromise.then(worker => worker.terminate()).catch(() => {});
    ocrWorkerPromise = undefined;
  }
  void OfficeParser.terminateOcr().catch(() => {});
}
