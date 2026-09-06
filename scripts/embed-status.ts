import { closeDb, getDb, SEARCH_DOCUMENT_VEC_TABLE } from "../src/db.js";

interface Count { key: string; n: number }

function table(title: string, rows: Count[], empty = "none"): void {
  console.log(`\n${title}`);
  if (rows.length === 0) { console.log(`  ${empty}`); return; }
  const width = Math.max(...rows.map(r => r.key.length));
  for (const row of rows) console.log(`  ${row.key.padEnd(width)}  ${row.n}`);
}

try {
  const db = getDb();
  const query = (sql: string): Count[] => db.prepare(sql).all() as Count[];

  table("jobs", query("SELECT status AS key, count(*) AS n FROM embedding_jobs GROUP BY 1 ORDER BY 2 DESC"));

  table("vectors by source", query(`
    SELECT d.source_type AS key, count(*) AS n
    FROM search_document_embeddings e JOIN search_documents d ON d.id = e.document_id
    GROUP BY 1 ORDER BY 2 DESC
  `));

  table("queued by source", query(`
    SELECT d.source_type AS key, count(*) AS n
    FROM embedding_jobs j JOIN search_documents d ON d.id = j.document_id
    WHERE j.status IN ('pending', 'processing') GROUP BY 1 ORDER BY 2 DESC
  `), "queue empty");

  table("failures", query(`
    SELECT substr(coalesce(j.last_error, 'unknown'), 1, 70) AS key, count(*) AS n
    FROM embedding_jobs j WHERE j.status = 'failed' GROUP BY 1 ORDER BY 2 DESC
  `), "no failures");

  // The vec0 index and its metadata row are written separately; a mismatch means one of the
  // two is stale and hybrid search silently loses recall for the documents that are missing.
  const vectors = (db.prepare(`SELECT count(*) AS n FROM ${SEARCH_DOCUMENT_VEC_TABLE}`).get() as { n: number }).n;
  const metadata = (db.prepare("SELECT count(*) AS n FROM search_document_embeddings").get() as { n: number }).n;
  console.log(`\nindex: ${vectors} vectors / ${metadata} metadata rows`);
  if (vectors !== metadata) console.log(`  MISMATCH of ${Math.abs(vectors - metadata)} — run scripts/backfill-search-index.ts`);
} finally { closeDb(); }
