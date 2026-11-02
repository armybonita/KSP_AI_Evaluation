import type Database from 'better-sqlite3';
import { getOntologyQuoteChecks } from './ontology';
import { prepareEvidenceQuoteCache } from './evidence-quote-cache';

/** Prepare virtual-source and outcome-evidence quote checks after migration, before serving.
 * Each project holds a write reservation while its source rows and cache are read
 * and written, so another writer cannot invalidate the snapshot mid-calculation.
 */
export function prepareVirtualQuoteCache(db: Database.Database): { projects: number; snippets: number } {
  const required = ['ontology_quote_verification_cache_v3', 'trg_quote_source_insert', 'trg_quote_source_update',
    'trg_quote_source_delete', 'trg_quote_snippet_insert', 'trg_quote_snippet_update', 'trg_quote_snippet_delete',
    'evidence_quote_verification_cache', 'trg_evquote_evidence_insert', 'trg_evquote_evidence_update',
    'trg_evquote_evidence_delete', 'trg_evquote_paragraph_insert', 'trg_evquote_paragraph_update',
    'trg_evquote_paragraph_delete', 'trg_evquote_sentence_insert', 'trg_evquote_sentence_update',
    'trg_evquote_sentence_delete', 'trg_evquote_document_insert', 'trg_evquote_document_update',
    'trg_evquote_document_delete', 'trg_evquote_suggestion_update', 'trg_evquote_indicator_update'];
  const installed = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'trigger')").all() as Array<{ name: string }>).map(row => row.name));
  if (required.some(name => !installed.has(name))) throw new Error('Run the additive database migration before preparing the quote cache');

  const projects = db.prepare('SELECT id FROM projects').all() as Array<{ id: string }>;
  const latest = db.prepare('SELECT id FROM ontology_imports WHERE project_id = ? ORDER BY imported_at DESC, rowid DESC LIMIT 1');
  const sourceQuery = db.prepare(`SELECT id, json_extract(data_json, '$.document_id') AS document_id
    FROM ontology_sources WHERE project_id = ? AND import_id = ?`);
  const snippetQuery = db.prepare('SELECT id, data_json FROM ontology_snippets WHERE project_id = ? AND import_id = ?');
  let projectCount = 0;
  let snippetCount = 0;
  const prepareProject = db.transaction((projectId: string) => {
    prepareEvidenceQuoteCache(projectId, db);
    const imported = latest.get(projectId) as { id: string } | undefined;
    if (!imported) return;
    const sourceRows = sourceQuery.all(projectId, imported.id) as Array<{ id: string; document_id: unknown }>;
    const sources = new Map<string, Record<string, unknown>>();
    for (const row of sourceRows) {
      if (!row.document_id) sources.set(row.id, { document_id: row.document_id });
    }
    if (!sources.size) return;
    const snippets = (snippetQuery.all(projectId, imported.id) as Array<{ id: string; data_json: string }>).flatMap(row => {
      let data: unknown;
      try { data = JSON.parse(row.data_json); } catch { return []; }
      if (!data || typeof data !== 'object' || Array.isArray(data)) return [];
      const record = data as Record<string, unknown>;
      return typeof record.source === 'string' && sources.has(record.source) ? [{ id: row.id, data: record }] : [];
    });
    if (!snippets.length) return;
    getOntologyQuoteChecks(projectId, imported.id, db, snippets, sources);
    projectCount++;
    snippetCount += snippets.length;
  });
  for (const project of projects) prepareProject.immediate(project.id);
  return { projects: projectCount, snippets: snippetCount };
}
