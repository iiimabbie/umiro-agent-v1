import { createHash } from "node:crypto";
import { getDb, SEARCH_DOCUMENT_VEC_TABLE } from "./db.js";
import { embed, getEmbedKeys } from "./embedding.js";
import { logger } from "./logger.js";
import { toSearchTokens } from "./utils/cjk.js";
import {
  buildFilterPlan,
  planToSqlFilters,
  rowPassesPlan,
  type FilterPlan,
} from "./utils/search-filter-plan.js";

/**
 * Model for the unified search index. Its vectors are only comparable with other vectors
 * from the same model, so changing this requires discarding `search_document_embeddings`
 * and the vec table and re-embedding; `search_document_embeddings.model` records which
 * model produced each stored vector.
 */
export const SEARCH_EMBED_MODEL = "gemini-embedding-2";
export const SEARCH_EMBED_DIMENSIONS = 3072;
const MAX_EMBED_ATTEMPTS = 5;
/**
 * Source types deliberately kept out of the vector index. Upstream embedding quota is the
 * scarce resource, so it is not spent on documents whose vectors nothing reads. All of them
 * stay in FTS and remain findable by keyword.
 *
 * Tool activity is excluded in both of its indexed forms. Nobody searches by meaning for which
 * tool ran; they search for a command, a path or an error, which is keyword work. Whatever
 * mattered in a tool's output is restated in the reply that followed it, and that reply is
 * an embedded session message — so a tool vector is a second, worse copy of something the
 * conversation already carries, competing with it for the same result slots.
 *
 * - `tool_call`: the arguments a tool was invoked with — shell scripts, code and JSON, whose
 *   vectors cluster by syntax rather than by intent.
 * - `tool_evidence_summary`: a bounded excerpt of the output, one per tool event. This is the
 *   only searchable form of a tool's output; raw results are not indexed at all, because the
 *   excerpt already carries what a keyword search needs and the full text is an order of
 *   magnitude larger than every other source combined.
 *
 * `owner` and `memory` are excluded for the opposite reason: `OWNER.md` and `MEMORY.md` are
 * inlined into the system prompt unconditionally on every turn, so a vector can only return
 * what the reader is already holding. Auto recall excludes them by source type as well, and
 * section splitting turns a bare heading into its own document, which is the worst value per
 * request in an index billed per request rather than per character.
 *
 * `PEOPLE.md` is not on that list: it exceeds `prompt.peopleInlineLimit`, so the prompt carries
 * an index rather than the text, and `memory_search` is a real reader of its vectors.
 */
const NON_EMBEDDED_SOURCE_TYPES = new Set<SearchSourceType>([
  "tool_call", "tool_evidence_summary",
  "owner", "memory",
]);

export function shouldEmbedSource(sourceType: SearchSourceType): boolean {
  return !NON_EMBEDDED_SOURCE_TYPES.has(sourceType);
}

/**
 * Quota exhaustion and upstream outages say nothing about the document being embedded, so
 * they must not consume its `MAX_EMBED_ATTEMPTS` budget: one quota wall would otherwise
 * bury the entire backlog past the limit and those documents would never be embedded again.
 * Such failures roll the attempt back and retry indefinitely; only errors the document can
 * never recover from (malformed request, wrong dimensions) count towards the budget.
 */
const QUOTA_COOLDOWN_MIN_MS = 60_000;
const QUOTA_COOLDOWN_MAX_MS = 3_600_000;
const TRANSIENT_RETRY_SECONDS = 300;
/**
 * Conservative initial ceiling on cumulative nearest-neighbour rows scanned by the
 * progressive-k vector pass. It bounds worst-case local work while still allowing growth
 * past the first visibility cliff; deployments can tune it from local benchmark/telemetry
 * via UnifiedSearchOptions.vectorScanBudget.
 */
const DEFAULT_VECTOR_SCAN_BUDGET = 2_000;

export type SearchSourceType =
  | "session_message"
  | "conversation_window"
  | "compact_summary"
  | "tool_call"
  | "tool_evidence_summary"
  | "diary"
  | "people"
  | "memory"
  | "owner"
  | "attachment";

export interface SearchDocumentInput {
  id: string;
  sourceType: SearchSourceType;
  sourceId: string;
  parentId?: string;
  sessionId?: string;
  channelId?: string;
  visibilityScope: string;
  ordinal?: number;
  role?: string;
  text: string;
  occurredAt?: string;
}

export interface IngestOptions {
  removeMissingForSource?: boolean;
}

export interface IngestResult {
  inserted: number;
  updated: number;
  unchanged: number;
  removed: number;
  skipped: number;
}

export interface EmbeddingWorkerResult {
  completed: number;
  failed: number;
  /** Jobs deferred by quota or upstream outage. They keep their retry budget intact. */
  throttled: number;
  remaining: number;
  exhausted: number;
}

export interface SearchIndexIntegrityReport {
  documents: number;
  ftsRowsBefore: number;
  ftsRowsAfter: number;
  orphanFtsRemoved: number;
  orphanVectorsRemoved: number;
  embeddingsRequeued: number;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function createSearchDocumentId(...parts: Array<string | number | undefined>): string {
  return sha256(parts.map(part => String(part ?? "")).join("\u001f"));
}

export function redactSecrets(text: string): string {
  return text
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, "$1[REDACTED]")
    .replace(/(["']?)(api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|passwd|authorization|cookie)\1\s*[:=]\s*(["']?)([^\s,;"']{4,}|[^"']{4,})\3/gi, (_match, quote, key) => `${quote || ""}${key}${quote || ""}=[REDACTED]`)
    .replace(/([?&](?:key|api_key|access_token|token|signature|sig)=)[^&#\s]+/gi, "$1[REDACTED]")
    .replace(/\b(?:ghp|github_pat|sk|AIza)[A-Za-z0-9_-]{12,}\b/g, "[REDACTED]")
    .replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g, "[REDACTED PRIVATE KEY]");
}

function normalizeText(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n").trim();
}

function deleteRowsByRowids(rowids: number[]): void {
  if (rowids.length === 0) return;
  const db = getDb();
  const placeholders = rowids.map(() => "?").join(",");
  db.prepare(`DELETE FROM ${SEARCH_DOCUMENT_VEC_TABLE} WHERE rowid IN (${placeholders})`)
    .run(...rowids.map(BigInt));
  db.prepare(`DELETE FROM search_documents_fts WHERE rowid IN (${placeholders})`).run(...rowids);
}

/**
 * Persist rebuildable search documents and atomically enqueue their embeddings.
 * This function deliberately performs no network I/O, so synchronous session
 * persistence can safely call it without fire-and-forget embedding promises.
 */
export function ingestSearchDocuments(
  inputs: SearchDocumentInput[],
  options: IngestOptions = {},
): IngestResult {
  const db = getDb();
  const result: IngestResult = { inserted: 0, updated: 0, unchanged: 0, removed: 0, skipped: 0 };
  const normalized = inputs.flatMap(input => {
    // Search projections are not the durable source of truth. Keep credentials and
    // signed URLs out of FTS, recall output, and external embedding payloads; the
    // original session/tool record remains available under its existing permissions.
    const text = normalizeText(redactSecrets(input.text));
    if (!input.id || !input.sourceType || !input.sourceId || !input.visibilityScope || !text) {
      result.skipped++;
      return [];
    }
    return [{ ...input, text, contentHash: sha256(text) }];
  });

  let removalSource: { sourceType: SearchSourceType; sourceId: string } | undefined;
  if (options.removeMissingForSource) {
    if (inputs.length === 0) {
      throw new Error("removeMissingForSource requires at least one input to identify the source");
    }
    const first = inputs[0];
    if (!first.sourceType || !first.sourceId) {
      throw new Error("removeMissingForSource requires sourceType and sourceId on every input");
    }
    if (inputs.some(doc => doc.sourceType !== first.sourceType || doc.sourceId !== first.sourceId)) {
      throw new Error("removeMissingForSource inputs must share sourceType and sourceId");
    }
    removalSource = { sourceType: first.sourceType, sourceId: first.sourceId };
  }

  const find = db.prepare(`SELECT rowid, source_type, source_id, parent_id, session_id, channel_id,
    visibility_scope, ordinal, role, text, content_hash, occurred_at FROM search_documents WHERE id = ?`);
  const insert = db.prepare(`
    INSERT INTO search_documents (
      id, source_type, source_id, parent_id, session_id, channel_id,
      visibility_scope, ordinal, role, text, content_hash, occurred_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const update = db.prepare(`
    UPDATE search_documents SET
      source_type = ?, source_id = ?, parent_id = ?, session_id = ?, channel_id = ?,
      visibility_scope = ?, ordinal = ?, role = ?, text = ?, content_hash = ?,
      occurred_at = ?, updated_at = datetime('now'), embedding_status = 'pending'
    WHERE id = ?
  `);
  const insertFts = db.prepare(`
    INSERT INTO search_documents_fts
      (rowid, text, source_type, source_id, session_id, visibility_scope)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const enqueue = db.prepare(`
    INSERT INTO embedding_jobs (document_id, content_hash, status, attempts, next_retry_at, last_error, updated_at)
    VALUES (?, ?, 'pending', 0, NULL, NULL, datetime('now'))
    ON CONFLICT(document_id) DO UPDATE SET
      content_hash = excluded.content_hash,
      status = 'pending', attempts = 0, next_retry_at = NULL, last_error = NULL,
      updated_at = datetime('now')
  `);
  const markSkipped = db.prepare("UPDATE search_documents SET embedding_status = 'skipped' WHERE id = ?");
  const dropJob = db.prepare("DELETE FROM embedding_jobs WHERE document_id = ?");
  const removeEmbeddingMeta = db.prepare("DELETE FROM search_document_embeddings WHERE document_id = ?");

  /** Queue the document for embedding, or record that it is intentionally never embedded. */
  const scheduleEmbedding = (id: string, sourceType: SearchSourceType, contentHash: string): void => {
    if (shouldEmbedSource(sourceType)) {
      enqueue.run(id, contentHash);
      return;
    }
    dropJob.run(id);
    markSkipped.run(id);
  };
  const updateMetadata = db.prepare(`
    UPDATE search_documents SET source_type=?, source_id=?, parent_id=?, session_id=?, channel_id=?,
      visibility_scope=?, ordinal=?, role=?, occurred_at=?, updated_at=datetime('now') WHERE id=?
  `);

  db.transaction(() => {
    for (const doc of normalized) {
      const existing = find.get(doc.id) as ({ rowid: number; source_type: string; source_id: string;
        parent_id: string | null; session_id: string | null; channel_id: string | null;
        visibility_scope: string; ordinal: number | null; role: string | null; text: string;
        content_hash: string; occurred_at: string | null } | undefined);
      if (!existing) {
        const rowid = Number(insert.run(
          doc.id, doc.sourceType, doc.sourceId, doc.parentId ?? null,
          doc.sessionId ?? null, doc.channelId ?? null, doc.visibilityScope,
          doc.ordinal ?? null, doc.role ?? null, doc.text, doc.contentHash,
          doc.occurredAt ?? null,
        ).lastInsertRowid);
        insertFts.run(rowid, toSearchTokens(doc.text), doc.sourceType, doc.sourceId, doc.sessionId ?? "", doc.visibilityScope);
        scheduleEmbedding(doc.id, doc.sourceType, doc.contentHash);
        result.inserted++;
        continue;
      }

      if (existing.content_hash === doc.contentHash) {
        const metadataChanged = existing.source_type !== doc.sourceType
          || existing.source_id !== doc.sourceId
          || existing.parent_id !== (doc.parentId ?? null)
          || existing.session_id !== (doc.sessionId ?? null)
          || existing.channel_id !== (doc.channelId ?? null)
          || existing.visibility_scope !== doc.visibilityScope
          || existing.ordinal !== (doc.ordinal ?? null)
          || existing.role !== (doc.role ?? null)
          || existing.occurred_at !== (doc.occurredAt ?? null);
        if (!metadataChanged) {
          result.unchanged++;
          continue;
        }
        updateMetadata.run(
          doc.sourceType, doc.sourceId, doc.parentId ?? null, doc.sessionId ?? null,
          doc.channelId ?? null, doc.visibilityScope, doc.ordinal ?? null,
          doc.role ?? null, doc.occurredAt ?? null, doc.id,
        );
        db.prepare("DELETE FROM search_documents_fts WHERE rowid = ?").run(existing.rowid);
        insertFts.run(existing.rowid, toSearchTokens(doc.text), doc.sourceType, doc.sourceId, doc.sessionId ?? "", doc.visibilityScope);
        result.updated++;
        continue;
      }

      deleteRowsByRowids([existing.rowid]);
      removeEmbeddingMeta.run(doc.id);
      update.run(
        doc.sourceType, doc.sourceId, doc.parentId ?? null, doc.sessionId ?? null,
        doc.channelId ?? null, doc.visibilityScope, doc.ordinal ?? null,
        doc.role ?? null, doc.text, doc.contentHash, doc.occurredAt ?? null, doc.id,
      );
      insertFts.run(existing.rowid, toSearchTokens(doc.text), doc.sourceType, doc.sourceId, doc.sessionId ?? "", doc.visibilityScope);
      scheduleEmbedding(doc.id, doc.sourceType, doc.contentHash);
      result.updated++;
    }

    if (removalSource) {
      const keep = new Set(normalized.map(doc => doc.id));
      const existing = db.prepare(
        "SELECT rowid, id FROM search_documents WHERE source_type = ? AND source_id = ?",
      ).all(removalSource.sourceType, removalSource.sourceId) as Array<{ rowid: number; id: string }>;
      const stale = existing.filter(row => !keep.has(row.id));
      if (stale.length > 0) {
        deleteRowsByRowids(stale.map(row => row.rowid));
        const placeholders = stale.map(() => "?").join(",");
        db.prepare(`DELETE FROM search_documents WHERE id IN (${placeholders})`).run(...stale.map(row => row.id));
        result.removed += stale.length;
      }
    }
  })();

  return result;
}

export function removeSearchDocumentsForSource(sourceType: SearchSourceType, sourceId: string): number {
  const db = getDb();
  return db.transaction(() => {
    const rows = db.prepare(
      "SELECT rowid FROM search_documents WHERE source_type = ? AND source_id = ?",
    ).all(sourceType, sourceId) as Array<{ rowid: number }>;
    if (rows.length === 0) return 0;
    deleteRowsByRowids(rows.map(row => row.rowid));
    db.prepare("DELETE FROM search_documents WHERE source_type = ? AND source_id = ?")
      .run(sourceType, sourceId);
    return rows.length;
  })();
}

/** Rebuild FTS and repair orphaned/incomplete vector projections from durable documents. */
export function repairSearchIndexProjections(): SearchIndexIntegrityReport {
  const db = getDb();
  return db.transaction(() => {
    const documents = db.prepare(`
      SELECT rowid, id, text, source_type, source_id, session_id, visibility_scope, content_hash, embedding_status
      FROM search_documents ORDER BY rowid
    `).all() as Array<{
      rowid: number; id: string; text: string; source_type: SearchSourceType; source_id: string;
      session_id: string | null; visibility_scope: string; content_hash: string; embedding_status: string;
    }>;
    const validRowids = new Set(documents.map(document => document.rowid));
    const ftsRowsBefore = (db.prepare("SELECT count(*) AS c FROM search_documents_fts").get() as { c: number }).c;
    const orphanFtsRemoved = (db.prepare(`
      SELECT count(*) AS c FROM search_documents_fts f
      LEFT JOIN search_documents d ON d.rowid = f.rowid
      WHERE d.rowid IS NULL
    `).get() as { c: number }).c;

    db.exec("DELETE FROM search_documents_fts");
    const insertFts = db.prepare(`
      INSERT INTO search_documents_fts (rowid, text, source_type, source_id, session_id, visibility_scope)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const document of documents) {
      insertFts.run(
        document.rowid, toSearchTokens(document.text), document.source_type, document.source_id,
        document.session_id ?? "", document.visibility_scope,
      );
    }

    const vectorRows = db.prepare(`SELECT rowid FROM ${SEARCH_DOCUMENT_VEC_TABLE}`).all() as Array<{ rowid: number | bigint }>;
    const vectorRowids = new Set(vectorRows.map(row => Number(row.rowid)));
    let orphanVectorsRemoved = 0;
    for (const rowid of vectorRowids) {
      if (validRowids.has(rowid)) continue;
      db.prepare(`DELETE FROM ${SEARCH_DOCUMENT_VEC_TABLE} WHERE rowid = ?`).run(BigInt(rowid));
      orphanVectorsRemoved++;
    }

    const embeddingRows = db.prepare("SELECT document_id, document_rowid FROM search_document_embeddings").all() as Array<{ document_id: string; document_rowid: number }>;
    const embeddingByDocument = new Map(embeddingRows.map(row => [row.document_id, row.document_rowid]));
    const enqueue = db.prepare(`
      INSERT INTO embedding_jobs (document_id, content_hash, status, attempts, next_retry_at, last_error, updated_at)
      VALUES (?, ?, 'pending', 0, NULL, NULL, datetime('now'))
      ON CONFLICT(document_id) DO UPDATE SET
        content_hash=excluded.content_hash, status='pending', attempts=0, next_retry_at=NULL,
        last_error=NULL, updated_at=datetime('now')
    `);
    let embeddingsRequeued = 0;
    for (const document of documents) {
      if (document.embedding_status !== "complete") continue;
      const metadataRowid = embeddingByDocument.get(document.id);
      const projectionComplete = metadataRowid === document.rowid && vectorRowids.has(document.rowid);
      if (projectionComplete) continue;
      db.prepare(`DELETE FROM ${SEARCH_DOCUMENT_VEC_TABLE} WHERE rowid = ?`).run(BigInt(document.rowid));
      db.prepare("DELETE FROM search_document_embeddings WHERE document_id = ?").run(document.id);
      db.prepare("UPDATE search_documents SET embedding_status='pending', updated_at=datetime('now') WHERE id=?").run(document.id);
      enqueue.run(document.id, document.content_hash);
      embeddingsRequeued++;
    }

    const ftsRowsAfter = (db.prepare("SELECT count(*) AS c FROM search_documents_fts").get() as { c: number }).c;
    return {
      documents: documents.length, ftsRowsBefore, ftsRowsAfter, orphanFtsRemoved,
      orphanVectorsRemoved, embeddingsRequeued,
    };
  })();
}

function vectorToBlob(vector: number[]): Buffer {
  return Buffer.from(new Float32Array(vector).buffer);
}

function retryAt(attempts: number): string {
  const seconds = Math.min(3600, 15 * 2 ** Math.max(0, attempts - 1));
  return new Date(Date.now() + seconds * 1000).toISOString();
}

type EmbedFailureKind = "quota" | "credential" | "transient" | "permanent";

/** Decide whether a failure is the document's fault, the key's, or the infrastructure's. */
function classifyEmbedFailure(message: string): EmbedFailureKind {
  if (message.startsWith("unexpected embedding dimensions")) return "permanent";
  const status = Number(/^Embedding API (\d{3}):/.exec(message)?.[1]);
  // fetch aborts and network resets carry no HTTP status; they are always retryable.
  if (!Number.isFinite(status)) return "transient";
  if (status === 429) return "quota";
  // A rejected or unauthorised key says nothing about the document: bench the key and let
  // the other lanes carry on, rather than spending the document's retry budget on it.
  if (status === 401 || status === 403) return "credential";
  if (status >= 500) return "transient";
  return "permanent";
}

/**
 * Per-key quota state. Each API key has its own upstream quota, so a key that hits 429 is
 * benched on its own while the remaining keys keep draining the backlog; the worker only
 * pauses once every key is cooling down.
 */
const keyCooldowns = new Map<string, { until: number; ms: number }>();

function readyKeys(): string[] {
  const now = Date.now();
  return getEmbedKeys().filter(key => (keyCooldowns.get(key)?.until ?? 0) <= now);
}

function benchKey(key: string): number {
  const state = keyCooldowns.get(key) ?? { until: 0, ms: QUOTA_COOLDOWN_MIN_MS };
  const ms = state.ms;
  keyCooldowns.set(key, { until: Date.now() + ms, ms: Math.min(QUOTA_COOLDOWN_MAX_MS, ms * 2) });
  return ms;
}

function clearKeyCooldown(key: string): void {
  keyCooldowns.set(key, { until: 0, ms: QUOTA_COOLDOWN_MIN_MS });
}

function countJobBacklog(db: ReturnType<typeof getDb>): { remaining: number; exhausted: number } {
  const remaining = (db.prepare(`
    SELECT count(*) AS c FROM embedding_jobs
    WHERE status IN ('pending', 'processing') OR (status = 'failed' AND attempts < ?)
  `).get(MAX_EMBED_ATTEMPTS) as { c: number }).c;
  const exhausted = (db.prepare(`
    SELECT count(*) AS c FROM embedding_jobs WHERE status = 'failed' AND attempts >= ?
  `).get(MAX_EMBED_ATTEMPTS) as { c: number }).c;
  return { remaining, exhausted };
}

/**
 * Queue order for the embedding outbox. Upstream quota, not local work, is the binding
 * constraint, so the budget is spent on the documents recall benefits from most: durable
 * facts and diary first, conversation next, and bulky tool bookkeeping last. Plain FIFO
 * would sink a workspace's memory and diary behind thousands of tool-call documents.
 */
const EMBED_PRIORITY_SQL = `CASE d.source_type
  WHEN 'people' THEN 0
  WHEN 'diary' THEN 1
  WHEN 'compact_summary' THEN 2
  WHEN 'session_message' THEN 3 WHEN 'conversation_window' THEN 3
  WHEN 'attachment' THEN 4
  WHEN 'tool_evidence_summary' THEN 5
  ELSE 6 END`;

interface ClaimedJob {
  document_id: string;
  content_hash: string;
  attempts: number;
  rowid: number;
  text: string;
}

/**
 * Atomically take the next ready job. better-sqlite3 is synchronous, so this transaction
 * cannot interleave with a concurrent lane's claim and no job is ever handed out twice.
 */
function claimJob(db: ReturnType<typeof getDb>): ClaimedJob | undefined {
  return db.transaction(() => {
    const row = db.prepare(`
      SELECT j.document_id, j.content_hash, j.attempts, d.rowid, d.text
      FROM embedding_jobs j
      JOIN search_documents d ON d.id = j.document_id
      WHERE j.attempts < ?
        AND (j.status = 'pending' OR (j.status = 'failed' AND (j.next_retry_at IS NULL OR datetime(j.next_retry_at) <= datetime('now'))))
      ORDER BY ${EMBED_PRIORITY_SQL}, j.created_at, j.document_id
      LIMIT 1
    `).get(MAX_EMBED_ATTEMPTS) as ClaimedJob | undefined;
    if (!row) return undefined;
    db.prepare(`
      UPDATE embedding_jobs SET status = 'processing', attempts = attempts + 1,
        updated_at = datetime('now') WHERE document_id = ?
    `).run(row.document_id);
    db.prepare("UPDATE search_documents SET embedding_status = 'processing' WHERE id = ?").run(row.document_id);
    return { ...row, attempts: row.attempts + 1 };
  })();
}

function storeEmbedding(db: ReturnType<typeof getDb>, job: ClaimedJob, vector: number[]): void {
  const blob = vectorToBlob(vector);
  db.transaction(() => {
    const current = db.prepare("SELECT content_hash, rowid FROM search_documents WHERE id = ?").get(job.document_id) as { content_hash: string; rowid: number } | undefined;
    if (!current || current.content_hash !== job.content_hash) {
      db.prepare("UPDATE embedding_jobs SET status = 'pending', updated_at = datetime('now') WHERE document_id = ?").run(job.document_id);
      return;
    }
    db.prepare(`DELETE FROM ${SEARCH_DOCUMENT_VEC_TABLE} WHERE rowid = ?`).run(BigInt(current.rowid));
    db.prepare(`INSERT INTO ${SEARCH_DOCUMENT_VEC_TABLE} (rowid, embedding) VALUES (?, ?)`).run(BigInt(current.rowid), blob);
    db.prepare(`
      INSERT INTO search_document_embeddings
        (document_id, document_rowid, model, dimensions, content_hash, embedded_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(document_id) DO UPDATE SET
        document_rowid = excluded.document_rowid, model = excluded.model,
        dimensions = excluded.dimensions, content_hash = excluded.content_hash,
        embedded_at = datetime('now')
    `).run(job.document_id, current.rowid, SEARCH_EMBED_MODEL, SEARCH_EMBED_DIMENSIONS, job.content_hash);
    db.prepare("UPDATE embedding_jobs SET status = 'complete', next_retry_at = NULL, last_error = NULL, updated_at = datetime('now') WHERE document_id = ?").run(job.document_id);
    db.prepare("UPDATE search_documents SET embedding_status = 'complete', updated_at = datetime('now') WHERE id = ?").run(job.document_id);
  })();
}

interface LaneTally { completed: number; failed: number; throttled: number }

/**
 * Drain up to `budget` jobs using one API key. Returns as soon as the key is benched or the
 * queue runs dry, so the other lanes are never blocked by this key's quota.
 */
async function runLane(db: ReturnType<typeof getDb>, apiKey: string, budget: number): Promise<LaneTally> {
  const tally: LaneTally = { completed: 0, failed: 0, throttled: 0 };

  for (let i = 0; i < budget; i++) {
    const job = claimJob(db);
    if (!job) break;

    try {
      const vector = await embed(redactSecrets(job.text), apiKey, SEARCH_EMBED_MODEL);
      if (vector.length !== SEARCH_EMBED_DIMENSIONS) {
        throw new Error(`unexpected embedding dimensions: ${vector.length}`);
      }
      storeEmbedding(db, job, vector);
      tally.completed++;
      clearKeyCooldown(apiKey);
      continue;
    } catch (error) {
      const message = (error as Error).message.slice(0, 2000);
      const kind = classifyEmbedFailure(message);

      if (kind === "permanent") {
        const exhausted = job.attempts >= MAX_EMBED_ATTEMPTS;
        db.transaction(() => {
          db.prepare(`
            UPDATE embedding_jobs SET status = 'failed', next_retry_at = ?, last_error = ?, updated_at = datetime('now')
            WHERE document_id = ?
          `).run(exhausted ? null : retryAt(job.attempts), message, job.document_id);
          db.prepare("UPDATE search_documents SET embedding_status = 'failed', updated_at = datetime('now') WHERE id = ?").run(job.document_id);
        })();
        logger.warn({ documentId: job.document_id, attempts: job.attempts, err: message }, "search embedding job failed");
        tally.failed++;
        continue;
      }

      // Give the attempt back: the claim already incremented it, but neither a quota wall
      // nor an upstream outage is evidence that this document can never be embedded.
      const benched = kind === "quota" || kind === "credential";
      const cooldownMs = benched ? benchKey(apiKey) : 0;
      const retrySeconds = benched ? Math.round(cooldownMs / 1000) : TRANSIENT_RETRY_SECONDS;
      db.transaction(() => {
        db.prepare(`
          UPDATE embedding_jobs SET status = 'failed', attempts = MAX(0, attempts - 1),
            next_retry_at = ?, last_error = ?, updated_at = datetime('now')
          WHERE document_id = ?
        `).run(new Date(Date.now() + retrySeconds * 1000).toISOString(), message, job.document_id);
        db.prepare("UPDATE search_documents SET embedding_status = 'pending', updated_at = datetime('now') WHERE id = ?").run(job.document_id);
      })();
      tally.throttled++;

      if (benched) {
        logger.warn(
          { documentId: job.document_id, cooldownMs, reason: kind },
          kind === "quota" ? "embedding key quota exhausted, benching key" : "embedding key rejected, benching key",
        );
        break;
      }
    }
  }

  return tally;
}

/** Process durable embedding jobs. Safe to call repeatedly and after restart. */
export async function processEmbeddingJobs(limit = 10): Promise<EmbeddingWorkerResult> {
  const db = getDb();

  // A previous process may have died after claiming a job. Recover it even when
  // the API key is currently unavailable, otherwise it disappears from the ready
  // count and can remain stuck in `processing` forever.
  db.prepare(`
    UPDATE embedding_jobs SET status = 'failed', next_retry_at = datetime('now'),
      last_error = COALESCE(last_error, 'worker interrupted'), updated_at = datetime('now')
    WHERE status = 'processing' AND updated_at < datetime('now', '-10 minutes')
  `).run();

  const keys = readyKeys();
  if (keys.length === 0 || limit <= 0) {
    return { completed: 0, failed: 0, throttled: 0, ...countJobBacklog(db) };
  }

  // One lane per ready key. Lanes claim from the same queue, so an idle lane simply finds
  // nothing left rather than stranding work reserved for it.
  const perLane = Math.max(1, Math.ceil(limit / keys.length));
  const tallies = await Promise.all(keys.map(key => runLane(db, key, perLane)));

  const totals = tallies.reduce<LaneTally>((acc, tally) => ({
    completed: acc.completed + tally.completed,
    failed: acc.failed + tally.failed,
    throttled: acc.throttled + tally.throttled,
  }), { completed: 0, failed: 0, throttled: 0 });

  return { ...totals, ...countJobBacklog(db) };
}

let workerTimer: NodeJS.Timeout | undefined;
let workerRunning = false;

/** Start one durable outbox worker for this process. Re-entrant calls are no-ops. */
export function startSearchIndexWorker(intervalMs = 10_000, batchSize = 20): void {
  if (workerTimer) return;
  const tick = async () => {
    if (workerRunning) return;
    workerRunning = true;
    try {
      const result = await processEmbeddingJobs(batchSize);
      if (result.completed > 0 || result.failed > 0) {
        logger.info(result, "search embedding worker batch finished");
      }
    } catch (error) {
      logger.error({ err: (error as Error).message }, "search embedding worker tick failed");
    } finally {
      workerRunning = false;
    }
  };
  void tick();
  workerTimer = setInterval(() => { void tick(); }, Math.max(1_000, intervalMs));
  workerTimer.unref?.();
}

export function stopSearchIndexWorker(): void {
  if (workerTimer) clearInterval(workerTimer);
  workerTimer = undefined;
}

export type UnifiedSearchProfile = "all" | "memory" | "session";

export interface SearchVisibilityContext {
  isOwner: boolean;
  userId?: string;
  channelId?: string;
}

export interface UnifiedSearchOptions {
  profile?: UnifiedSearchProfile;
  limit?: number;
  candidateLimit?: number;
  sourceTypes?: SearchSourceType[];
  excludeSourceTypes?: SearchSourceType[];
  excludeSourceIds?: string[];
  excludeSessionIds?: string[];
  excludeDocumentIds?: string[];
  excludeRecentDays?: number;
  visibility: SearchVisibilityContext;
  includeContext?: boolean;
  debug?: boolean;
  minVectorScore?: number;
  /**
   * Upper bound on how many vector rows sqlite-vec may scan across the progressive-k
   * expansion for one query. Caps worst-case work on large tables; when hit, the
   * vector pass returns whatever eligible rows it found and marks the result
   * `vectorTruncated` instead of expanding k unboundedly. Defaults to a conservative
   * value chosen from the large-fixture benchmark.
   */
  vectorScanBudget?: number;
}

export interface UnifiedSearchResult {
  id: string;
  sourceType: SearchSourceType;
  sourceId: string;
  parentId?: string;
  sessionId?: string;
  channelId?: string;
  visibilityScope: string;
  ordinal?: number;
  role?: string;
  text: string;
  occurredAt?: string;
  score: number;
  vectorScore?: number;
  ftsRank?: number;
  matchedBy: Array<"vector" | "fts">;
  context?: Array<{ id: string; role?: string; text: string; occurredAt?: string }>;
}

export interface UnifiedSearchResponse {
  traceId: string;
  results: UnifiedSearchResult[];
  diagnostics: {
    vectorCandidates: number;
    ftsCandidates: number;
    groupedCandidates: number;
    embeddingAvailable: boolean;
    vectorIterations: number;
    vectorFinalK: number;
    vectorScanned: number;
    vectorTruncated: boolean;
  };
}

type SearchRow = {
  rowid: number;
  id: string;
  source_type: SearchSourceType;
  source_id: string;
  parent_id: string | null;
  session_id: string | null;
  channel_id: string | null;
  visibility_scope: string;
  ordinal: number | null;
  role: string | null;
  text: string;
  content_hash: string;
  occurred_at: string | null;
};

const SESSION_SOURCE_TYPES = new Set<SearchSourceType>([
  "session_message", "conversation_window", "compact_summary",
  "tool_call", "tool_evidence_summary", "attachment",
]);
const DURABLE_SOURCE_TYPES = new Set<SearchSourceType>([
  "diary", "people", "memory", "owner",
]);

/**
 * Compile the one shared filter plan for this query. Both the SQL push-down and the
 * in-memory (context) predicate are derived from it, so visibility/source/exclusion
 * policy cannot drift between the two paths. See utils/search-filter-plan.ts.
 */
function planForOptions(options: UnifiedSearchOptions): FilterPlan {
  return buildFilterPlan({
    visibility: options.visibility,
    sourceTypes: options.sourceTypes,
    excludeSourceTypes: options.excludeSourceTypes,
    excludeSourceIds: options.excludeSourceIds,
    excludeSessionIds: options.excludeSessionIds,
    excludeDocumentIds: options.excludeDocumentIds,
    excludeRecentDays: options.excludeRecentDays,
    profileSessionTypes: SESSION_SOURCE_TYPES,
    restrictToProfileSession: options.profile === "session",
  });
}

function sourceWeight(sourceType: SearchSourceType, profile: UnifiedSearchProfile): number {
  if (profile === "session") {
    if (sourceType === "session_message") return 1.2;
    if (sourceType === "tool_evidence_summary" || sourceType === "attachment") return 1.1;
    if (sourceType === "conversation_window" || sourceType === "compact_summary") return 1.0;
    return 0.9;
  }
  if (profile === "memory") {
    if (sourceType === "people" || sourceType === "memory" || sourceType === "owner") return 1.25;
    if (sourceType === "diary") return 1.15;
    if (sourceType === "tool_evidence_summary" || sourceType === "compact_summary") return 1.05;
    if (sourceType === "conversation_window") return 0.95;
    return 0.9;
  }
  return DURABLE_SOURCE_TYPES.has(sourceType) ? 1.1 : 1.0;
}


function rowToResult(row: SearchRow): Omit<UnifiedSearchResult, "score" | "matchedBy"> {
  return {
    id: row.id,
    sourceType: row.source_type,
    sourceId: row.source_id,
    parentId: row.parent_id ?? undefined,
    sessionId: row.session_id ?? undefined,
    channelId: row.channel_id ?? undefined,
    visibilityScope: row.visibility_scope,
    ordinal: row.ordinal ?? undefined,
    role: row.role ?? undefined,
    text: row.text,
    occurredAt: row.occurred_at ?? undefined,
  };
}

function addContext(result: UnifiedSearchResult, plan: FilterPlan): void {
  if (result.sourceType !== "session_message" || !result.sessionId || result.ordinal === undefined) return;
  const rows = getDb().prepare(`
    SELECT rowid, id, source_type, source_id, parent_id, session_id, channel_id,
      visibility_scope, ordinal, role, text, content_hash, occurred_at
    FROM search_documents
    WHERE source_type = 'session_message' AND session_id = ? AND ordinal BETWEEN ? AND ?
    ORDER BY ordinal
  `).all(result.sessionId, Math.max(0, result.ordinal - 1), result.ordinal + 1) as SearchRow[];
  // Re-apply the SAME compiled plan the SQL layer used, so an excluded document /
  // session / source / recent-diary row cannot leak back in through context expansion.
  const visible = rows.filter(row => row.id !== result.id && rowPassesPlan(row, plan));
  if (visible.length > 0) {
    result.context = visible.map(row => ({
      id: row.id,
      role: row.role ?? undefined,
      text: row.text,
      occurredAt: row.occurred_at ?? undefined,
    }));
  }
}

/** Unified permission-aware hybrid search over every indexed source. */
export async function searchUnified(query: string, options: UnifiedSearchOptions): Promise<UnifiedSearchResponse> {
  const traceId = createSearchDocumentId("search-trace", Date.now(), Math.random()).slice(0, 16);
  const normalizedQuery = normalizeText(query);
  const limit = Math.min(Math.max(Math.floor(options.limit ?? 10), 1), 100);
  const candidateLimit = Math.min(Math.max(Math.floor(options.candidateLimit ?? Math.max(60, limit * 8)), limit), 500);
  const minVectorScore = Math.min(Math.max(options.minVectorScore ?? 0.55, -1), 1);
  const profile = options.profile ?? "all";
  const filterPlan = planForOptions(options);
  const db = getDb();
  const byId = new Map<string, {
    row: SearchRow;
    score: number;
    vectorScore?: number;
    ftsRank?: number;
    matchedBy: Set<"vector" | "fts">;
  }>();
  let vectorCandidates = 0;
  let ftsCandidates = 0;
  let embeddingAvailable = false;
  let vectorIterations = 0;
  let vectorFinalK = 0;
  let vectorScanned = 0;
  let vectorTruncated = false;
  const vectorScanBudget = Math.max(limit, Math.floor(options.vectorScanBudget ?? DEFAULT_VECTOR_SCAN_BUDGET));

  if (!normalizedQuery) {
    return { traceId, results: [], diagnostics: { vectorCandidates, ftsCandidates, groupedCandidates: 0, embeddingAvailable, vectorIterations, vectorFinalK, vectorScanned, vectorTruncated } };
  }

  const ftsQuery = toSearchTokens(normalizedQuery)
    .split(/\s+/)
    .filter(Boolean)
    .map(token => `"${token.replace(/"/g, '""')}"`)
    .join(" OR ");
  if (ftsQuery) {
    try {
      const sqlFilters = planToSqlFilters(filterPlan);
      const totalFts = (db.prepare(`
        SELECT count(*) AS c
        FROM search_documents_fts f
        JOIN search_documents d ON d.rowid = f.rowid
        WHERE search_documents_fts MATCH ?${sqlFilters.sql}
      `).get(ftsQuery, ...sqlFilters.params) as { c: number }).c;
      const fetchLimit = Math.min(candidateLimit, totalFts);
      const rows = db.prepare(`
        SELECT d.rowid, d.id, d.source_type, d.source_id, d.parent_id, d.session_id,
          d.channel_id, d.visibility_scope, d.ordinal, d.role, d.text, d.content_hash,
          d.occurred_at, bm25(search_documents_fts) AS lexical_score
        FROM search_documents_fts f
        JOIN search_documents d ON d.rowid = f.rowid
        WHERE search_documents_fts MATCH ?${sqlFilters.sql}
        ORDER BY lexical_score
        LIMIT ?
      `).all(ftsQuery, ...sqlFilters.params, fetchLimit) as Array<SearchRow & { lexical_score: number }>;
      ftsCandidates = rows.length;
      let rank = 0;
      for (const row of rows) {
        rank++;
        const weighted = (1 / (60 + rank)) * 1.15 * sourceWeight(row.source_type, profile);
        const current = byId.get(row.id) ?? { row, score: 0, matchedBy: new Set<"vector" | "fts">() };
        current.score += weighted;
        current.ftsRank = rank;
        current.matchedBy.add("fts");
        byId.set(row.id, current);
      }
    } catch (error) {
      logger.warn({ traceId, err: (error as Error).message }, "unified FTS search failed");
    }
  }

  // Prefer a key that is not cooling down, so one benched key does not disable query-time
  // vector recall while the others still have quota.
  const queryKey = readyKeys()[0] ?? getEmbedKeys()[0];
  if (queryKey) {
    try {
      const count = (db.prepare(`SELECT count(*) AS c FROM ${SEARCH_DOCUMENT_VEC_TABLE}`).get() as { c: number }).c;
      if (count > 0) {
        embeddingAvailable = true;
        const vector = await embed(redactSecrets(normalizedQuery), queryKey, SEARCH_EMBED_MODEL);
        const blob = vectorToBlob(vector);
        const sqlFilters = planToSqlFilters(filterPlan);
        // sqlite-vec applies k (the KNN cut) BEFORE the joined visibility/source/
        // exclusion filters, so a top-k full of private neighbours starves the visible
        // results. We progressively grow k until enough ELIGIBLE rows survive, the
        // table is exhausted, or we hit the scan budget. Never stop before at least
        // `limit` eligible rows unless one of those hard bounds is reached — that is
        // the invariant that prevents re-introducing candidate starvation.
        let k = Math.min(Math.max(candidateLimit, limit), count, vectorScanBudget);
        let rows: Array<SearchRow & { distance: number }> = [];
        for (;;) {
          vectorIterations++;
          vectorFinalK = k;
          vectorScanned += k;
          rows = db.prepare(`
            SELECT d.rowid, d.id, d.source_type, d.source_id, d.parent_id, d.session_id,
              d.channel_id, d.visibility_scope, d.ordinal, d.role, d.text, d.content_hash,
              d.occurred_at, v.distance
            FROM ${SEARCH_DOCUMENT_VEC_TABLE} v
            JOIN search_documents d ON d.rowid = v.rowid
            WHERE v.embedding MATCH ? AND k = ?${sqlFilters.sql}
          `).all(blob, k, ...sqlFilters.params) as Array<SearchRow & { distance: number }>;
          const eligible = rows.filter(row => (1 - row.distance) >= minVectorScore).length;
          if (eligible >= limit) break;
          if (k >= count) break;              // whole table scanned
          const remainingScanBudget = vectorScanBudget - vectorScanned;
          if (remainingScanBudget <= 0) { vectorTruncated = true; break; }
          const nextK = Math.min(count, Math.max(k + 1, k * 2), remainingScanBudget);
          if (nextK <= k) { vectorTruncated = true; break; }
          k = nextK;
        }
        vectorCandidates = rows.length;
        let rank = 0;
        for (const row of rows) {
          rank++;
          const vectorScore = 1 - row.distance;
          if (vectorScore < minVectorScore) continue;
          const weighted = (1 / (60 + rank)) * sourceWeight(row.source_type, profile);
          const current = byId.get(row.id) ?? { row, score: 0, matchedBy: new Set<"vector" | "fts">() };
          current.score += weighted;
          current.vectorScore = vectorScore;
          current.matchedBy.add("vector");
          byId.set(row.id, current);
        }
      }
    } catch (error) {
      logger.warn({ traceId, err: (error as Error).message }, "unified vector search failed; using FTS candidates only");
    }
  }

  const ranked = [...byId.values()].sort((a, b) => b.score - a.score);
  const grouped: typeof ranked = [];
  const perSession = new Map<string, number>();
  for (const candidate of ranked) {
    const sessionKey = candidate.row.session_id ?? "";
    const sessionCount = sessionKey ? (perSession.get(sessionKey) ?? 0) : 0;
    if (sessionKey && sessionCount >= Math.max(2, Math.ceil(limit / 3))) continue;
    if (sessionKey) perSession.set(sessionKey, sessionCount + 1);
    grouped.push(candidate);
    if (grouped.length >= limit) break;
  }

  const maxScore = grouped[0]?.score || 1;
  const results = grouped.map(candidate => ({
    ...rowToResult(candidate.row),
    score: candidate.score / maxScore,
    vectorScore: candidate.vectorScore,
    ftsRank: candidate.ftsRank,
    matchedBy: [...candidate.matchedBy],
  } satisfies UnifiedSearchResult));
  if (options.includeContext !== false) {
    for (const result of results) addContext(result, filterPlan);
  }

  const response: UnifiedSearchResponse = {
    traceId,
    results,
    diagnostics: {
      vectorCandidates,
      ftsCandidates,
      groupedCandidates: results.length,
      embeddingAvailable,
      vectorIterations,
      vectorFinalK,
      vectorScanned,
      vectorTruncated,
    },
  };
  if (options.debug) {
    logger.info({
      traceId,
      query: normalizedQuery.slice(0, 200),
      profile,
      diagnostics: response.diagnostics,
      results: results.map(result => ({
        id: result.id,
        sourceType: result.sourceType,
        sourceId: result.sourceId,
        score: Number(result.score.toFixed(4)),
        vectorScore: result.vectorScore === undefined ? undefined : Number(result.vectorScore.toFixed(4)),
        ftsRank: result.ftsRank,
      })),
    }, "unified search trace");
  }
  return response;
}
