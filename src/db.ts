import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { resolve } from "node:path";
import { WORKSPACE_CONFIG_DIR } from "./paths.js";
import { logger } from "./logger.js";
import { toSearchTokens } from "./utils/cjk.js";

const DB_PATH = process.env.UMIRO_DB_PATH ?? resolve(WORKSPACE_CONFIG_DIR, "umiro.db");

let db: Database.Database | null = null;

/**
 * 向量表名稱（cosine 版）。embedding.ts 一律走這張。
 *
 * 這張表沒有 key 欄位，靠 rowid 對應回文件——而那個 rowid 是 `search_documents.rowid`，
 * 也就是 `search_document_embeddings.document_rowid` 這一欄，**不是** embeddings 那張表
 * 自己的 rowid。兩者是不同的數列，寫成 `WHERE rowid IN (SELECT rowid FROM
 * search_document_embeddings)` 會刪掉毫不相干的向量，而且不會報錯。
 *
 * 另外 `sqlite3` CLI 載不到 vec0：碰這張表的語句會 parse error，但同一個交易裡後續的語句
 * 照跑照 commit，留下 metadata 已刪、向量還在的不一致狀態。維運要動它就整段走 Node。
 */
export const SEARCH_DOCUMENT_VEC_TABLE = "search_document_vectors_vec_cos";


function ensureColumn(database: Database.Database, table: string, column: string, definition: string): void {
  const columns = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (columns.some(item => item.name === column)) return;
  database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

/**
 * Numbered, run-once schema migrations. `schema_migrations` records the highest
 * version already applied so a migration body never runs again on later boots.
 * This replaces the previous pattern of executing a full-table `UPDATE` on every
 * process start (which rewrote every attachment row unconditionally).
 */
function hasSchemaVersion(database: Database.Database, version: number): boolean {
  database.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))");
  return Boolean(database.prepare("SELECT 1 FROM schema_migrations WHERE version = ?").get(version));
}

function markSchemaVersion(database: Database.Database, version: number): void {
  database.prepare("INSERT OR IGNORE INTO schema_migrations (version) VALUES (?)").run(version);
}

/**
 * Backfill per-stage attachment status from the coarse `status` column. Runs once
 * (migration version 1); subsequent boots skip it entirely instead of rewriting
 * every attachment_records row on each startup.
 */
function migrateAttachmentStageStatus(database: Database.Database): void {
  const SCHEMA_ATTACHMENT_STAGES = 1;
  if (hasSchemaVersion(database, SCHEMA_ATTACHMENT_STAGES)) return;
  database.transaction(() => {
    database.exec(`
      UPDATE attachment_records SET
        ocr_status = CASE WHEN status = 'complete' THEN 'complete' ELSE ocr_status END,
        vision_status = CASE WHEN status = 'complete' THEN 'complete' ELSE vision_status END,
        extract_status = CASE WHEN status = 'complete' THEN 'complete' ELSE extract_status END
    `);
    markSchemaVersion(database, SCHEMA_ATTACHMENT_STAGES);
  })();
}


/** Remove obsolete transient diary-note projections after the runtime writer is removed. */
export function migrateRemovedDiaryNotes(database: Database.Database): void {
  const SCHEMA_REMOVE_DIARY_NOTES = 2;
  if (hasSchemaVersion(database, SCHEMA_REMOVE_DIARY_NOTES)) return;
  database.transaction(() => {
    const rows = database.prepare("SELECT rowid, id FROM search_documents WHERE source_type = 'diary_note'").all() as Array<{ rowid: number; id: string }>;
    const removeVector = database.prepare(`DELETE FROM ${SEARCH_DOCUMENT_VEC_TABLE} WHERE rowid = ?`);
    const removeFts = database.prepare("DELETE FROM search_documents_fts WHERE rowid = ?");
    const removeJob = database.prepare("DELETE FROM embedding_jobs WHERE document_id = ?");
    const removeEmbedding = database.prepare("DELETE FROM search_document_embeddings WHERE document_id = ?");
    const removeDocument = database.prepare("DELETE FROM search_documents WHERE id = ?");
    for (const row of rows) {
      removeVector.run(BigInt(row.rowid));
      removeFts.run(row.rowid);
      removeJob.run(row.id);
      removeEmbedding.run(row.id);
      removeDocument.run(row.id);
    }
    markSchemaVersion(database, SCHEMA_REMOVE_DIARY_NOTES);
  })();
}

export function getDb(): Database.Database {
  if (db) return db;

  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  sqliteVec.load(db);

  // Persistent Discord button state. Flexible button/action payloads remain JSON, while
  // lifecycle fields stay queryable for atomic transitions and retention cleanup.
  db.exec(`
    CREATE TABLE IF NOT EXISTS discord_button_messages (
      id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      content TEXT NOT NULL,
      buttons_json TEXT NOT NULL,
      allowed_user_ids_json TEXT NOT NULL,
      preview_button_id TEXT,
      preview_field TEXT,
      preview_label TEXT,
      interaction_mode TEXT NOT NULL,
      disabled_button_ids_json TEXT NOT NULL DEFAULT '[]',
      button_results_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      decided_at TEXT,
      result TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS discord_button_messages_message_id
      ON discord_button_messages(message_id);
    CREATE INDEX IF NOT EXISTS discord_button_messages_status_expires
      ON discord_button_messages(status, expires_at);
  `);

  // Session archive
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_archive (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      time TEXT,
      msg_id TEXT,
      reply_to TEXT,
      archived_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // Unified search index. Source files/session JSON remain the durable truth; these
  // tables are rebuildable projections. `rowid` is the sqlite-vec/FTS join key while
  // `id` is the deterministic identity used for idempotent reconciliation.
  db.exec(`
    CREATE TABLE IF NOT EXISTS search_documents (
      rowid INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      source_type TEXT NOT NULL,
      source_id TEXT NOT NULL,
      parent_id TEXT,
      session_id TEXT,
      channel_id TEXT,
      visibility_scope TEXT NOT NULL,
      ordinal INTEGER,
      role TEXT,
      text TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      occurred_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      embedding_status TEXT NOT NULL DEFAULT 'pending'
        CHECK (embedding_status IN ('pending', 'processing', 'complete', 'failed', 'skipped'))
    );
    CREATE INDEX IF NOT EXISTS search_documents_source
      ON search_documents(source_type, source_id);
    CREATE INDEX IF NOT EXISTS search_documents_session_time
      ON search_documents(session_id, occurred_at);
    CREATE INDEX IF NOT EXISTS search_documents_content_hash
      ON search_documents(content_hash);
    CREATE INDEX IF NOT EXISTS search_documents_embedding_status
      ON search_documents(embedding_status);
    CREATE INDEX IF NOT EXISTS search_documents_visibility
      ON search_documents(visibility_scope);

    CREATE VIRTUAL TABLE IF NOT EXISTS search_documents_fts USING fts5(
      text,
      source_type UNINDEXED,
      source_id UNINDEXED,
      session_id UNINDEXED,
      visibility_scope UNINDEXED
    );

    CREATE TABLE IF NOT EXISTS search_document_embeddings (
      document_id TEXT PRIMARY KEY REFERENCES search_documents(id) ON DELETE CASCADE,
      document_rowid INTEGER NOT NULL UNIQUE,
      model TEXT NOT NULL,
      dimensions INTEGER NOT NULL,
      content_hash TEXT NOT NULL,
      embedded_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS embedding_jobs (
      document_id TEXT PRIMARY KEY REFERENCES search_documents(id) ON DELETE CASCADE,
      content_hash TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'processing', 'complete', 'failed')),
      attempts INTEGER NOT NULL DEFAULT 0,
      next_retry_at TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS embedding_jobs_ready
      ON embedding_jobs(status, next_retry_at, attempts);
  `);
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS ${SEARCH_DOCUMENT_VEC_TABLE} USING vec0(
      embedding FLOAT[3072] distance_metric=cosine
    )
  `);

  // Durable attachment references and retryable download/OCR/document-analysis jobs.
  // Session JSON keeps the reference identity; these tables retain processing state
  // and extracted projections without placing binary payloads inside SQLite.
  db.exec(`
    CREATE TABLE IF NOT EXISTS attachment_records (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      channel_id TEXT,
      parent_id TEXT NOT NULL,
      url TEXT,
      original_name TEXT,
      content_type TEXT,
      local_path TEXT,
      size_bytes INTEGER,
      content_hash TEXT,
      visibility_scope TEXT NOT NULL,
      relation TEXT NOT NULL DEFAULT 'upload',
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'processing', 'complete', 'failed')),
      ocr_text TEXT,
      visual_description TEXT,
      extracted_text TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS attachment_records_session_parent
      ON attachment_records(session_id, parent_id);
    CREATE INDEX IF NOT EXISTS attachment_records_hash
      ON attachment_records(content_hash);
    CREATE INDEX IF NOT EXISTS attachment_records_status
      ON attachment_records(status);

    CREATE TABLE IF NOT EXISTS attachment_jobs (
      attachment_id TEXT PRIMARY KEY REFERENCES attachment_records(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'processing', 'complete', 'failed')),
      attempts INTEGER NOT NULL DEFAULT 0,
      next_retry_at TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS attachment_jobs_ready
      ON attachment_jobs(status, next_retry_at, attempts);

    -- Per-local-day counter of successful visual descriptions. The attachment worker
    -- enforces attachment_analysis.daily_budget against this; the row is keyed by the
    -- local date string (config.timezone-aware, same convention as diary/log filenames)
    -- so a budget resets naturally at local midnight without any scheduled job.
    CREATE TABLE IF NOT EXISTS vision_usage (
      day TEXT PRIMARY KEY,
      descriptions INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  ensureColumn(db, "attachment_records", "ocr_status", "TEXT NOT NULL DEFAULT 'pending'");
  ensureColumn(db, "attachment_records", "vision_status", "TEXT NOT NULL DEFAULT 'pending'");
  ensureColumn(db, "attachment_records", "extract_status", "TEXT NOT NULL DEFAULT 'pending'");
  // Discord provenance for signed-CDN-URL refresh. Nullable and added via ensureColumn so
  // pre-existing attachment rows migrate forward with NULLs (refresh simply degrades to the
  // stored URL for rows that predate provenance capture).
  ensureColumn(db, "attachment_records", "discord_channel_id", "TEXT");
  ensureColumn(db, "attachment_records", "discord_message_id", "TEXT");
  ensureColumn(db, "attachment_records", "discord_attachment_id", "TEXT");
  // Count of refreshable (non-permanent) job failures — e.g. a stale signed URL or a
  // transient daily-budget stop — that must NOT drain the permanent retry attempts budget.
  ensureColumn(db, "attachment_jobs", "refresh_attempts", "INTEGER NOT NULL DEFAULT 0");
  // One-time backfill of the per-stage status columns, gated by schema version so it
  // stops touching every attachment row on subsequent process starts.
  migrateAttachmentStageStatus(db);
  migrateRemovedDiaryNotes(db);

  rebuildFtsIfNeeded(db);

  logger.info({ path: DB_PATH }, "database initialized");
  return db;
}

/**
 * FTS 索引的內容格式版本。
 *
 * FTS 表存的不是原文，而是 `toSearchTokens()` 展開後的 token 序列
 * （中文 bigram 化，否則 unicode61 不斷中文，中文查詢永遠搜不到）。
 * 展開規則改變時把這個數字 +1，開機就會用新規則重建索引。
 */
const FTS_CONTENT_VERSION = 2;

/** Rebuild the search-document FTS projection when its token version changes. */
function rebuildFtsIfNeeded(database: Database.Database): void {
  database.exec(`CREATE TABLE IF NOT EXISTS fts_meta (key TEXT PRIMARY KEY, value INTEGER)`);
  const unified = database.prepare("SELECT value FROM fts_meta WHERE key='search_documents_content_version'").get() as { value: number } | undefined;

  try {
    if (unified?.value !== FTS_CONTENT_VERSION) {
      const rows = database.prepare("SELECT rowid, text, source_type, source_id, session_id, visibility_scope FROM search_documents").all() as Array<{ rowid: number; text: string; source_type: string; source_id: string; session_id: string | null; visibility_scope: string }>;
      const insert = database.prepare("INSERT INTO search_documents_fts (rowid, text, source_type, source_id, session_id, visibility_scope) VALUES (?, ?, ?, ?, ?, ?)");
      database.transaction(() => {
        database.exec("DELETE FROM search_documents_fts");
        for (const r of rows) insert.run(r.rowid, toSearchTokens(r.text), r.source_type, r.source_id, r.session_id ?? "", r.visibility_scope);
        database.prepare("INSERT INTO fts_meta (key, value) VALUES ('search_documents_content_version', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(FTS_CONTENT_VERSION);
      })();
      logger.info({ version: FTS_CONTENT_VERSION, searchDocuments: rows.length }, "unified FTS index rebuilt");
    }
  } catch (err) {
    logger.error({ err: (err as Error).message }, "FTS rebuild failed");
  }
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
