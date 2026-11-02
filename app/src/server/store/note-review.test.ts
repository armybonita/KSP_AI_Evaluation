import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CREATE_TABLES_SQL } from './schema';
import { isReviewableNodeType } from '../../lib/reviewable-node';
import { getGraphReviewHref } from '../../app/projects/[projectId]/toc/initial-toc-section';
import { createProject, getReportTargets } from './db';
import { getProjectOntologyGraph, replaceProjectOntology } from './ontology';
import { confirmNoteLink, rejectNoteLink, evidenceSufficiency, getConfirmedNoteCount, getCurrentNoteStatus, getFactorNoteStatuses, getNoteReviewData, getNoteReviewItemIds, saveNoteReview, type NoteEvidence } from './note-review';
import { stableNodeId, nodeHash } from '../ontology/node-id';
import { indicatorOmissions } from './visibility';
import type { OntologyGraph } from '../ontology/types';

afterEach(() => vi.unstubAllEnvs());

function setup() {
  const db = new Database(':memory:'); db.pragma('foreign_keys = ON'); db.exec(CREATE_TABLES_SQL);
  for (const id of ['a','b']) createProject({id,name:id,created_at:'2026-01-01'},db);
  const graph:OntologyGraph = {code:'fake',projectName:'fake',project:{},sources:{},snippets:{},nodes:{short:{type:'outcome-short',title:'단기',description:'초안'},mid:{type:'outcome-mid',title:'중기',description:'판단'},en:{type:'enabler',title:'요인'}},edges:[],candidates:[{source:'short',target:'mid',relation:'extends_to'}],reports:{},report_status:{},issues:[]};
  const imp=replaceProjectOntology('a',graph,'test',db);
  return {db,imp};
}
const input = {status:'확정',text:'판단',outcomeState:'미확인',reason:'',errorType:''};

// The fixed list checks both the actual graph links and the independently built review list.
function expectReviewLinks(db: Database.Database, expected: string[]) {
  const graph = getProjectOntologyGraph('a', db);
  const reviewIds = getNoteReviewData('a', db).items.map((item) => item.id).sort();
  expect(reviewIds).toEqual(expected);
  const links = graph.nodes.map((node) => getGraphReviewHref('a', node, reviewIds)).filter((href): href is string => href !== null).sort();
  expect(links).toEqual(expected.map((id) => `/projects/a/review?nodeId=${encodeURIComponent(id)}`).sort());
}

describe('노트 검토',()=>{
  it('최신 확정 건수는 현재 상태와 동일 ID 이력만 반영하고 검토 화면용 요인 상태를 보존한다', () => {
    const { db, imp } = setup();
    saveNoteReview('a', imp.id, 'short', { ...input, text: '초안' }, '시험', db);
    saveNoteReview('a', imp.id, 'en', { ...input, text: '요인 문안', reason: '가상 정정', errorType: '기타' }, '시험', db);
    expect(getConfirmedNoteCount('a', db)).toBe(2);
    expect(getFactorNoteStatuses('a', db)).toContainEqual({ id: 'en', type: 'enabler', title: '요인', status: '수정 후 확정' });
    const next = replaceProjectOntology('a', {
      code: 'fake', projectName: 'fake', project: {}, sources: {}, snippets: {},
      nodes: { short: { type: 'outcome-short', title: '단기' }, mid: { type: 'outcome-mid', title: '중기' }, en: { type: 'enabler', title: '요인' } },
      edges: [], reports: {}, report_status: {}, issues: [],
    }, 'test', db, '2030-01-01');
    expect(getCurrentNoteStatus('a', 'short', db)).toBe('확정');
    expect(getConfirmedNoteCount('a', db)).toBe(2);
    db.prepare(`INSERT INTO ontology_note_reviews (id,project_id,import_id,node_id,status,text,original_text,outcome_state,reason,error_type,reviewer,created_at)
      VALUES ('direct-latest','a',?,'short','수정 중','현재','','','','','시험','2030')`).run(next.id);
    expect(getCurrentNoteStatus('a', 'short', db)).toBe('수정 중');
    expect(getConfirmedNoteCount('a', db)).toBe(1);
    db.close();
  });

  it('요인 상태는 같은 ID의 이전 가져오기 이력을 읽고 현재 가져오기의 더 최신 상태를 우선한다', () => {
    const { db, imp } = setup();
    saveNoteReview('a', imp.id, 'en', { ...input, text: '이전 판단', reason: '가상 사유', errorType: '기타' }, '시험', db);
    const next = replaceProjectOntology('a', {
      code: 'fake', projectName: 'fake', project: {}, sources: {}, snippets: {},
      nodes: { short: { type: 'outcome-short', title: '단기' }, mid: { type: 'outcome-mid', title: '중기' }, en: { type: 'enabler', title: '요인' } },
      edges: [], reports: {}, report_status: {}, issues: [],
    }, 'test', db, '2030-01-01');
    expect(getFactorNoteStatuses('a', db)).toContainEqual({ id: 'en', type: 'enabler', title: '요인', status: '수정 후 확정' });
    saveNoteReview('a', next.id, 'en', { ...input, status: '수정 중' }, '시험', db);
    expect(getFactorNoteStatuses('a', db)).toContainEqual({ id: 'en', type: 'enabler', title: '요인', status: '수정 중' });
    db.close();
  });

  it('요인 경로 상태는 alias의 과거 ID 검토를 승계하지 않고 현재 ID의 최신 검토만 쓴다', () => {
    const { db, imp } = setup();
    db.prepare(`INSERT INTO ontology_nodes (id,project_id,import_id,node_type,title,data_json) VALUES ('old-factor','a',?,'enabler','가상 이전 요인','{}')`).run(imp.id);
    db.prepare(`INSERT INTO ontology_review_node_keys (project_id,import_id,node_id,node_type) VALUES ('a',?,'old-factor','enabler')`).run(imp.id);
    saveNoteReview('a', imp.id, 'old-factor', { ...input, reason: '가상 사유', errorType: '기타' }, '시험', db);
    const next = replaceProjectOntology('a', {
      code: 'fake', projectName: 'fake', project: {}, sources: {}, snippets: {},
      nodes: { 'new-factor': { type: 'enabler', title: '가상 새 요인' } },
      edges: [], reports: {}, report_status: {}, issues: [],
    }, 'test', db, '2031-01-01');
    db.prepare(`INSERT INTO ontology_review_node_aliases (project_id,import_id,old_node_id,new_node_id) VALUES ('a',?,'old-factor','new-factor')`).run(imp.id);
    expect(getFactorNoteStatuses('a', db)).toContainEqual({ id: 'new-factor', type: 'enabler', title: '가상 새 요인', status: '미검토' });
    saveNoteReview('a', next.id, 'new-factor', { ...input, status: '수정 중' }, '시험', db);
    expect(getFactorNoteStatuses('a', db)).toContainEqual({ id: 'new-factor', type: 'enabler', title: '가상 새 요인', status: '수정 중' });
    db.close();
  });

  it('경로 요인 제목과 ID에서 저장된 금지 문구 및 일반 금지 패턴을 가린다', () => {
    const { db, imp } = setup();
    const banned = '민감한 자료의 부정적 결과';
    db.prepare(`INSERT INTO documents (id,project_id,file_name,file_type,status,created_at) VALUES ('mask-doc','a','가상 자료','txt','ready','2026')`).run();
    db.prepare(`INSERT INTO paragraphs (id,document_id,sequence_no,location,content) VALUES ('mask-paragraph','mask-doc',1,'1쪽',?)`).run(banned);
    db.prepare(`INSERT INTO sentences (id,document_id,paragraph_id,sequence_no,location,content,is_citation_banned) VALUES ('mask-sentence','mask-doc','mask-paragraph',1,'1쪽',?,1)`).run(banned);
    const insertNode = db.prepare(`INSERT INTO ontology_nodes (id,project_id,import_id,node_type,title,data_json) VALUES (?, 'a', ?, 'enabler', ?, '{}')`);
    insertNode.run(banned, imp.id, banned);
    insertNode.run('policy-비보도-sensitive', imp.id, '비보도 요청 내용');
    const factors = getFactorNoteStatuses('a', db);
    const storedBan = factors.find(item => item.title === '[인용 금지 문장]');
    expect(storedBan?.id).toMatch(/^masked-[0-9a-f]{20}$/);
    expect(factors.find(item => item.id === 'policy-비보도-sensitive')).toBeUndefined();
    const regexMaskedId = factors.find(item => item.title === '[인용 금지 문장]' && item.id.startsWith('masked-'));
    expect(regexMaskedId).toBeDefined();
    expect(factors.some(item => item.id.includes('비보도'))).toBe(false);
    const graph = getProjectOntologyGraph('a', db, false);
    const graphStatuses = getFactorNoteStatuses('a', db, graph.nodes);
    expect(graphStatuses.find(item => item.id === banned)?.title).toBe('[인용 금지 문장]');
    expect(graphStatuses.find(item => item.id === 'policy-비보도-sensitive')?.title).toBe('[인용 금지 문장]');
    const graphOnly = getFactorNoteStatuses('a', db, [
      { id: 'missing-factor', type: 'constraint', title: banned },
      { id: 'en', type: 'enabler', title: '비보도 새 이름' },
    ]);
    expect(graphOnly.find(item => item.id === 'missing-factor')).toEqual({ id: 'missing-factor', type: 'constraint', title: '[인용 금지 문장]', status: '미검토' });
    expect(graphOnly.find(item => item.id === 'en')?.title).toBe('[인용 금지 문장]');
    db.close();
  });

  it('3,000개 노트·15,000개 근거와 1,000개 금지 문구에서 확정 건수는 20ms 이내다', () => {
    const db = new Database(':memory:'); db.pragma('foreign_keys = ON'); db.exec(CREATE_TABLES_SQL);
    createProject({ id: 'a', name: 'a', created_at: '2026-01-01' }, db);
    const currentImport = replaceProjectOntology('a', {
      code: 'fake', projectName: 'fake', project: {}, sources: {}, snippets: {},
      nodes: {},
      edges: [], reports: {}, report_status: {}, issues: [],
    }, 'test', db, '2032-01-01');
    db.prepare(`INSERT INTO documents (id,project_id,file_name,file_type,status,created_at) VALUES ('count-doc','a','가상 자료','txt','ready','2026')`).run();
    const paragraph = db.prepare(`INSERT INTO paragraphs (id,document_id,sequence_no,location,content) VALUES (?, 'count-doc', ?, ?, ?)`);
    const sentence = db.prepare(`INSERT INTO sentences (id,document_id,paragraph_id,sequence_no,location,content,is_citation_banned) VALUES (?, 'count-doc', ?, ?, ?, ?, 1)`);
    const insertNode = db.prepare(`INSERT INTO ontology_nodes (id,project_id,import_id,node_type,title,data_json) VALUES (?, 'a', ?, 'outcome-short', ?, '{}')`);
    const insertReview = db.prepare(`INSERT INTO ontology_note_reviews (id,project_id,import_id,node_id,status,text,original_text,outcome_state,reason,error_type,reviewer,created_at) VALUES (?, 'a', ?, ?, '확정','','','','','','시험','2026')`);
    const insertKey = db.prepare(`INSERT INTO ontology_review_node_keys (project_id,import_id,node_id,node_type) VALUES ('a', ?, ?, 'outcome-short')`);
    const evidence = db.prepare(`INSERT INTO ontology_review_evidence_keys (project_id,import_id,node_id,source_id,locator,quote) VALUES ('a', ?, ?, 'source', ?, '가상 근거')`);
    db.transaction(() => {
      for (let n = 0; n < 1000; n++) {
        const p = `count-p-${n}`, text = `가상 금지 문구 ${n} 입니다.`;
        paragraph.run(p, n, `${n + 1}쪽`, text);
        sentence.run(`count-s-${n}`, p, n, `${n + 1}쪽`, text);
      }
      for (let n = 0; n < 3000; n++) {
        const id = `count-${n}`;
        insertNode.run(id, currentImport.id, id);
        insertKey.run(currentImport.id, id);
        insertReview.run(`count-review-${n}`, currentImport.id, id);
        for (let e = 0; e < 5; e++) evidence.run(currentImport.id, id, `${n}-${e}`);
      }
    })();
    const started = performance.now();
    expect(getConfirmedNoteCount('a', db)).toBe(3000);
    expect(performance.now() - started).toBeLessThanOrEqual(20);
    db.close();
  });

  it('요인 3,000개와 검토 이력 3,000개의 최신 상태 조회는 200ms 이내다(부하 중 측정 여유)', () => {
    const { db, imp } = setup();
    const currentImport = replaceProjectOntology('a', {
      code: 'fake', projectName: 'fake', project: {}, sources: {}, snippets: {},
      nodes: { short: { type: 'outcome-short', title: '단기', description: '초안' }, mid: { type: 'outcome-mid', title: '중기', description: '판단' } },
      edges: [], reports: {}, report_status: {}, issues: [],
    }, 'test', db, '2031-01-01');
    db.prepare(`INSERT INTO ontology_review_node_aliases (project_id,import_id,old_node_id,new_node_id) VALUES ('a',?,'legacy-short','scale-0')`).run(imp.id);
    db.prepare(`INSERT INTO ontology_review_node_keys (project_id,import_id,node_id,node_type) VALUES ('a',?,'legacy-short','outcome-short')`).run(imp.id);
    db.prepare(`INSERT INTO ontology_note_reviews (id,project_id,import_id,node_id,status,text,original_text,outcome_state,reason,error_type,reviewer,created_at)
      VALUES ('legacy-review','a',?,'legacy-short','확정','','','','','','시험','2030')`).run(imp.id);
    const addDoc = db.prepare(`INSERT INTO documents (id,project_id,file_name,file_type,status,doc_type,is_included,masked,approved_ai,is_past_final_report,created_at) VALUES (?, 'a', ?, 'txt','ready','종료평가보고서',1,1,'solar',1,'2026')`);
    const paragraph = db.prepare(`INSERT INTO paragraphs (id,document_id,sequence_no,location,content) VALUES (?, ?, ?, ?, ?)`);
    const sentence = db.prepare(`INSERT INTO sentences (id,document_id,paragraph_id,sequence_no,location,content,is_citation_banned) VALUES (?, ?, ?, ?, ?, ?, 1)`);
    const insertNode = db.prepare(`INSERT INTO ontology_nodes (id,project_id,import_id,node_type,title,data_json) VALUES (?, 'a', ?, 'enabler', ?, '{}')`);
    const insertReview = db.prepare(`INSERT INTO ontology_note_reviews (id,project_id,import_id,node_id,status,text,original_text,outcome_state,reason,error_type,reviewer,created_at) VALUES (?, 'a', ?, ?, '확정','','','','','','시험','2026')`);
    const insertKey = db.prepare(`INSERT INTO ontology_review_node_keys (project_id,import_id,node_id,node_type) VALUES ('a', ?, ?, 'enabler')`);
    const evidence = db.prepare(`INSERT INTO ontology_review_evidence_keys (project_id,import_id,node_id,source_id,locator,quote) VALUES ('a', ?, ?, 'source', ?, '가상 근거')`);
    db.transaction(() => {
      for (let n = 0; n < 1000; n++) {
        const p = `scale-p-${n}`, text = `가상 금지 문구 ${n} 입니다.`;
        const doc = `scale-doc-${n}`;
        addDoc.run(doc, `가상 제외 문서 이름 ${n}.pdf`);
        paragraph.run(p, doc, n, `${n + 1}쪽`, text);
        sentence.run(`scale-s-${n}`, doc, p, n, `${n + 1}쪽`, text);
      }
      for (let n = 0; n < 3000; n++) {
        const id = `scale-${n}`;
        insertNode.run(id, currentImport.id, id);
        insertKey.run(currentImport.id, id);
        insertReview.run(`scale-review-${n}`, currentImport.id, id);
        for (let e = 0; e < 5; e++) evidence.run(currentImport.id, id, `${n}-${e}`);
      }
    })();
    const graph = getProjectOntologyGraph('a', db, false);
    expect(graph.nodes.filter(node => node.type === 'enabler')).toHaveLength(3000);
    const started = performance.now();
    expect(getFactorNoteStatuses('a', db, graph.nodes)).toHaveLength(3000);
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThanOrEqual(200);
    db.close();
  });
  it('지표 서술 제외는 보고서의 판정·자격·인용 조건을 따른다', () => {
    vi.stubEnv('AIEAS_AI_PROVIDER', 'solar');
    const { db } = setup();
    const addDoc = db.prepare(`INSERT INTO documents (id,project_id,file_name,file_type,status,doc_type,is_included,masked,approved_ai,is_past_final_report,created_at)
      VALUES (?, 'a', ?, 'txt','ready','사업계획서',1,1,?,0,'2026')`);
    addDoc.run('indicator-source', '가상 지표 원문', 'solar');
    addDoc.run('indicator-evidence', '가상 미승인 근거', 'none');
    db.prepare(`INSERT INTO documents (id,project_id,file_name,file_type,status,doc_type,is_included,masked,approved_ai,is_past_final_report,created_at)
      VALUES ('past-evidence','a','가상 과거 근거','txt','ready','종료평가보고서',1,1,'solar',1,'2026'),
        ('unknown-evidence','a','가상 자격 미확인 근거','txt','ready','기타',1,1,'solar',NULL,'2026')`).run();
    db.prepare(`INSERT INTO paragraphs (id,document_id,sequence_no,location,content) VALUES ('indicator-paragraph','indicator-source',1,'1쪽','가상 인용')`).run();
    db.prepare(`INSERT INTO paragraphs (id,document_id,sequence_no,location,content) VALUES ('indicator-banned-paragraph','indicator-source',2,'2쪽','비보도 요청입니다')`).run();
    db.prepare(`INSERT INTO sentences VALUES ('indicator-banned-sentence','indicator-source','indicator-banned-paragraph',1,'2쪽','비보도 요청입니다',1)`).run();
    const insertIndicator = db.prepare(`INSERT INTO indicators (id,project_id,level,name,ovi,mov,source_doc_id,created_at)
      VALUES (?, 'a','성과',?,'가상 확인 기준',NULL,'indicator-source','2026')`);
    const insertSuggestion = db.prepare(`INSERT INTO suggestions (id,indicator_id,verdict_status,proposal_text,created_at)
      VALUES (?,?,?,'가상 제안','2026')`);
    const insertConfirmation = db.prepare(`INSERT INTO confirmations (id,indicator_id,suggestion_id,confirmation_type,edited_verdict_status,confirmer_name,created_at)
      VALUES (?, ?, ?, '확정',?,'시험',?)`);
    const insertEvidence = db.prepare(`INSERT INTO evidences (id,suggestion_id,quote,document_id,location,speaker)
      VALUES (?,?,?,?,'1쪽','가상 발화자')`);
    insertIndicator.run('unverified-indicator', '가상 미확인 지표');
    insertSuggestion.run('unverified-suggestion', 'unverified-indicator', '미확인');
    insertConfirmation.run('unverified-confirmation', 'unverified-indicator', 'unverified-suggestion', '미확인', '2026');
    insertEvidence.run('unverified-evidence', 'unverified-suggestion', '가상 인용', 'indicator-source');
    insertIndicator.run('ineligible-indicator', '가상 자격 제외 지표');
    insertSuggestion.run('ineligible-suggestion', 'ineligible-indicator', '실현');
    insertConfirmation.run('ineligible-confirmation', 'ineligible-indicator', 'ineligible-suggestion', null, '2026');
    insertEvidence.run('ineligible-evidence', 'ineligible-suggestion', '가상 인용', 'indicator-evidence');
    for (const [id, name] of [['mismatch', '가상 불일치 지표'], ['banned', '가상 금지 근거 지표']] as const) {
      insertIndicator.run(`${id}-indicator`, name);
      insertSuggestion.run(`${id}-suggestion`, `${id}-indicator`, '실현');
      insertConfirmation.run(`${id}-confirmation`, `${id}-indicator`, `${id}-suggestion`, null, '2026');
      insertEvidence.run(`${id}-evidence`, `${id}-suggestion`, id === 'mismatch' ? '원문과 다른 가상 인용' : '가상 인용', 'indicator-source');
    }
    db.prepare(`UPDATE evidences SET is_citation_banned = 1 WHERE id = 'banned-evidence'`).run();
    for (const [id, name, evidenceDocs] of [
      ['mixed', '가상 과거·적격 혼합 지표', ['indicator-source', 'past-evidence']],
      ['unknown-doc', '가상 자격 미확인 지표', ['unknown-evidence']],
    ] as const) {
      insertIndicator.run(`${id}-indicator`, name);
      insertSuggestion.run(`${id}-suggestion`, `${id}-indicator`, '실현');
      insertConfirmation.run(`${id}-confirmation`, `${id}-indicator`, `${id}-suggestion`, null, '2026');
      evidenceDocs.forEach((documentId, index) => insertEvidence.run(`${id}-evidence-${index}`, `${id}-suggestion`, documentId === 'indicator-source' ? '가상 인용' : '가상 근거', documentId));
    }
    insertIndicator.run('ordered-indicator', '가상 최신 확인순서 지표');
    insertSuggestion.run('ordered-current-suggestion', 'ordered-indicator', '미확인');
    insertConfirmation.run('ordered-current-confirmation', 'ordered-indicator', 'ordered-current-suggestion', null, '2026-03-01');
    insertEvidence.run('ordered-current-evidence', 'ordered-current-suggestion', '가상 인용', 'indicator-source');
    insertSuggestion.run('ordered-old-suggestion', 'ordered-indicator', '미확인');
    insertConfirmation.run('ordered-old-confirmation', 'ordered-indicator', 'ordered-old-suggestion', null, '2026-02-01');
    insertIndicator.run('modified-indicator', '가상 수정 확정 지표');
    db.prepare(`INSERT INTO confirmations (id,indicator_id,suggestion_id,confirmation_type,initial_proposal,edited_text,edited_verdict_status,reason,confirmer_name,created_at)
      VALUES ('modified-confirmation','modified-indicator',NULL,'수정 후 확정','가상 초안','가상 수정 확정 문안','미확인','가상 수정 사유','시험','2026')`).run();
    insertIndicator.run('modified-with-evidence-indicator', '가상 근거 있는 수정 확정 지표');
    insertSuggestion.run('modified-with-evidence-suggestion', 'modified-with-evidence-indicator', '실현');
    db.prepare(`INSERT INTO confirmations (id,indicator_id,suggestion_id,confirmation_type,initial_proposal,edited_text,edited_verdict_status,reason,confirmer_name,created_at)
      VALUES ('modified-with-evidence-confirmation','modified-with-evidence-indicator','modified-with-evidence-suggestion','수정 후 확정','가상 초안','가상 수정 확정 문안','실현','가상 수정 사유','시험','2026')`).run();
    insertEvidence.run('modified-with-evidence-evidence', 'modified-with-evidence-suggestion', '없는 가상 인용', 'indicator-evidence');
    insertIndicator.run('modified-unverified-indicator', '가상 미확인 수정 확정 지표');
    insertSuggestion.run('modified-unverified-suggestion', 'modified-unverified-indicator', '실현');
    db.prepare(`INSERT INTO confirmations (id,indicator_id,suggestion_id,confirmation_type,initial_proposal,edited_text,edited_verdict_status,reason,confirmer_name,created_at)
      VALUES ('modified-unverified-confirmation','modified-unverified-indicator','modified-unverified-suggestion','수정 후 확정','가상 초안','가상 수정 확정 문안','미확인','가상 수정 사유','시험','2026')`).run();
    insertEvidence.run('modified-unverified-evidence', 'modified-unverified-suggestion', '가상 인용', 'indicator-source');
    insertIndicator.run('modified-banned-indicator', '가상 금지 수정 확정 지표');
    insertSuggestion.run('modified-banned-suggestion', 'modified-banned-indicator', '실현');
    db.prepare(`INSERT INTO confirmations (id,indicator_id,suggestion_id,confirmation_type,initial_proposal,edited_text,edited_verdict_status,reason,confirmer_name,created_at)
      VALUES ('modified-banned-confirmation','modified-banned-indicator','modified-banned-suggestion','수정 후 확정','가상 초안','비보도 요청입니다','실현','가상 수정 사유','시험','2026')`).run();
    insertEvidence.run('modified-banned-evidence', 'modified-banned-suggestion', '가상 인용', 'indicator-source');
    const insertMissingSourceIndicator = db.prepare(`INSERT INTO indicators (id,project_id,level,name,ovi,mov,source_doc_id,created_at)
      VALUES (?, 'a','성과',?,'가상 확인 기준',NULL,NULL,'2026')`);
    insertMissingSourceIndicator.run('missing-source-modified-indicator', '가상 원문 출처 없는 수정 확정 지표');
    insertSuggestion.run('missing-source-modified-suggestion', 'missing-source-modified-indicator', '실현');
    db.prepare(`INSERT INTO confirmations (id,indicator_id,suggestion_id,confirmation_type,initial_proposal,edited_text,edited_verdict_status,reason,confirmer_name,created_at)
      VALUES ('missing-source-modified-confirmation','missing-source-modified-indicator','missing-source-modified-suggestion','수정 후 확정','가상 초안','가상 수정 문안','실현','가상 수정 사유','시험','2026')`).run();
    insertEvidence.run('missing-source-modified-evidence', 'missing-source-modified-suggestion', '가상 인용', 'indicator-source');
    insertMissingSourceIndicator.run('missing-source-confirmed-indicator', '가상 원문 출처 없는 일반 확정 지표');
    insertSuggestion.run('missing-source-confirmed-suggestion', 'missing-source-confirmed-indicator', '실현');
    insertConfirmation.run('missing-source-confirmation', 'missing-source-confirmed-indicator', 'missing-source-confirmed-suggestion', null, '2026');
    insertEvidence.run('missing-source-confirmed-evidence', 'missing-source-confirmed-suggestion', '가상 인용', 'indicator-source');
    const modifiedReportTarget = getReportTargets('a', db, undefined, ['modified-with-evidence-indicator'])[0];
    expect(modifiedReportTarget.latestConfirmation.confirmation_type).toBe('수정 후 확정');
    expect(modifiedReportTarget.verdictStatus).toBe('실현');
    expect(modifiedReportTarget.evidences).toHaveLength(1);
    expect(indicatorOmissions('a', db)).toEqual(expect.arrayContaining([
      { name: '가상 미확인 지표', reason: '판정 미확인이라 서술 제외' },
      { name: '가상 자격 제외 지표', reason: 'AI 사용 미승인' },
      { name: '가상 불일치 지표', reason: '검증 통과 근거 없음' },
      { name: '가상 금지 근거 지표', reason: '검증 통과 근거 없음' },
      { name: '가상 자격 미확인 지표', reason: '근거 문단 없음' },
      { name: '가상 최신 확인순서 지표', reason: '판정 미확인이라 서술 제외' },
      { name: '가상 수정 확정 지표', reason: '근거 문단 없음' },
      { name: '가상 미확인 수정 확정 지표', reason: '판정 미확인이라 서술 제외' },
      { name: '가상 금지 수정 확정 지표', reason: '금지 문장 겹침으로 서술 제외' },
      { name: '가상 원문 출처 없는 일반 확정 지표', reason: '지표 원문 출처 문서 확인 불가' },
    ]));
    expect(indicatorOmissions('a', db).some(item => item.name === '가상 과거·적격 혼합 지표')).toBe(false);
    expect(indicatorOmissions('a', db).some(item => item.name === '가상 근거 있는 수정 확정 지표')).toBe(false);
    expect(indicatorOmissions('a', db).some(item => item.name === '가상 원문 출처 없는 수정 확정 지표')).toBe(false);
    db.close();
  });

  it('초기 ToC 검토 링크의 ID는 사업별 최신 노트 검토 항목과 일치한다', () => {
    const { db } = setup();
    const graph: OntologyGraph = { code: 'fake', projectName: 'fake', project: {}, sources: {}, snippets: {}, nodes: {
      latest: { type: 'indicator', title: '새 지표' }, ignored: { type: 'project', title: '사업' },
      output: { type: 'output', title: '산출' }, constraint: { type: 'constraint', title: '제약' },
      'split-a': { type: 'outcome-mid', title: '분할 성과 가' }, 'split-b': { type: 'outcome-mid', title: '분할 성과 나' },
      unusual: { type: 'outcome-mid-extra', title: '알 수 없는 종류' }, activity: { type: 'activity', title: '활동' },
    }, edges: [], reports: {}, report_status: {}, issues: [] };
    replaceProjectOntology('a', graph, 'test', db, '2030-01-01');
    replaceProjectOntology('b', { ...graph, nodes: { other: { type: 'enabler', title: '다른 사업' } } }, 'test', db, '2030-01-01');
    for (const [projectId, expected] of [
      ['a', ['constraint', 'latest', 'output', 'split-a', 'split-b']],
      ['b', ['other']],
    ] as const) {
      const actual = getProjectOntologyGraph(projectId, db).nodes.filter((node) => isReviewableNodeType(node.type)).map((node) => node.id).sort();
      expect(actual).toEqual(expected);
      expect(getNoteReviewData(projectId, db).items.map((item) => item.id).sort()).toEqual(expected);
    }
    db.close();
  });
  it('수정 사유와 잠금을 강제하고 최초 문안과 이력을 보존한다',()=>{
    const {db,imp}=setup();
    expect(()=>saveNoteReview('a',imp.id,'mid',{...input,text:'고친 문안'},'담당',db)).toThrow('사유');
    saveNoteReview('a',imp.id,'mid',{...input,text:'고친 문안',reason:'근거 수정',errorType:'근거 부족'},'담당',db);
    expect(()=>saveNoteReview('a',imp.id,'mid',input,'담당',db)).toThrow('새 이력');
    saveNoteReview('a',imp.id,'mid',{...input,status:'수정 중',text:'고친 문안'},'담당',db);
    const history=getNoteReviewData('a',db).items.find(i=>i.id==='mid')!.history;
    expect(history.map(h=>h.status)).toEqual(['수정 후 확정','수정 중']);
    expect(history[0].original_text).toBe('판단');
    expect(()=>saveNoteReview('b',imp.id,'mid',input,'담당',db)).toThrow();
    db.close();
  });
  it('보완과 제외에 사유가 필요하고 연결 후보 확정을 사업별로 저장한다',()=>{
    const {db,imp}=setup();
    for (const status of ['보완 필요','채택 제외']) expect(()=>saveNoteReview('a',imp.id,'mid',{...input,status},'담당',db)).toThrow('사유');
    expect(getNoteReviewData('a',db).items.find(i=>i.id==='mid')!.candidates[0].status).toBe('AI 후보');
    expect(()=>confirmNoteLink('b',imp.id,'short','mid','담당',db)).toThrow();
    confirmNoteLink('a',imp.id,'short','mid','담당',db);
    expect(getNoteReviewData('a',db).items.find(i=>i.id==='mid')!.candidates[0].status).toBe('확정'); db.close();
  });
  it('사유와 오류 유형을 함께 요구하고 재생성 후 이력을 승계한다', () => {
    const { db, imp } = setup();
    for (const status of ['수정 후 확정', '보완 필요', '채택 제외', '수정 의견']) {
      expect(() => saveNoteReview('a', imp.id, 'mid', { ...input, status, reason: '사유' }, '담당', db)).toThrow('오류 유형');
    }
    saveNoteReview('a', imp.id, 'mid', input, '담당', db);
    saveNoteReview('a', imp.id, 'en', { ...input, text: '요인' }, '담당', db);
    const graph: OntologyGraph = { code: 'fake', projectName: 'fake', project: {}, sources: {}, snippets: {}, nodes: { mid: { type: 'outcome-mid', title: '중기', description: '판단' } }, edges: [], reports: {}, report_status: {}, issues: [] };
    const next = replaceProjectOntology('a', graph, 'test', db, '2030-01-01');
    const data = getNoteReviewData('a', db);
    expect(data.importId).toBe(next.id);
    expect(data.items[0].history[0].status).toBe('확정');
    expect(data.missingReviewedCount).toBe(1);
    expect(getCurrentNoteStatus('a', 'mid', db)).toBe('확정');
    expect(() => saveNoteReview('a', next.id, 'mid', input, '담당', db)).toThrow('새 이력');
    for (const table of ['ontology_note_reviews', 'ontology_link_reviews']) {
      if (table === 'ontology_link_reviews') db.prepare("INSERT INTO ontology_link_reviews VALUES ('l', 'a', ?, 's', 't', '확정', '담당', '2026')").run(imp.id);
      expect(() => db.prepare(`UPDATE ${table} SET reviewer = '변경'`).run()).toThrow();
      expect(() => db.prepare(`DELETE FROM ${table}`).run()).toThrow();
    }
    expect(() => db.prepare('DELETE FROM ontology_imports WHERE id = ?').run(imp.id)).toThrow();
    db.close();
  });
  it('현재 회차의 수정중 상태가 이전 회차의 확정 이력보다 우선한다', () => {
    const { db, imp } = setup();
    saveNoteReview('a', imp.id, 'mid', input, '담당', db);
    const next = replaceProjectOntology('a', {
      code: 'fake', projectName: 'fake', project: {}, sources: {}, snippets: {},
      nodes: { mid: { type: 'outcome-mid', title: '중기', description: '판단' } },
      edges: [], reports: {}, report_status: {}, issues: [],
    }, 'test', db, '2030-01-01');
    db.prepare(`INSERT INTO ontology_note_reviews (id,project_id,import_id,node_id,status,text,original_text,outcome_state,reason,error_type,reviewer,created_at)
      VALUES ('current-in-progress','a',?,'mid','수정 중','현재 수정 문안','판단','미확인','','','담당','2030')`).run(next.id);
    expect(getCurrentNoteStatus('a', 'mid', db)).toBe('수정 중');
    db.close();
  });
  it('후보는 확정 전 관계가 아니고 확정 뒤 그래프에서 읽힌다', () => {
    const { db, imp } = setup();
    expect(getProjectOntologyGraph('a', db).edges).toEqual([]);
    expect(getProjectOntologyGraph('a', db, false).nodes).toEqual(getProjectOntologyGraph('a', db).nodes);
    confirmNoteLink('a', imp.id, 'short', 'mid', '담당', db);
    expect(getProjectOntologyGraph('a', db).edges).toContainEqual({ source: 'short', target: 'mid', relation: 'extends_to' });
    expect(getProjectOntologyGraph('a', db, false).edges).toEqual([]);
    db.close();
  });
  it('연결 확정은 재생성에서 안정 키로 유지하고 없어진 끝을 집계한다', () => {
    const { db, imp } = setup();
    confirmNoteLink('a', imp.id, 'short', 'mid', '담당', db);
    const graph: OntologyGraph = { code:'fake', projectName:'fake', project:{}, sources:{}, snippets:{}, nodes:{short:{type:'outcome-short',title:'단기'},mid:{type:'outcome-mid',title:'중기'}}, edges:[], candidates:[{source:'short',target:'mid',relation:'extends_to'}], reports:{},report_status:{},issues:[] };
    replaceProjectOntology('a', graph, 'test', db, '2030-01-01');
    expect(getNoteReviewData('a',db).items.find(i=>i.id==='mid')!.candidates[0].status).toBe('확정');
    expect(getProjectOntologyGraph('a',db).edges).toContainEqual({source:'short',target:'mid',relation:'extends_to'});
    delete graph.nodes.short;
    replaceProjectOntology('a', graph, 'test', db, '2031-01-01');
    expect(getNoteReviewData('a',db).missingLinkCount).toBe(1);
    expect(getNoteReviewData('a',db).items.find(i=>i.id==='mid')!.candidates).toEqual([]);
    expect(getProjectOntologyGraph('a',db).edges).toEqual([]);
    db.close();
  });
  it('기각에는 사유와 유형이 필요하고 재생성 후에도 이력만 남는다', () => {
    const {db,imp}=setup();
    expect(()=>rejectNoteLink('a',imp.id,'short','mid','extends_to','','기타','담당',db)).toThrow();
    expect(()=>rejectNoteLink('a',imp.id,'short','mid','extends_to','사유','','담당',db)).toThrow();
    rejectNoteLink('a',imp.id,'short','mid','extends_to','오분류','기타','담당',db);
    const graph: OntologyGraph = { code:'fake', projectName:'fake', project:{}, sources:{}, snippets:{}, nodes:{short:{type:'outcome-short',title:'단기'},mid:{type:'outcome-mid',title:'중기'}}, edges:[], candidates:[{source:'short',target:'mid',relation:'extends_to'}], reports:{},report_status:{},issues:[] };
    replaceProjectOntology('a',graph,'test',db,'2030-01-01');
    const item=getNoteReviewData('a',db).items.find(i=>i.id==='mid')!;
    expect(item.candidates).toEqual([]);
    expect(item.linkHistory?.[0]).toMatchObject({status:'기각',reason:'오분류',error_type:'기타'});
    expect(getProjectOntologyGraph('a',db).edges).toEqual([]);
    db.close();
  });
  it('같은 문서 위치와 문장의 이름 변경은 별도 이력으로 보여주고 자동 승계하지 않는다', () => {
    const {db}=setup();
    const graph: OntologyGraph = { code:'fake', projectName:'fake', project:{}, sources:{doc:{title:'가상 문서'}}, snippets:{s:{source:'doc',locator:'1쪽',quote:'가상 근거 문장의 내용입니다',proves:['old']}}, nodes:{old:{type:'outcome-mid',title:'가상 성과 개선',description:'판단'}}, edges:[], reports:{},report_status:{},issues:[] };
    const first=replaceProjectOntology('a',graph,'test',db,'2030-01-01');
    saveNoteReview('a',first.id,'old',input,'담당',db);
    graph.nodes = {new:{type:'outcome-mid',title:'가상 성과 개선안',description:'판단'}};
    graph.snippets.s.proves=['new'];
    graph.snippets.s.quote='가상 근거 문장의 내용입나다';
    replaceProjectOntology('a',graph,'test',db,'2031-01-01');
    const item=getNoteReviewData('a',db).items[0];
    expect(item.history).toEqual([]);
    expect(item.renamedHistory?.[0].node_id).toBe('old');
    expect(getNoteReviewItemIds('a',db)).toEqual(getNoteReviewData('a',db).items.map(item => item.id));
    db.close();
  });
  it('공유 문단 하나만 가진 무관한 이름은 변경 힌트가 아니다', () => {
    const {db}=setup();
    const graph: OntologyGraph = {code:'fake',projectName:'fake',project:{},sources:{doc:{title:'가상'}},snippets:{s:{source:'doc',locator:'1쪽',quote:'같은 가상 근거 문단',proves:['old']}},nodes:{old:{type:'outcome-mid',title:'참여자 역량 강화',description:'판단'}},edges:[],reports:{},report_status:{},issues:[]};
    const first=replaceProjectOntology('a',graph,'test',db,'2030-01-01');
    saveNoteReview('a',first.id,'old',input,'담당',db);
    graph.nodes={new:{type:'outcome-mid',title:'시설 운영 개선',description:'판단'}};
    graph.snippets.s.proves=['new'];
    replaceProjectOntology('a',graph,'test',db,'2031-01-01');
    expect(getNoteReviewData('a',db).items[0].renamedHistory).toEqual([]);
    db.close();
  });
  it('서로 다른 근거 두 건이 겹치면 이름이 달라도 변경 힌트를 보인다', () => {
    const {db}=setup();
    const graph: OntologyGraph = {code:'fake',projectName:'fake',project:{},sources:{doc:{title:'가상'}},snippets:{s1:{source:'doc',locator:'1쪽',quote:'첫 번째 가상 근거',proves:['old']},s2:{source:'doc',locator:'2쪽',quote:'두 번째 가상 근거',proves:['old']}},nodes:{old:{type:'outcome-mid',title:'가상 성과 개선',description:'판단'}},edges:[],reports:{},report_status:{},issues:[]};
    const first=replaceProjectOntology('a',graph,'test',db,'2030-01-01');
    saveNoteReview('a',first.id,'old',input,'담당',db);
    graph.nodes={new:{type:'outcome-mid',title:'가상 성과 향상',description:'판단'}};
    graph.snippets.s1.proves=['new']; graph.snippets.s2.proves=['new'];
    replaceProjectOntology('a',graph,'test',db,'2031-01-01');
    expect(getNoteReviewData('a',db).items[0].renamedHistory?.map(h=>h.node_id)).toEqual(['old']);
    db.close();
  });
  it('상세 없는 옛 확정은 단일 후보로 관계를 추정하지 않고 목록만 보인다', () => {
    const {db,imp}=setup();
    db.prepare("INSERT INTO ontology_link_reviews VALUES ('legacy','a',?,'short','mid','확정','담당','2026')").run(imp.id);
    const data=getNoteReviewData('a',db);
    expect(data.unknownRelationLinks).toHaveLength(1);
    expect(data.unknownRelationLinks[0]).toMatchObject({source_id:'short',target_id:'mid',relation:''});
    expect(data.unknownLinkCount).toBe(0);
    expect(data.items.find(i=>i.id==='mid')!.candidates[0]).toMatchObject({status:'AI 후보', unknownRelation:true});
    expect(getProjectOntologyGraph('a',db).edges).toEqual([]);
    confirmNoteLink('a',imp.id,'short','mid','담당',db,'extends_to');
    expect(getProjectOntologyGraph('a',db).edges).toContainEqual({source:'short',target:'mid',relation:'extends_to'});
    const resolved=getNoteReviewData('a',db); expect(resolved.unknownRelationLinks).toHaveLength(0); expect(resolved.items.find(i=>i.id==='mid')!.linkHistory).toHaveLength(2);
    db.close();
  });
  it('종류 불명으로 보존된 노트와 연결은 같은 키 재등장 때 실형으로 이력을 읽는다', () => {
    const {db,imp}=setup();
    db.prepare("INSERT INTO ontology_review_node_keys VALUES ('a', ?, 'lost', '종류 불명')").run(imp.id);
    db.prepare("INSERT INTO ontology_note_reviews VALUES ('lost-review','a',?,'lost','확정','판단','판단','미확인','','','담당','2026')").run(imp.id);
    db.prepare("INSERT INTO ontology_link_reviews VALUES ('lost-link','a',?,'short','lost','확정','담당','2026')").run(imp.id);
    db.prepare("INSERT INTO ontology_link_review_details VALUES ('lost-link','extends_to','','')").run();
    expect(getNoteReviewData('a',db).unknownReviewedCount).toBe(1);
    const graph: OntologyGraph = {code:'fake',projectName:'fake',project:{},sources:{},snippets:{},nodes:{short:{type:'outcome-short',title:'단기'},lost:{type:'outcome-mid',title:'재등장'}},edges:[],candidates:[{source:'short',target:'lost',relation:'extends_to'}],reports:{},report_status:{},issues:[]};
    replaceProjectOntology('a',graph,'test',db,'2031-01-01');
    // An older snapshot can survive migration; it must neither duplicate the review nor supply its type.
    db.prepare("INSERT INTO ontology_nodes VALUES ('short','a',?,'output','구 단기','{}')").run(imp.id);
    db.prepare("INSERT INTO ontology_nodes VALUES ('lost','a',?,'enabler','구 요인','{}')").run(imp.id);
    db.prepare("INSERT INTO ontology_review_evidence_keys VALUES ('a', ?, 'lost', 'doc-2023', '1쪽', '2023년 가상 성과')").run(imp.id);
    const data=getNoteReviewData('a',db);
    db.prepare("INSERT INTO ontology_review_evidence_keys VALUES ('a', ?, 'lost', 'doc-2024', '1쪽', '2024년 가상 성과')").run(data.importId);
    const item=getNoteReviewData('a',db).items.find(i=>i.id==='lost')!;
    expect(item.history).toEqual([]);
    expect(item.uncertainHistory?.map(h=>h.id)).toEqual(['lost-review']);
    expectReviewLinks(db, ['lost', 'short']);
    expect(item.candidates[0].status).toBe('AI 후보');
    expect(data.unknownReviewedCount).toBe(1);
    expect(getProjectOntologyGraph('a',db).edges).toEqual([]);
    db.prepare("INSERT INTO ontology_review_evidence_keys VALUES ('a', ?, 'lost', 'doc', '1쪽', '같은 가상 근거 문장')").run(imp.id);
    db.prepare("INSERT INTO ontology_review_evidence_keys VALUES ('a', ?, 'lost', 'doc', '2쪽', '같은 가상 근거 문장')").run(data.importId);
    const attached = getNoteReviewData('a',db);
    expect(attached.items.find(i=>i.id==='lost')!.history.map(h=>h.id)).toEqual(['lost-review']);
    expect(getProjectOntologyGraph('a',db).edges).toContainEqual({source:'short',target:'lost',relation:'extends_to'});
    db.close();
  });
  it('같은 옛 키라도 회차별 대응 노드에 검토와 연결을 따로 붙인다', () => {
    const {db,imp}=setup();
    saveNoteReview('a',imp.id,'mid',input,'첫 담당',db);
    confirmNoteLink('a',imp.id,'short','mid','첫 담당',db);
    const graph: OntologyGraph = {code:'fake',projectName:'fake',project:{},sources:{},snippets:{},nodes:{short:{type:'outcome-short',title:'단기'},mid:{type:'outcome-mid',title:'다른 중기',description:'판단'}},edges:[],candidates:[{source:'short',target:'mid',relation:'extends_to'}],reports:{},report_status:{},issues:[]};
    const second=replaceProjectOntology('a',graph,'test',db,'2030-01-01');
    // The legacy numbering collision is represented as two independent historical records.
    db.prepare("INSERT INTO ontology_note_reviews VALUES ('second-review','a',?,'mid','확정','판단','판단','미확인','','','둘째 담당','2030')").run(second.id);
    db.prepare("INSERT INTO ontology_link_reviews VALUES ('second-link','a',?,'short','mid','확정','둘째 담당','2030')").run(second.id);
    db.prepare("INSERT INTO ontology_link_review_details VALUES ('second-link','extends_to','','')").run();
    graph.nodes={short:{type:'outcome-short',title:'단기'},first:{type:'outcome-mid',title:'첫 중기'},second:{type:'outcome-mid',title:'둘째 중기'}};
    graph.candidates=[{source:'short',target:'first',relation:'extends_to'},{source:'short',target:'second',relation:'extends_to'}];
    replaceProjectOntology('a',graph,'test',db,'2031-01-01');
    db.prepare("INSERT INTO ontology_review_node_aliases VALUES ('a',?,'mid','first')").run(imp.id);
    db.prepare("INSERT INTO ontology_review_node_aliases VALUES ('a',?,'mid','second')").run(second.id);
    const current=getNoteReviewData('a',db).importId;
    for (const [oldImport, node] of [[imp.id, 'first'], [second.id, 'second']]) {
      db.prepare("INSERT INTO ontology_review_evidence_keys VALUES ('a', ?, 'mid', 'doc', '1', '가상')").run(oldImport);
      db.prepare("INSERT INTO ontology_review_evidence_keys VALUES ('a', ?, ?, 'doc', '1', '가상')").run(current, node);
    }
    const data=getNoteReviewData('a',db);
    expect(getNoteReviewItemIds('a',db)).toEqual(data.items.map(item => item.id));
    const first=data.items.find(i=>i.id==='first')!, other=data.items.find(i=>i.id==='second')!;
    expect(first.history.map(h=>h.reviewer)).toEqual(['첫 담당']);
    expect(other.history.map(h=>h.reviewer)).toEqual(['둘째 담당']);
    expect(first.candidates[0].status).toBe('확정');
    expect(other.candidates[0].status).toBe('확정');
    expect(first.linkHistory?.map(h=>h.reviewer)).toEqual(['첫 담당']);
    expect(other.linkHistory?.map(h=>h.reviewer)).toEqual(['둘째 담당']);
    db.close();
  });
  it('옛 키는 현재 노드면 유지하고 새 노드로 갈라지면 자동 승계하지 않는다', () => {
    const {db,imp}=setup(); saveNoteReview('a',imp.id,'mid',input,'담당',db); confirmNoteLink('a',imp.id,'short','mid','담당',db);
    db.prepare("INSERT INTO ontology_review_node_aliases VALUES ('a',?,'mid','HASH')").run(imp.id);
    let data=getNoteReviewData('a',db); expect(data.items.find(i=>i.id==='mid')!.history).toHaveLength(1); expect(data.missingReviewedCount).toBe(0);
    expect(getProjectOntologyGraph('a',db).edges).toContainEqual({source:'short',target:'mid',relation:'extends_to'});
    const graph: OntologyGraph = {code:'fake',projectName:'fake',project:{},sources:{},snippets:{},nodes:{short:{type:'outcome-short',title:'단기'},'HASH-A':{type:'outcome-mid',title:'중기'},'HASH-B':{type:'outcome-mid',title:'중기'}},edges:[],reports:{},report_status:{},issues:[]};
    replaceProjectOntology('a',graph,'test',db,'2031'); data=getNoteReviewData('a',db);
    expect(getNoteReviewItemIds('a',db)).toEqual(data.items.map(item => item.id));
    db.prepare("INSERT INTO ontology_review_evidence_keys VALUES ('a', ?, 'mid', 'doc', '1', '같은 가상 근거')").run(imp.id);
    db.prepare("INSERT INTO ontology_review_evidence_keys VALUES ('a', ?, 'HASH-A', 'doc', '1', '같은 가상 근거')").run(data.importId);
    data=getNoteReviewData('a',db);
    expectReviewLinks(db, ['HASH-A', 'HASH-B', 'short']);
    expect(data.splitReviewedCount).toBe(2); expect(data.missingReviewedCount).toBe(0);
    for (const item of data.items.filter(i=>i.id.startsWith('HASH'))) { expect(item.history).toEqual([]); expect(item.splitHistory).toHaveLength(1); }
    expect(['HASH-A', 'HASH-B'].map(id => getCurrentNoteStatus('a', id, db))).toEqual(['미검토', '미검토']);
    expect(getProjectOntologyGraph('a',db).edges).toEqual([]); db.close();
  });
  it('해시 노트와 연결 분할은 재검토까지 이력을 보존한다', () => {
    const {db}=setup(); const mid=stableNodeId(`P${nodeHash('a',6)}`,'outcome-mid','가상 중기');
    const graph: OntologyGraph = {code:'fake',projectName:'fake',project:{},sources:{},snippets:{},nodes:{short:{type:'outcome-short',title:'단기'},[mid]:{type:'outcome-mid',title:'가상 중기',description:'판단'}},edges:[],candidates:[{source:'short',target:mid,relation:'extends_to'}],reports:{},report_status:{},issues:[]};
    const first=replaceProjectOntology('a',graph,'test',db,'2030'); saveNoteReview('a',first.id,mid,input,'담당',db); confirmNoteLink('a',first.id,'short',mid,'담당',db);
    const a=`${mid}-${nodeHash('문서1',10)}`, b=`${mid}-${nodeHash('문서2',10)}`;
    graph.nodes={short:graph.nodes.short,[a]:{type:'outcome-mid',title:'가상 중기',description:'판단'},[b]:{type:'outcome-mid',title:'가상 중기',description:'판단'}};
    graph.candidates=[a,b].map(target=>({source:'short',target,relation:'extends_to'}));
    const next=replaceProjectOntology('a',graph,'test',db,'2031'); let data=getNoteReviewData('a',db);
    expect([data.missingReviewedCount,data.missingLinkCount,data.splitReviewedCount,data.splitLinkCount]).toEqual([0,0,2,2]);
    for (const id of [a,b]) { const item=data.items.find(i=>i.id===id)!; expect(item.history).toHaveLength(0); expect(item.splitHistory).toHaveLength(1); expect(item.splitLinkHistory).toHaveLength(1); expect(item.candidates[0]).toMatchObject({status:'AI 후보',splitLink:true}); }
    expect(getProjectOntologyGraph('a',db).edges).toEqual([]);
    saveNoteReview('a',next.id,a,input,'담당',db); confirmNoteLink('a',next.id,'short',a,'담당',db); data=getNoteReviewData('a',db);
    expect(data.splitReviewedCount).toBe(1); expect(data.splitLinkCount).toBe(1); expect(data.items.find(i=>i.id===a)).toMatchObject({splitPending:false}); expect(data.items.find(i=>i.id===a)!.splitHistory).toHaveLength(1); expect(data.items.find(i=>i.id===a)!.candidates[0].splitLink).toBe(false);
    saveNoteReview('a',next.id,b,{...input,status:'채택 제외',reason:'중복',errorType:'기타'},'담당',db); rejectNoteLink('a',next.id,'short',b,'extends_to','중복','기타','담당',db); data=getNoteReviewData('a',db);
    expect([data.splitReviewedCount,data.splitLinkCount]).toEqual([0,0]); expect(data.items.find(i=>i.id===b)!.splitLinkHistory).toHaveLength(1); db.close();
  });
  it('해시 바탕 키에서 단일 접미사로 바뀌면 검토를 승계한다', () => {
    const {db}=setup(); const id=stableNodeId(`P${nodeHash('a',6)}`,'outcome-mid','가상 중기');
    const graph: OntologyGraph = {code:'fake',projectName:'fake',project:{},sources:{},snippets:{},nodes:{[id]:{type:'outcome-mid',title:'가상 중기',description:'판단'}},edges:[],reports:{},report_status:{},issues:[]};
    const first=replaceProjectOntology('a',graph,'test',db,'2030'); saveNoteReview('a',first.id,id,input,'담당',db);
    const next=`${id}-${nodeHash('문서',10)}`; graph.nodes={[next]:graph.nodes[id]}; const second=replaceProjectOntology('a',graph,'test',db,'2031');
    db.prepare("INSERT INTO ontology_review_evidence_keys VALUES ('a', ?, ?, 'doc', '1', '이전')").run(first.id,id);
    db.prepare("INSERT INTO ontology_review_evidence_keys VALUES ('a', ?, ?, 'doc', '2', '새 근거')").run(second.id,next);
    expect(getNoteReviewData('a',db).items.find(i=>i.id===next)!.history).toHaveLength(1); db.close();
  });
  it('근거가 겹치지 않는 단일 대응은 나뉨으로 보존한다', () => {
    const {db}=setup(); const base=stableNodeId(`P${nodeHash('a',6)}`,'outcome-mid','가상 성과');
    const graph: OntologyGraph = {code:'fake',projectName:'fake',project:{},sources:{},snippets:{},nodes:{[base]:{type:'outcome-mid',title:'가상 성과',description:'판단'}},edges:[],reports:{},report_status:{},issues:[]};
    const old=replaceProjectOntology('a',graph,'test',db,'2030'); saveNoteReview('a',old.id,base,input,'담당',db);
    const nextId=`${base}-${nodeHash('문서',10)}`; graph.nodes={[nextId]:graph.nodes[base]};
    const nextImport = replaceProjectOntology('a',graph,'test',db,'2031'); const data=getNoteReviewData('a',db);
    expect(data.splitReviewedCount).toBe(1); expect(data.items[0]).toMatchObject({history:[],splitPending:true}); expect(data.items[0].splitHistory).toHaveLength(1);
    db.prepare(`INSERT INTO ontology_note_reviews (id,project_id,import_id,node_id,status,text,original_text,outcome_state,reason,error_type,reviewer,created_at)
      VALUES ('current-split-progress','a',?,?,'수정 중','가상 현재 수정','판단','미확인','','','담당','2031')`).run(nextImport.id, nextId);
    expect(getCurrentNoteStatus('a', nextId, db)).toBe('미검토');
    db.close();
  });
  it('두 분할 노트와 연결이 합쳐지면 양쪽 이력을 보존하고 재확인한다', () => {
    const {db}=setup(); const base=stableNodeId(`P${nodeHash('a',6)}`,'outcome-mid','가상 성과');
    const a=`${base}-${nodeHash('문서1',10)}`, b=`${base}-${nodeHash('문서2',10)}`;
    const node={type:'outcome-mid',title:'가상 성과',description:'판단'};
    const graph: OntologyGraph = {code:'fake',projectName:'fake',project:{},sources:{doc1:{title:'문서1'},doc2:{title:'문서2'}},snippets:{s1:{source:'doc1',locator:'1',quote:'가상 근거1',proves:[a]},s2:{source:'doc2',locator:'1',quote:'가상 근거2',proves:[b]}},nodes:{short:{type:'outcome-short',title:'단기'},[a]:node,[b]:node},edges:[],candidates:[a,b].map(target=>({source:'short',target,relation:'extends_to'})),reports:{},report_status:{},issues:[]};
    const old=replaceProjectOntology('a',graph,'test',db,'2030');
    saveNoteReview('a',old.id,a,input,'첫 담당',db); saveNoteReview('a',old.id,b,{...input,status:'채택 제외',reason:'중복',errorType:'기타'},'둘째 담당',db);
    confirmNoteLink('a',old.id,'short',a,'첫 담당',db); confirmNoteLink('a',old.id,'short',b,'둘째 담당',db);
    graph.nodes={short:graph.nodes.short,[base]:node}; graph.snippets={s1:{source:'doc1',locator:'1',quote:'가상 근거1',proves:[base]}}; graph.candidates=[{source:'short',target:base,relation:'extends_to'}];
    const next=replaceProjectOntology('a',graph,'test',db,'2031'); let data=getNoteReviewData('a',db); let item=data.items.find(i=>i.id===base)!;
    expect(getNoteReviewItemIds('a',db)).toEqual(data.items.map(item => item.id));
    expectReviewLinks(db, ['OUT-M-PCA9781-HF8CE6C0072F7C14D', 'short']);
    expect(item).toMatchObject({history:[],mergeCount:2,splitPending:true}); expect(item.splitHistory?.map(h=>h.reviewer)).toEqual(['첫 담당','둘째 담당']); expect(item.splitHistory?.map(h=>h.old_title)).toEqual(['가상 성과','가상 성과']);
    expect(item.splitLinkHistory?.map(h=>h.reviewer)).toEqual(['첫 담당','둘째 담당']); expect(item.candidates[0]).toMatchObject({status:'AI 후보',splitLink:true}); expect([data.splitReviewedCount,data.splitLinkCount]).toEqual([1,1]); expect(getProjectOntologyGraph('a',db).edges).toEqual([]);
    saveNoteReview('a',next.id,base,input,'새 담당',db); rejectNoteLink('a',next.id,'short',base,'extends_to','검토','기타','새 담당',db);
    data=getNoteReviewData('a',db); item=data.items.find(i=>i.id===base)!; expect([data.splitReviewedCount,data.splitLinkCount]).toEqual([0,0]); expect(item.splitPending).toBe(false); expect(item.splitLinkHistory).toHaveLength(2); db.close();
  });
  it('두 근거가 같아도 무관한 제목은 이름 변경 힌트가 아니다', () => {
    const {db}=setup(); const graph: OntologyGraph = {code:'fake',projectName:'fake',project:{},sources:{doc:{title:'가상'}},snippets:{s1:{source:'doc',locator:'1',quote:'가상 근거 첫째',proves:['old']},s2:{source:'doc',locator:'2',quote:'가상 근거 둘째',proves:['old']}},nodes:{old:{type:'outcome-mid',title:'참여자 역량 강화',description:'판단'}},edges:[],reports:{},report_status:{},issues:[]};
    const first=replaceProjectOntology('a',graph,'test',db,'2030'); saveNoteReview('a',first.id,'old',input,'담당',db);
    graph.nodes={next:{type:'outcome-mid',title:'농가 소득 증대',description:'판단'}}; graph.snippets.s1.proves=['next']; graph.snippets.s2.proves=['next']; replaceProjectOntology('a',graph,'test',db,'2031');
    expect(getNoteReviewData('a',db).items[0].renamedHistory).toEqual([]); db.close();
  });
  it('관측은 서로 다른 문서로 세고 입증은 한 건이면 충분하다',()=>{
    const ev=(sourceId:string,level:string):NoteEvidence=>({id:sourceId,sourceId,level,quote:'가상',sourceTitle:'가상',date:'',speaker:'',location:'',verified:true,match:100});
    expect(evidenceSufficiency([ev('a','관측'),ev('a','관측')])).toBe('검토 중');
    expect(evidenceSufficiency([ev('a','관측'),ev('b','관측')])).toBe('충분');
    expect(evidenceSufficiency([ev('a','입증')])).toBe('충분');
    expect(evidenceSufficiency([ev('a','추정')])).toBe('추가 확인');
  });
});
