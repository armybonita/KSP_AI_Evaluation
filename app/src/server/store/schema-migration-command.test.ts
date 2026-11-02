import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { openDatabase, closeDatabase, markInterruptedOntologyRunsFailed, markInterruptedSynthesisRunsFailed } from './db';
import { migrateAdditiveSchema } from './additive-migration';
import { CREATE_TABLES_SQL, PORTFOLIO_LEVEL_REVIEWS_SQL } from './schema';
import { migrateExistingEvidencesForCitationBan } from './citation-ban';

it('서버 시작 전 스키마 이관은 진행 중 실행과 근거 보정을 건드리지 않는다', () => {
  const db = openDatabase(':memory:');
  try {
    db.pragma('foreign_keys = ON');
    db.exec(`
      INSERT INTO projects (id, name, created_at) VALUES ('p', '가상 사업', '날짜');
      INSERT INTO ontology_imports (id, project_id, vault_code, imported_at, node_count, edge_count, source_count, snippet_count, error_count, warning_count, executor)
        VALUES ('import', 'p', 'fixture', '날짜', 1, 0, 0, 0, 0, 0, 'fixture');
      INSERT INTO ontology_note_reviews (id, project_id, import_id, node_id, status, text, original_text, outcome_state, reason, error_type, reviewer, created_at)
        VALUES ('prior-review', 'p', 'import', 'outcome', '수정 후 확정', '기존 문안', '최초 문안', '관측됨', '가상 사유', '기타', '가상 평가자', '날짜');
      INSERT INTO ontology_generation_runs (id, project_id, state, created_at, updated_at)
        VALUES ('run', 'p', 'running', '날짜', '날짜');
      INSERT INTO documents (id, project_id, file_name, file_type, status, created_at)
        VALUES ('d', 'p', '가상 문서', 'text', 'ready', '날짜');
      INSERT INTO paragraphs (id, document_id, sequence_no, location, content)
        VALUES ('paragraph', 'd', 1, '첫 위치', '인용이 금지된 가상 문장입니다');
      INSERT INTO sentences (id, document_id, paragraph_id, sequence_no, location, content, is_citation_banned)
        VALUES ('sentence', 'd', 'paragraph', 1, '첫 위치', '인용이 금지된 가상 문장입니다', 1);
      INSERT INTO indicators (id, project_id, level, name, ovi, created_at)
        VALUES ('indicator', 'p', '성과', '가상 지표', '가상', '날짜');
      INSERT INTO suggestions (id, indicator_id, verdict_status, created_at)
        VALUES ('suggestion', 'indicator', '미확인', '날짜');
      INSERT INTO confirmations (id, indicator_id, suggestion_id, confirmation_type, confirmer_name, created_at)
        VALUES ('confirmation', 'indicator', 'suggestion', '확정', '가상 평가자', '날짜');
      INSERT INTO evidences (id, suggestion_id, quote, document_id, location, speaker)
        VALUES ('evidence', 'suggestion', '인용이 금지된 가상 문장입니다', 'd', '첫 위치', '가상');
      DROP INDEX idx_confirmations_suggestion_id;
      DROP INDEX idx_ontology_snippets_project_id_id;
    `);
    const historyBefore = db.prepare('SELECT * FROM confirmations ORDER BY rowid').all();
    db.prepare("INSERT INTO ontology_imports (id, project_id, vault_code, imported_at, node_count, edge_count, source_count, snippet_count, error_count, warning_count, executor) VALUES ('run', 'p', 'fake', '날짜', 0, 0, 0, 1, 0, 0, 'test')").run();
    db.prepare("INSERT INTO ontology_snippets VALUES ('snippet', 'p', 'run', '{\"quote\":\"가상 근거\"}')").run();
    const snippetsBefore = db.prepare('SELECT * FROM ontology_snippets ORDER BY rowid').all();
    db.exec('DROP TABLE ontology_portfolio_level_reviews');
    migrateAdditiveSchema(db);
    expect(db.prepare('SELECT text, status FROM ontology_note_reviews WHERE id=?').get('prior-review'))
      .toEqual({ text: '기존 문안', status: '수정 후 확정' });
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ontology_portfolio_level_reviews'").get()).toEqual({ name: 'ontology_portfolio_level_reviews' });
    db.prepare(`INSERT INTO ontology_portfolio_level_reviews (id, project_id, import_id, node_id, node_type, outcome_family, ai_level, team_level, reviewer, created_at)
      VALUES ('level-review', 'p', 'import', 'outcome', 'outcome-mid', '협력국 정책 반영', 'K2', 'K3', '가상 평가자', '날짜')`).run();
    migrateAdditiveSchema(db);
    expect(db.prepare('SELECT * FROM confirmations ORDER BY rowid').all()).toEqual(historyBefore);
    expect(db.prepare('SELECT * FROM ontology_snippets ORDER BY rowid').all()).toEqual(snippetsBefore);
    expect(db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_ontology_snippets_project_id_id'").get()).toEqual({ sql: 'CREATE INDEX idx_ontology_snippets_project_id_id ON ontology_snippets(project_id, id)' });
    expect(db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_confirmations_suggestion_id'").get()).toEqual({ sql: 'CREATE INDEX idx_confirmations_suggestion_id ON confirmations(suggestion_id)' });
    expect(db.prepare('SELECT state FROM ontology_generation_runs WHERE id = ?').get('run')).toEqual({ state: 'running' });
    expect(db.prepare('SELECT quote, is_citation_banned FROM evidences WHERE id = ?').get('evidence'))
      .toEqual({ quote: '인용이 금지된 가상 문장입니다', is_citation_banned: 0 });

    markInterruptedOntologyRunsFailed(db);
    migrateExistingEvidencesForCitationBan(db);
    expect(db.prepare('SELECT state FROM ontology_generation_runs WHERE id = ?').get('run')).toEqual({ state: 'failed' });
    expect(db.prepare('SELECT quote, is_citation_banned FROM evidences WHERE id = ?').get('evidence'))
      .toEqual({ quote: '인용 금지 문장 있음', is_citation_banned: 1 });
    expect(db.prepare('SELECT team_level FROM ontology_portfolio_level_reviews WHERE id=?').get('level-review'))
      .toEqual({ team_level: 'K3' });
  } finally {
    closeDatabase();
  }
});

it('기존 이력을 보존해 이관하고 사업 삭제 연쇄만 허용한다', () => {
  const db = new Database(':memory:');
  try {
    db.pragma('foreign_keys = ON');
    const oldTable = PORTFOLIO_LEVEL_REVIEWS_SQL
      .replaceAll(' ON DELETE CASCADE', '')
      .replace(' WHEN EXISTS (SELECT 1 FROM projects WHERE id = OLD.project_id)', '');
    db.exec(CREATE_TABLES_SQL.replace(PORTFOLIO_LEVEL_REVIEWS_SQL, oldTable));
    db.exec(`INSERT INTO projects (id, name, created_at) VALUES ('p', '가상 사업', '날짜');
      INSERT INTO ontology_imports (id, project_id, vault_code, imported_at, node_count, edge_count, source_count, snippet_count, error_count, warning_count, executor)
      VALUES ('i', 'p', 'fixture', '날짜', 1, 0, 0, 0, 0, 0, 'fixture');
      INSERT INTO ontology_portfolio_level_reviews (rowid, id, project_id, import_id, node_id, node_type, outcome_family, ai_level, team_level, reviewer, created_at)
      VALUES (4, 'r', 'p', 'i', 'o', 'outcome-mid', '협력국 정책 반영', '', 'K3', '가상 평가자', '날짜');`);
    migrateAdditiveSchema(db);
    migrateAdditiveSchema(db);
    expect(db.prepare('SELECT rowid, team_level FROM ontology_portfolio_level_reviews').all()).toEqual([{ rowid: 4, team_level: 'K3' }]);
    expect(() => db.prepare('DELETE FROM ontology_portfolio_level_reviews').run()).toThrow();
    expect(() => db.prepare('DELETE FROM ontology_imports WHERE id = ?').run('i')).toThrow();
    db.prepare('DELETE FROM projects WHERE id = ?').run('p');
    expect(db.prepare('SELECT count(*) AS n FROM ontology_portfolio_level_reviews').get()).toEqual({ n: 0 });
  } finally {
    db.close();
  }
});


it('기존 요약 색인이 다른 구조이면 이관이 바꾸지 않고 실패한다', () => {
  const db = new Database(':memory:');
  try {
    db.exec(`CREATE TABLE ontology_sources (project_id TEXT, import_id TEXT, id TEXT, data_json TEXT);
      CREATE INDEX idx_ontology_sources_summary ON ontology_sources(project_id);`);
    expect(() => migrateAdditiveSchema(db)).toThrow('unexpected definition');
    expect(db.pragma('index_info(idx_ontology_sources_summary)')).toHaveLength(1);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'ontology_quote_verification_cache_v3'").get()).toBeUndefined();
  } finally {
    db.close();
  }
});

it('기존 레벨 이력의 순서와 추가 전용 보호를 보존하면서 Lv5를 허용한다', () => {
  const db = new Database(':memory:');
  try {
    db.pragma('foreign_keys = ON');
    db.exec(CREATE_TABLES_SQL.replace("'Lv3', 'Lv4', 'Lv5'", "'Lv3', 'Lv4'"));
    db.exec(`INSERT INTO projects (id, name, created_at) VALUES ('p', '가상 사업', '날짜');
      INSERT INTO ontology_imports (id, project_id, vault_code, imported_at, node_count, edge_count, source_count, snippet_count, error_count, warning_count, executor)
      VALUES ('i', 'p', 'fixture', '날짜', 1, 0, 0, 0, 0, 0, 'fixture');
      INSERT INTO ontology_portfolio_level_reviews (rowid, id, project_id, import_id, node_id, node_type, outcome_family, ai_level, team_level, reviewer, created_at)
      VALUES (4, 'r1', 'p', 'i', 'o', 'outcome-mid', '개발협력 촉진', '', 'Lv4', '가상 평가자', '날짜');`);
    migrateAdditiveSchema(db);
    expect(db.prepare('SELECT rowid, team_level FROM ontology_portfolio_level_reviews').all()).toEqual([{ rowid: 4, team_level: 'Lv4' }]);
    db.prepare(`INSERT INTO ontology_portfolio_level_reviews (id, project_id, import_id, node_id, node_type, outcome_family, ai_level, team_level, reviewer, created_at)
      VALUES ('r2', 'p', 'i', 'o', 'outcome-mid', '개발협력 촉진', '', 'Lv5', '가상 평가자', '날짜')`).run();
    migrateAdditiveSchema(db);
    expect(db.prepare('SELECT team_level FROM ontology_portfolio_level_reviews ORDER BY rowid').all()).toEqual([{ team_level: 'Lv4' }, { team_level: 'Lv5' }]);
    expect(() => db.prepare("UPDATE ontology_portfolio_level_reviews SET team_level='Lv3'").run()).toThrow();
    expect(() => db.prepare('DELETE FROM ontology_portfolio_level_reviews').run()).toThrow();
  } finally {
    db.close();
  }
});

it('항목 종합 이관은 반복 가능하며 기존 사업과 실행 행을 바꾸지 않는다', () => {
  const db = openDatabase(':memory:');
  try {
    db.exec(`INSERT INTO projects (id, name, created_at) VALUES ('synth-project', '가상 사업', '날짜');
      INSERT INTO ontology_synthesis_runs (id, project_id, state, started_at) VALUES ('synth-run', 'synth-project', 'running', '날짜');`);
    migrateAdditiveSchema(db);
    migrateAdditiveSchema(db);
    expect(db.prepare('SELECT state, started_at FROM ontology_synthesis_runs WHERE id = ?').get('synth-run')).toEqual({ state: 'running', started_at: '날짜' });
    expect(db.prepare('SELECT name FROM projects WHERE id = ?').get('synth-project')).toEqual({ name: '가상 사업' });
    expect(markInterruptedSynthesisRunsFailed(db)).toBe(1);
    expect(db.prepare('SELECT state, finished_at IS NOT NULL AS finished FROM ontology_synthesis_runs WHERE id = ?').get('synth-run')).toEqual({ state: 'failed', finished: 1 });
    db.prepare("INSERT INTO ontology_synthesis_runs (id, project_id, state, started_at) VALUES ('next-run', 'synth-project', 'queued', '날짜')").run();
  } finally { closeDatabase(); }
});
