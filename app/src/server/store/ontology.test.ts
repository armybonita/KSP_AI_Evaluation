import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { CREATE_TABLES_SQL } from './schema';
import { createProject } from './db';
import { importVault } from '../ontology/importer';
import { getProjectOntology, listProjectOntologyEvidence, replaceProjectOntology } from '../ontology/store';
import { prepareVirtualQuoteCache } from './prepare-quote-cache';

const vaults = importVault('fixtures/ontology');
const graphA = vaults.find((graph) => graph.code === 'VA01')!;
const graphB = vaults.find((graph) => graph.code === 'VB01')!;

function database() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(CREATE_TABLES_SQL);
  createProject({ id: 'p1', name: '가상 평가사업 1', created_at: '2026-10-29' }, db);
  createProject({ id: 'p2', name: '가상 평가사업 2', created_at: '2026-10-29' }, db);
  return db;
}

describe('ontology persistence', () => {
  it('prepares virtual quote checks without modifying source rows and invalidates them on later changes', () => {
    const db = database();
    const graph = structuredClone(graphA);
    graph.sources = { source: { original_paragraphs: [{ location: '쪽 가', content: '가상 자료의 첫 번째 인용문입니다.' }] } };
    graph.snippets = { snippet: { source: 'source', locator: '쪽 가', quote: '가상 자료의 첫 번째 인용문입니다.' } };
    const imported = replaceProjectOntology('p1', graph, 'tester', db);
    const sourceBefore = db.prepare('SELECT * FROM ontology_sources WHERE project_id = ?').all('p1');
    const snippetsBefore = db.prepare('SELECT * FROM ontology_snippets WHERE project_id = ?').all('p1');
    expect(prepareVirtualQuoteCache(db)).toEqual({ projects: 1, snippets: 1 });
    expect(db.prepare('SELECT * FROM ontology_sources WHERE project_id = ?').all('p1')).toEqual(sourceBefore);
    expect(db.prepare('SELECT * FROM ontology_snippets WHERE project_id = ?').all('p1')).toEqual(snippetsBefore);
    expect(db.prepare('SELECT verified FROM ontology_quote_verification_cache_v3 WHERE project_id = ?').get('p1')).toEqual({ verified: 1 });
    expect(listProjectOntologyEvidence('p1', db).evidence[0].quoteStatus).toBe('verified');
    db.prepare('UPDATE ontology_sources SET data_json = ? WHERE project_id = ? AND import_id = ? AND id = ?').run(
      JSON.stringify({ original_paragraphs: [{ location: '쪽 가', content: '전혀 다른 가상 문단입니다.' }] }), 'p1', imported.id, 'source',
    );
    expect(db.prepare('SELECT COUNT(*) AS n FROM ontology_quote_verification_cache_v3').get()).toEqual({ n: 0 });
    expect(listProjectOntologyEvidence('p1', db).evidence[0].quoteStatus).toBe('unverified');
    db.close();
  });

  it('refreshes virtual source quote checks when the source or quote changes under the same id', () => {
    const db = database();
    const graph = structuredClone(graphA);
    graph.sources = { source: { original_paragraphs: [{ location: '쪽 가', content: '가상 자료의 첫 번째 인용문입니다.' }] } };
    graph.snippets = { snippet: { source: 'source', locator: '쪽 가', quote: '가상 자료의 첫 번째 인용문입니다.' } };
    const imported = replaceProjectOntology('p1', graph, 'tester', db);
    db.prepare('INSERT INTO ontology_quote_verification_cache_v2 VALUES (?, ?, ?, ?, ?, ?)').run('p1', imported.id, 'snippet', 'stale', 0, 0);
    const check = () => listProjectOntologyEvidence('p1', db).evidence[0];
    const first = check();
    expect(first.quoteStatus).toBe('verified');
    expect(check().quoteStatus).toBe('verified');
    db.prepare('UPDATE ontology_sources SET data_json = ? WHERE project_id = ? AND import_id = ? AND id = ?').run(
      JSON.stringify({ original_paragraphs: [{ location: '쪽 가', content: '전혀 다른 가상 문단으로 변경했습니다.' }] }), 'p1', imported.id, 'source',
    );
    const changedSource = check();
    expect(changedSource.quoteStatus).toBe('unverified');
    expect(changedSource.quoteMatchPercent).not.toBe(first.quoteMatchPercent);
    db.prepare('UPDATE ontology_snippets SET data_json = ? WHERE project_id = ? AND import_id = ? AND id = ?').run(
      JSON.stringify({ source: 'source', locator: '쪽 가', quote: '전혀 다른 가상 문단으로 변경했습니다.' }), 'p1', imported.id, 'snippet',
    );
    const changedQuote = check();
    expect(changedQuote.quoteStatus).toBe('verified');
    expect(changedQuote.quoteMatchPercent).not.toBe(changedSource.quoteMatchPercent);
    db.close();
  });

  it('stores a project snapshot and retains import history on reimport', () => {
    const db = database();
    replaceProjectOntology('p1', graphA, 'tester', db, '2026-10-29T01:00:00Z');
    replaceProjectOntology('p1', graphB, 'tester', db, '2026-10-29T02:00:00Z');
    const result = getProjectOntology('p1', db);
    expect(result.history).toHaveLength(2);
    expect(result.import?.vault_code).toBe('VB01');
    expect(result.nodeCounts.reduce((sum, row) => sum + row.count, 0)).toBe(Object.keys(graphB.nodes).length);
    expect(result.edgeCounts.reduce((sum, row) => sum + row.count, 0)).toBe(graphB.edges.length);
    expect(db.prepare('SELECT COUNT(*) AS n FROM ontology_nodes WHERE project_id = ?').get('p1')).toMatchObject({ n: Object.keys(graphB.nodes).length });
    const storedSnippet = db.prepare('SELECT data_json FROM ontology_snippets WHERE project_id = ?').get('p1') as { data_json: string };
    expect(Object.keys(JSON.parse(storedSnippet.data_json)).sort()).toEqual(['id', 'locator', 'quote', 'source']);
    db.close();
  });

  it('rolls back a failed replacement and leaves the prior snapshot intact', () => {
    const db = database();
    replaceProjectOntology('p1', graphA, 'tester', db, '2026-10-29T01:00:00Z');
    const invalidGraph = { ...graphB, issues: [{ severity: 'invalid' as 'error', file: 'x.md', field: 'frontmatter', rule: 'R03' }] };
    expect(() => replaceProjectOntology('p1', invalidGraph, 'tester', db, '2026-10-29T02:00:00Z')).toThrow();
    expect(getProjectOntology('p1', db).import?.vault_code).toBe('VA01');
    expect(getProjectOntology('p1', db).history).toHaveLength(1);
    db.close();
  });

  it('keeps another app project isolated and cascades its data on project deletion', () => {
    const db = database();
    replaceProjectOntology('p1', graphA, 'tester', db);
    replaceProjectOntology('p2', graphB, 'tester', db);
    replaceProjectOntology('p1', graphB, 'tester', db);
    const importId = getProjectOntology('p1', db).import!.id;
    db.prepare(`INSERT INTO ontology_portfolio_level_reviews
      (id, project_id, import_id, node_id, node_type, outcome_family, ai_level, team_level, reviewer, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run('level', 'p1', importId, 'outcome', 'outcome-mid', '협력국 정책 반영', 'K2', 'K3', '가상 평가자', '날짜');
    db.prepare(`INSERT INTO ontology_portfolio_snapshots (project_id, calculated_at, input_revision) VALUES (?, ?, ?)`).run('p1', '날짜', 0);
    expect(() => db.prepare('DELETE FROM ontology_portfolio_level_reviews WHERE id = ?').run('level')).toThrow();
    expect(() => db.prepare('DELETE FROM ontology_imports WHERE id = ?').run(importId)).toThrow();
    db.prepare('INSERT INTO ontology_quote_verification_cache_v2 VALUES (?, ?, ?, ?, ?, ?)').run('p1', importId, 'sample', 'hash', 1, 1);
    db.prepare('INSERT INTO ontology_quote_verification_cache_v3 VALUES (?, ?, ?, ?, ?, ?, ?)').run('p1', importId, 'sample', 'hash', 'snippet', 1, 1);
    expect(getProjectOntology('p2', db).import?.vault_code).toBe('VB01');
    db.prepare('DELETE FROM projects WHERE id = ?').run('p1');
    expect(db.prepare('SELECT COUNT(*) AS n FROM ontology_portfolio_level_reviews WHERE project_id = ?').get('p1')).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM ontology_portfolio_snapshots WHERE project_id = ?').get('p1')).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM ontology_quote_verification_cache_v2 WHERE project_id = ?').get('p1')).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM ontology_quote_verification_cache_v3 WHERE project_id = ?').get('p1')).toEqual({ n: 0 });
    expect(getProjectOntology('p1', db).history).toHaveLength(0);
    expect(getProjectOntology('p2', db).import?.vault_code).toBe('VB01');
    db.close();
  });

  it('removes replaced import caches and clears the legacy cache during migration', () => {
    const db = database();
    replaceProjectOntology('p1', graphA, 'tester', db, '2026-10-29T01:00:00Z');
    const importId = getProjectOntology('p1', db).import!.id;
    db.prepare('INSERT INTO ontology_quote_verification_cache_v2 VALUES (?, ?, ?, ?, ?, ?)').run('p1', importId, 'sample', 'hash', 1, 1);
    db.prepare('INSERT INTO ontology_quote_verification_cache_v3 VALUES (?, ?, ?, ?, ?, ?, ?)').run('p1', importId, 'sample', 'hash', 'snippet', 1, 1);
    db.prepare('INSERT INTO ontology_quote_verification_cache VALUES (?, ?, ?, ?, ?, ?)').run('p1', importId, 'sample', 'hash', 1, 1);
    replaceProjectOntology('p1', graphB, 'tester', db, '2026-10-29T02:00:00Z');
    expect(db.prepare('SELECT COUNT(*) AS n FROM ontology_quote_verification_cache_v2').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM ontology_quote_verification_cache_v3').get()).toEqual({ n: 0 });
    db.exec(CREATE_TABLES_SQL);
    expect(db.prepare('SELECT COUNT(*) AS n FROM ontology_quote_verification_cache').get()).toEqual({ n: 0 });
    db.close();
  });

  it('adds ontology tables to an existing database without rebuilding its existing tables', () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL);
      INSERT INTO projects VALUES ('legacy', '기존 사업', '2026-01-01');`);
    db.exec(CREATE_TABLES_SQL);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => (row as { name: string }).name);
    expect(tables).toContain('projects');
    expect(tables).toContain('ontology_imports');
    expect(db.prepare('SELECT name FROM projects WHERE id = ?').get('legacy')).toMatchObject({ name: '기존 사업' });
    db.close();
  });

  it('stores only generated evidence fields needed for later evaluation', () => {
    const db = database();
    const graph = structuredClone(graphA);
    const [snippetId, snippet] = Object.entries(graph.snippets)[0];
    graph.snippets[snippetId] = {
      ...snippet, type: 'evidence', layer: 'L3', created: '2026-10-29', updated: '2026-10-29',
      speaker: '수행기관', evidence_kind: '기타', evidence_level: '관측', category: '산출물',
      proves: [], supports: [], contradicts: [], status: 'ai-draft', author: 'ai', reviewer: '', tags: [],
    };
    replaceProjectOntology('p1', graph, 'tester', db, '2026-10-29T03:00:00Z', { sourceKind: 'generated', modelName: 'fixture-model' });
    const stored = db.prepare('SELECT data_json FROM ontology_snippets WHERE project_id = ?').get('p1') as { data_json: string };
    expect(Object.keys(JSON.parse(stored.data_json)).sort()).toEqual([
      'category', 'created', 'evidence_kind', 'evidence_level', 'id', 'layer', 'locator', 'proves', 'quote', 'source', 'speaker', 'supports', 'type', 'updated', 'contradicts',
    ].sort());
    db.close();
  });
});
