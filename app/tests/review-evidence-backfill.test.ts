import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { backfillReviewEvidenceKeys } from '../src/server/store/review-evidence-keys';

function database() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE projects (id TEXT PRIMARY KEY);
    CREATE TABLE ontology_imports (id TEXT PRIMARY KEY, project_id TEXT);
    CREATE TABLE ontology_nodes (project_id TEXT, import_id TEXT, id TEXT, data_json TEXT, PRIMARY KEY(project_id, import_id, id));
    CREATE TABLE ontology_snippets (project_id TEXT, import_id TEXT, id TEXT, data_json TEXT, PRIMARY KEY(project_id, import_id, id));
    CREATE TABLE ontology_sources (project_id TEXT, import_id TEXT, id TEXT, data_json TEXT, PRIMARY KEY(project_id, import_id, id));
    CREATE TABLE ontology_review_evidence_keys (project_id TEXT, import_id TEXT, node_id TEXT, source_id TEXT, locator TEXT, quote TEXT, PRIMARY KEY(project_id, import_id, node_id, source_id, locator, quote));`);
  return db;
}

// The pre-optimization implementation, retained as an independent oracle.
function legacyBackfill(db: Database.Database) {
  const record = (x: unknown): Record<string, unknown> => x && typeof x === 'object' && !Array.isArray(x) ? x as Record<string, unknown> : {};
  const includes = (v: unknown, id: string) => Array.isArray(v) && v.includes(id);
  const nodes = db.prepare('SELECT * FROM ontology_nodes').all() as Array<{project_id:string; import_id:string; id:string; data_json:string}>;
  const snippets = db.prepare('SELECT id, data_json FROM ontology_snippets WHERE project_id=? AND import_id=?');
  const sources = db.prepare('SELECT data_json FROM ontology_sources WHERE project_id=? AND import_id=? AND id=?');
  const insert = db.prepare('INSERT OR IGNORE INTO ontology_review_evidence_keys VALUES (?, ?, ?, ?, ?, ?)');
  for (const node of nodes) {
    const data = record(JSON.parse(node.data_json));
    for (const row of snippets.all(node.project_id, node.import_id) as Array<{id:string; data_json:string}>) {
      const snippet = record(JSON.parse(row.data_json));
      const source = typeof snippet.source === 'string' ? snippet.source : '';
      const sourceRow = sources.get(node.project_id, node.import_id, source) as {data_json:string} | undefined;
      const meta = sourceRow ? record(record(record(JSON.parse(sourceRow.data_json)).evidence_metadata)[row.id]) : {};
      if (!includes(data.evidence,row.id) && !includes(snippet.proves,node.id) && !includes(snippet.supports,node.id) && !includes(meta.proves,node.id) && !includes(meta.supports,node.id)) continue;
      if (source && typeof snippet.locator === 'string' && snippet.locator && typeof snippet.quote === 'string' && snippet.quote)
        insert.run(node.project_id,node.import_id,node.id,source,snippet.locator,snippet.quote);
    }
  }
}

function seed(db: Database.Database) {
  db.exec("INSERT INTO projects VALUES ('p'), ('q')");
  const addImport = db.prepare('INSERT INTO ontology_imports VALUES (?, ?)');
  const node = db.prepare('INSERT INTO ontology_nodes VALUES (?, ?, ?, ?)');
  const snippet = db.prepare('INSERT INTO ontology_snippets VALUES (?, ?, ?, ?)');
  const source = db.prepare('INSERT INTO ontology_sources VALUES (?, ?, ?, ?)');
  for (const [project, imp] of [['p', 'old'], ['p', 'new'], ['q', 'other']]) {
    addImport.run(imp, project);
    node.run(project, imp, 'n1', JSON.stringify({ evidence: ['s1', 's2', 'missing'] }));
    node.run(project, imp, 'n2', JSON.stringify({ evidence: ['s1'] }));
    node.run(project, imp, 'n3', '{}');
    source.run(project, imp, 'src', JSON.stringify({ evidence_metadata: { s2: { proves: ['n2'], supports: ['n3'] }, s3: { supports: ['n1'] } } }));
    snippet.run(project, imp, 's1', JSON.stringify({ source: 'src', locator: 'L1', quote: '가상 근거', proves: ['n3'] }));
    snippet.run(project, imp, 's2', JSON.stringify({ source: 'src', locator: 'L2', quote: '가상 문장', supports: ['n1'] }));
    snippet.run(project, imp, 's3', JSON.stringify({ source: 'missing source', locator: 'L3', quote: '출처 없는 가상 문장', proves: ['n2'] }));
    snippet.run(project, imp, 's4', JSON.stringify({ source: 'src', locator: '', quote: '불완전', proves: ['n1'] }));
    snippet.run(project, imp, 's5', JSON.stringify({ source: 'src', locator: 'L5', quote: '메타 근거' }));
  }
  // Each FK is valid, although this import belongs to another project.
  node.run('p', 'other', 'cross', JSON.stringify({ evidence: ['cross-s'] }));
  snippet.run('p', 'other', 'cross-s', JSON.stringify({ source: 'src', locator: 'L', quote: '교차 근거' }));
}
const rows = (db: Database.Database) => db.prepare('SELECT * FROM ontology_review_evidence_keys ORDER BY project_id, import_id, node_id, source_id, locator, quote').all();

describe('검토 근거 스냅숏 보충', () => {
  it('기존 구현과 다섯 연결 방식 및 여러 사업·판의 행 집합이 같다', () => {
    const old = database(); const current = database();
    try {
      seed(old); seed(current); legacyBackfill(old); backfillReviewEvidenceKeys(current);
      expect(rows(current)).toEqual(rows(old));
      expect(rows(current).length).toBeGreaterThan(0);
    } finally { old.close(); current.close(); }
  });

  it('완료한 판은 시작 시 다시 읽지 않지만 삭제 직전 사업 재검사는 새 근거를 보존한다', () => {
    const db = database();
    try {
      seed(db); backfillReviewEvidenceKeys(db);
      db.prepare('INSERT INTO ontology_snippets VALUES (?, ?, ?, ?)').run('p', 'old', 'later', JSON.stringify({ source: 'src', locator: 'L', quote: '나중 근거', proves: ['n1'] }));
      backfillReviewEvidenceKeys(db);
      expect(rows(db).some((r) => (r as {quote:string}).quote === '나중 근거')).toBe(false);
      backfillReviewEvidenceKeys(db, 'p');
      expect(rows(db).some((r) => (r as {quote:string}).quote === '나중 근거')).toBe(true);
    } finally { db.close(); }
  });

  it('중간 오류가 나면 판의 완료 표시와 근거가 함께 되돌아가고 재시도된다', () => {
    const db = database();
    try {
      seed(db);
      db.prepare('UPDATE ontology_snippets SET data_json = ? WHERE project_id = ? AND import_id = ? AND id = ?').run('{', 'p', 'old', 's2');
      expect(() => backfillReviewEvidenceKeys(db)).toThrow();
      expect(rows(db)).toEqual([]);
      db.prepare('UPDATE ontology_snippets SET data_json = ? WHERE project_id = ? AND import_id = ? AND id = ?').run(JSON.stringify({source:'src', locator:'L2', quote:'복구', proves:['n1']}), 'p', 'old', 's2');
      backfillReviewEvidenceKeys(db);
      expect(rows(db).length).toBeGreaterThan(0);
    } finally { db.close(); }
  });

  it('빈 판은 완료 처리하지 않아 나중에 생긴 그래프를 보충한다', () => {
    const db = database();
    try {
      db.prepare('INSERT INTO projects VALUES (?)').run('p');
      db.prepare('INSERT INTO ontology_imports VALUES (?, ?)').run('empty', 'p');
      backfillReviewEvidenceKeys(db);
      db.prepare('INSERT INTO ontology_nodes VALUES (?, ?, ?, ?)').run('p', 'empty', 'n', JSON.stringify({ evidence: ['s'] }));
      db.prepare('INSERT INTO ontology_snippets VALUES (?, ?, ?, ?)').run('p', 'empty', 's', JSON.stringify({ source: 'src', locator: 'L', quote: '새 근거' }));
      backfillReviewEvidenceKeys(db);
      expect(rows(db)).toMatchObject([{ node_id: 'n', quote: '새 근거' }]);
    } finally { db.close(); }
  });
});
