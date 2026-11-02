import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { CREATE_TABLES_SQL } from '@/server/store/schema';
import { createDocument, createProject, insertParagraphs, insertSentences } from '@/server/store/db';
import { getLatestSynthesisRun, getSynthesisEligibilityFingerprint, prepareSynthesisResponse, startSynthesisRun, type SynthesisRun } from '@/server/store/synthesis-store';

const banned = '가상의 민감한 내용을 외부에 공개하지 않습니다';
function fixture() {
  const db = new Database(':memory:'); db.exec(CREATE_TABLES_SQL);
  createProject({ id: 'p', name: '가상 사업', created_at: '날짜' }, db);
  for (const id of ['eligible', 'excluded', 'past', 'unknown', 'provider', 'unmasked', 'unfinished']) {
    createDocument({ id, project_id: 'p', file_name: `${id}.txt`, file_type: 'txt', status: id === 'unfinished' ? '읽지 못함' : '추출 완료', doc_type: '성과관리표', is_included: id === 'excluded' ? 0 : 1, excluded_reason: null, masked: id !== 'unmasked', approved_ai: id === 'provider' ? 'other' : 'solar', is_past_final_report: id === 'past' ? true : id === 'unknown' ? null : false, created_at: '날짜' }, db);
    insertParagraphs([{ id: `para-${id}`, document_id: id, sequence_no: 1, location: '한 곳', content: '가상 근거 문장입니다.' }], db);
  }
  insertSentences([{ id: 'ban', document_id: 'eligible', paragraph_id: 'para-eligible', sequence_no: 1, location: '한 곳', content: banned, is_citation_banned: 1 }], db);
  return db;
}
function savedRun(db: Database.Database, items: unknown[]): SynthesisRun {
  const run = startSynthesisRun('p', db)!;
  db.prepare('INSERT INTO ontology_synthesis_eligibility (run_id, fingerprint) VALUES (?, ?)').run(run.id, getSynthesisEligibilityFingerprint('p', db, 'solar'));
  db.prepare("UPDATE ontology_synthesis_runs SET state = 'completed', item_count = ?, result_json = ? WHERE id = ?").run(items.length, JSON.stringify(items), run.id);
  return getLatestSynthesisRun('p', db)!;
}

describe('saved synthesis response', () => {
  it('returns unchanged eligible items and redacts banned strings in both representations without mutating storage', () => {
    const db = fixture();
    const items = [
      { id: 'eligible', cites: ['para-eligible'], state: '관측됨', name: banned, ai: banned, target: banned, actual: banned, verify: banned, met: banned, match: banned, enough: banned, authors: banned, note: banned, fam: banned, lvl: banned, conf: banned, conflict: [banned], links: [{ outcome: banned, relation: '촉진' }] },
      { id: 'empty', cites: [], state: '미확인', note: '근거 자료 미확보' },
    ];
    const saved = savedRun(db, items);
    const original = saved.result_json;
    const response = prepareSynthesisResponse('p', saved, db, 'solar');
    expect(response.result).toHaveLength(2);
    expect(response.result![0]).toMatchObject({ cites: ['para-eligible'], state: '관측됨', name: '[인용 금지 문장]' });
    expect(response.result![1]).toEqual(items[1]);
    expect(JSON.stringify(response)).not.toContain(banned);
    expect(JSON.parse(response.synthesis!.result_json!)).toEqual(response.result);
    expect(saved.result_json).toBe(original);
    db.close();
  });

  it.each([
    ['past status', "UPDATE documents SET is_past_final_report = 1 WHERE id = 'eligible'"],
    ['unknown status', "UPDATE documents SET is_past_final_report = NULL WHERE id = 'eligible'"],
    ['exclusion', "UPDATE documents SET is_included = 0 WHERE id = 'eligible'"],
    ['provider', "UPDATE documents SET approved_ai = 'other' WHERE id = 'eligible'"],
    ['masking', "UPDATE documents SET masked = 0 WHERE id = 'eligible'"],
    ['extraction', "UPDATE documents SET status = '읽지 못함' WHERE id = 'eligible'"],
  ])('hides every item when document eligibility changes: %s', (_label, sql) => {
    const db = fixture();
    const sensitive = '제외된 문서에서 유래한 가상 성과와 수치 80';
    const saved = savedRun(db, [
      { id: 'mixed', cites: ['para-eligible', 'para-excluded'], state: '관측됨', name: sensitive, ai: sensitive, actual: '80%', met: '충족', links: [{ outcome: sensitive, relation: '촉진' }] },
      { id: 'indicator', cites: [], name: sensitive, target: '70%' },
    ]);
    saved.diagnostics = JSON.parse(JSON.stringify({ 5: { candidateNodeCount: 3, partialReason: sensitive } }));
    db.prepare(sql).run();
    const response = prepareSynthesisResponse('p', saved, db, 'solar');
    expect(response).toMatchObject({ state: 'stale', message: '자료 자격이 바뀌어 이전 결과를 숨겼습니다. 다시 실행해 주세요', result: [] });
    expect(response.diagnostics).toEqual({ 5: { candidateNodeCount: 3 } });
    expect(JSON.stringify(response)).not.toContain(sensitive);
    expect(JSON.stringify(response)).not.toContain(banned);
    db.close();
  });

  it('hides all saved items when a forbidden sentence is added after completion', () => {
    const db = fixture();
    const newlyBanned = '새로 금지한 가상 성과 문장입니다';
    const saved = savedRun(db, [{ id: 'item', cites: ['para-eligible'], name: newlyBanned }]);
    insertSentences([{ id: 'new-ban', document_id: 'eligible', paragraph_id: 'para-eligible', sequence_no: 2, location: '한 곳', content: newlyBanned, is_citation_banned: 1 }], db);
    const response = prepareSynthesisResponse('p', saved, db, 'solar');
    expect(response).toMatchObject({ state: 'stale', message: '자료 자격이 바뀌어 이전 결과를 숨겼습니다. 다시 실행해 주세요', result: [] });
    expect(JSON.stringify(response)).not.toContain(newlyBanned);
    db.close();
  });

  it('prepares 200 items and 2,000 distinct citations in under 200 ms', () => {
    const db = fixture();
    const paragraphs = Array.from({ length: 2000 }, (_, i) => ({ id: `large-${i}`, document_id: 'eligible', sequence_no: i + 2, location: '문단', content: '가상 근거' }));
    insertParagraphs(paragraphs, db);
    const saved = savedRun(db, Array.from({ length: 200 }, (_, i) => ({ id: `item-${i}`, cites: paragraphs.slice(i * 10, i * 10 + 10).map(p => p.id), state: '관측됨', note: '' })));
    const started = performance.now();
    const response = prepareSynthesisResponse('p', saved, db, 'solar');
    const elapsed = performance.now() - started;
    expect(response.result).toHaveLength(200);
    expect((response.result![199] as { cites: string[] }).cites).toHaveLength(10);
    expect(elapsed).toBeLessThanOrEqual(200);
    console.info(`합성 GET 데이터 준비: 200항목·2000근거 ${elapsed.toFixed(1)}ms`);
    db.close();
  });
});
