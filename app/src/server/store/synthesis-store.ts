import crypto from 'node:crypto';
import { getDatabase, resolveProjectCitationContext, type DbConnection } from '@/server/store/db';
import { getAiProvider } from '@/server/ai/client';
import { maskForbiddenSentenceInContent } from '@/server/store/citation-ban';
import type { SynthesisDiagnostics } from '@/server/ontology/synthesis';

export interface SynthesisRun {
  id: string;
  project_id: string;
  state: 'queued' | 'running' | 'completed' | 'partial_completed' | 'failed';
  started_at: string;
  finished_at: string | null;
  error_message: string | null;
  input_node_count: number;
  item_count: number;
  discarded_count: number;
  result_json: string | null;
  diagnostics: SynthesisDiagnostics | null;
  fingerprint: string | null;
}

export const ELIGIBILITY_CHANGED_MESSAGE = '중단 — 실행 중 자료 자격이 바뀌었습니다. 다시 실행해 주세요';
export class SynthesisEligibilityChanged extends Error {
  constructor() { super(ELIGIBILITY_CHANGED_MESSAGE); }
}

/** Ordered eligibility fields and banned text, without reading paragraph bodies. */
export function getSynthesisEligibilityFingerprint(projectId: string, db: DbConnection = getDatabase(), provider: string | null = getAiProvider()): string {
  const documents = db.prepare('SELECT id, is_included, is_past_final_report, masked, approved_ai, status, doc_type FROM documents WHERE project_id = ? ORDER BY id').all(projectId);
  const sentences = db.prepare(`SELECT s.content FROM sentences s JOIN paragraphs p ON p.id = s.paragraph_id JOIN documents d ON d.id = p.document_id WHERE d.project_id = ? AND s.is_citation_banned = 1 ORDER BY s.content`).all(projectId);
  return crypto.createHash('sha256').update(JSON.stringify({ documents, sentences, provider })).digest('hex');
}

export function assertSynthesisEligibility(projectId: string, fingerprint: string, db: DbConnection = getDatabase(), provider: string | null = getAiProvider()): void {
  if (getSynthesisEligibilityFingerprint(projectId, db, provider) !== fingerprint) throw new SynthesisEligibilityChanged();
}


export function startSynthesisRun(projectId: string, db: DbConnection = getDatabase()): SynthesisRun | null {
  const run: SynthesisRun = { id: crypto.randomUUID(), project_id: projectId, state: 'queued', started_at: new Date().toISOString(), finished_at: null, error_message: null, input_node_count: 0, item_count: 0, discarded_count: 0, result_json: null, diagnostics: null, fingerprint: null };
  try {
    db.prepare(`INSERT INTO ontology_synthesis_runs (id, project_id, state, started_at) VALUES (@id, @project_id, @state, @started_at)`).run(run);
    return run;
  } catch (error) {
    // SQLite's partial unique index protects even concurrent requests in separate processes.
    if (error instanceof Error && /UNIQUE constraint failed: ontology_synthesis_runs.project_id/i.test(error.message)) return null;
    throw error;
  }
}

export function getLatestSynthesisRun(projectId: string, db: DbConnection = getDatabase()): SynthesisRun | null {
  const row = db.prepare('SELECT r.*, d.diagnostics_json, p.state AS partial_state, e.fingerprint FROM ontology_synthesis_runs r LEFT JOIN ontology_synthesis_diagnostics d ON d.run_id = r.id LEFT JOIN ontology_synthesis_partial_runs p ON p.run_id = r.id LEFT JOIN ontology_synthesis_eligibility e ON e.run_id = r.id WHERE r.project_id = ? ORDER BY r.started_at DESC, r.rowid DESC LIMIT 1').get(projectId) as (Omit<SynthesisRun, 'diagnostics'> & { diagnostics_json: string | null; partial_state: 'partial_completed' | null }) | undefined;
  if (!row) return null;
  const { diagnostics_json, partial_state, ...run } = row;
  return { ...run, state: partial_state ?? run.state, diagnostics: diagnostics_json ? JSON.parse(diagnostics_json) as SynthesisDiagnostics : null };
}

/** Hide the entire result when any eligibility input differs from the run snapshot. */
export function prepareSynthesisResponse(projectId: string, run: SynthesisRun | null, db: DbConnection = getDatabase(), provider: string | null = getAiProvider()): { synthesis: SynthesisRun | null; result: unknown[] | null; state?: 'stale'; message?: string; diagnostics?: Record<string, Record<string, number>> | null } {
  if (!run) return { synthesis: null, result: null };
  return db.transaction(() => {
    if ((!run.fingerprint && (run.state !== 'queued' || run.result_json !== null)) || (run.fingerprint && run.fingerprint !== getSynthesisEligibilityFingerprint(projectId, db, provider))) {
      const diagnostics = run.diagnostics && Object.fromEntries(Object.entries(run.diagnostics).map(([step, values]) => [step, Object.fromEntries(Object.entries(values).filter((entry): entry is [string, number] => typeof entry[1] === 'number'))]));
      return { state: 'stale' as const, message: '자료 자격이 바뀌어 이전 결과를 숨겼습니다. 다시 실행해 주세요', diagnostics, synthesis: null, result: [] };
    }
    const context = resolveProjectCitationContext(projectId, db);
    const cache = new Map<string, string>();
    const redact = (value: unknown, key = ''): unknown => {
      if (key === 'cites') return value;
      if (typeof value === 'string') {
        let masked = cache.get(value);
        if (masked === undefined) { masked = maskForbiddenSentenceInContent(value, context.sentences, context.index); cache.set(value, masked); }
        return masked;
      }
      if (Array.isArray(value)) return value.map(child => redact(child));
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, redact(child, key)]));
      return value;
    };
    const parsed: unknown = run.result_json ? JSON.parse(run.result_json) : null;
    if (parsed !== null && !Array.isArray(parsed)) throw new Error('합성 결과 형식이 올바르지 않습니다.');
    const result = redact(parsed) as unknown[] | null;
    const synthesis = redact({ ...run, fingerprint: null, result_json: result === null ? null : JSON.stringify(result) }) as SynthesisRun;
    return { synthesis, result };
  })();
}

export function markSynthesisRunning(id: string, db: DbConnection = getDatabase(), provider: string | null = getAiProvider()): string {
  return db.transaction(() => {
    const run = db.prepare("SELECT project_id FROM ontology_synthesis_runs WHERE id = ? AND state = 'queued'").get(id) as { project_id: string } | undefined;
    if (!run) throw new Error('대기 중인 종합 실행이 없습니다.');
    const fingerprint = getSynthesisEligibilityFingerprint(run.project_id, db, provider);
    db.prepare('INSERT INTO ontology_synthesis_eligibility (run_id, fingerprint) VALUES (?, ?)').run(id, fingerprint);
    db.prepare("UPDATE ontology_synthesis_runs SET state = 'running' WHERE id = ? AND state = 'queued'").run(id);
    return fingerprint;
  })();
}

export function assertRunEligibility(id: string, db: DbConnection, provider: string | null = getAiProvider()): void {
  const run = db.prepare('SELECT r.project_id, e.fingerprint FROM ontology_synthesis_runs r LEFT JOIN ontology_synthesis_eligibility e ON e.run_id = r.id WHERE r.id = ?').get(id) as { project_id: string; fingerprint: string | null } | undefined;
  if (!run?.fingerprint) throw new SynthesisEligibilityChanged();
  assertSynthesisEligibility(run.project_id, run.fingerprint, db, provider);
}

export function saveSynthesisDiagnostics(id: string, diagnostics: SynthesisDiagnostics, db: DbConnection = getDatabase()): void {
  db.prepare(`INSERT INTO ontology_synthesis_diagnostics (run_id, diagnostics_json) VALUES (?, ?)
    ON CONFLICT(run_id) DO UPDATE SET diagnostics_json = excluded.diagnostics_json`).run(id, JSON.stringify(diagnostics));
}

export function saveSynthesisStage(id: string, result: { items: unknown[]; inputNodeCount: number; discardedCount: number; diagnostics: SynthesisDiagnostics }, db: DbConnection = getDatabase(), provider: string | null = getAiProvider()): void {
  db.transaction(() => {
    assertRunEligibility(id, db, provider);
    saveSynthesisDiagnostics(id, result.diagnostics, db);
    db.prepare(`UPDATE ontology_synthesis_runs SET input_node_count = ?, item_count = ?, discarded_count = ?, result_json = ? WHERE id = ? AND state = 'running'`)
      .run(result.inputNodeCount, result.items.length, result.discardedCount, JSON.stringify(result.items), id);
  })();
}

export function finishSynthesisRun(id: string, result: { items: unknown[]; inputNodeCount: number; discardedCount: number; diagnostics?: SynthesisDiagnostics; partialReason?: string }, db: DbConnection = getDatabase(), provider: string | null = getAiProvider()): void {
  db.transaction(() => {
    assertRunEligibility(id, db, provider);
    if (result.diagnostics) saveSynthesisDiagnostics(id, result.diagnostics, db);
    // Preserve the legacy run-state CHECK and record the distinct partial state additively.
    if (result.partialReason) db.prepare("INSERT INTO ontology_synthesis_partial_runs (run_id, state) VALUES (?, 'partial_completed')").run(id);
    db.prepare(`UPDATE ontology_synthesis_runs SET state = 'completed', finished_at = ?, error_message = ?, input_node_count = ?, item_count = ?, discarded_count = ?, result_json = ? WHERE id = ? AND state = 'running'`)
      .run(new Date().toISOString(), result.partialReason ?? null, result.inputNodeCount, result.items.length, result.discardedCount, JSON.stringify(result.items), id);
  })();
}

export function abortSynthesisRun(id: string, db: DbConnection = getDatabase()): void {
  db.prepare("UPDATE ontology_synthesis_runs SET state = 'failed', finished_at = ?, error_message = ?, result_json = NULL, item_count = 0 WHERE id = ? AND state IN ('queued', 'running')")
    .run(new Date().toISOString(), ELIGIBILITY_CHANGED_MESSAGE, id);
}

export function failSynthesisRun(id: string, message: string, db: DbConnection = getDatabase()): void {
  db.prepare("UPDATE ontology_synthesis_runs SET state = 'failed', finished_at = ?, error_message = ? WHERE id = ? AND state IN ('queued', 'running')")
    .run(new Date().toISOString(), message, id);
}

/** Read paragraph identifiers and their owners without loading document content. */
export function getSynthesisParagraphDocuments(projectId: string, db: DbConnection = getDatabase()): Array<{ id: string; document_id: string }> {
  return db.prepare('SELECT p.id, p.document_id FROM paragraphs p JOIN documents d ON d.id = p.document_id WHERE d.project_id = ?').all(projectId) as Array<{ id: string; document_id: string }>;
}

/** Load one immutable graph snapshot; callers decide which sources are eligible. */
export function getSynthesisGraph(projectId: string, db: DbConnection = getDatabase()): {
  sources: Array<{ id: string; data_json: string }>;
  snippets: Array<{ id: string; data_json: string }>;
  edges: Array<{ source_id: string; target_id: string; relation_field: string }>;
  nodes: Array<{ id: string; node_type: string; title: string; data_json: string }>;
} | null {
  const latest = db.prepare('SELECT id FROM ontology_imports WHERE project_id = ? ORDER BY imported_at DESC, rowid DESC LIMIT 1').get(projectId) as { id: string } | undefined;
  if (!latest) return null;
  const args = [projectId, latest.id];
  return {
    sources: db.prepare('SELECT id, data_json FROM ontology_sources WHERE project_id = ? AND import_id = ?').all(...args) as Array<{ id: string; data_json: string }>,
    snippets: db.prepare('SELECT id, data_json FROM ontology_snippets WHERE project_id = ? AND import_id = ?').all(...args) as Array<{ id: string; data_json: string }>,
    edges: db.prepare('SELECT source_id, target_id, relation_field FROM ontology_edges WHERE project_id = ? AND import_id = ?').all(...args) as Array<{ source_id: string; target_id: string; relation_field: string }>,
    nodes: db.prepare('SELECT id, node_type, title, data_json FROM ontology_nodes WHERE project_id = ? AND import_id = ?').all(...args) as Array<{ id: string; node_type: string; title: string; data_json: string }>,
  };
}
