import { afterEach, expect, it } from 'vitest';
import JSZip from 'jszip';
import { extractDocx } from '../src/server/extract';
import { getIndicatorNaturalKey, normalizeLevel, parsePdmParagraphs, parsePdmParagraphsLegacy } from '../src/lib/baseline-key';
import { closeDatabase, createConfirmation, createDocument, createIndicator, createProject, insertParagraphs, openDatabase } from '../src/server/store';
import { getOrSyncTocForProject, syncTocForProject } from '../src/server/toc';
import { PDM_PARSER_VERSION, withTocSourceFingerprint } from '../src/server/store/toc-fingerprint';

const cell = (text: string, props = '') => `<w:tc><w:tcPr>${props}</w:tcPr><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:tc>`;
const merge = '<w:vMerge/>';
const restart = '<w:vMerge w:val="restart"/>';
const row = (...cells: string[]) => `<w:tr>${cells.join('')}</w:tr>`;

async function fixture() {
  const zip = new JSZip();
  const rows = [
    row(cell('분류', restart), cell('구분', restart), cell('성과지표', restart), cell('실적 및 목표치', '<w:gridSpan w:val="5"/>'), cell('검증 수단', restart)),
    row(cell('', merge), cell('', merge), cell('', merge), ...['2024', '2025', '2026', '2027', '2028'].map(y => cell(y)), cell('', merge)),
    row(cell('Activity/ Output', restart), cell('가상 자문', restart), cell('완성률'), ...['40%', '100%', '-', '-', '-'].map(x => cell(x)), cell('최종보고서')),
    row(cell('', merge), cell('후속 계획'), cell('제안 개수'), ...['-', '1개', '-', '-', '-'].map(x => cell(x)), cell('계획서')),
    row(cell('', merge), cell('네트워크', restart), cell('만족도'), ...['4점', '', '-', '-', '-'].map(x => cell(x)), cell('설문')),
    row(cell('', merge), cell('', merge), cell('면담 횟수'), ...['1회', '2회', '-', '-', '-'].map(x => cell(x)), cell('종료보고서')),
    row(cell('Outcome'), cell('정책 계획'), cell('회의 건수'), ...['-', '-', '1건', '-', '-'].map(x => cell(x)), cell('회의록')),
    row(cell('Impact'), cell('파급'), cell('확산도'), ...['-', '-', '-', '-', '5점'].map(x => cell(x)), cell('조사')),
  ];
  zip.file('word/document.xml', `<w:document><w:body><w:tbl><w:tblGrid>${'<w:gridCol/>'.repeat(9)}</w:tblGrid>${rows.join('')}</w:tbl></w:body></w:document>`);
  return zip.generateAsync({ type: 'nodebuffer' });
}

afterEach(() => closeDatabase());

it('가상 DOCX 격자와 병합 표를 추출하고 동기화해 계획을 보존한다', async () => {
  const extracted = await extractDocx(await fixture());
  expect(extracted.status).toBe('추출 완료');
  expect(extracted.paragraphs.find(p => p.content === '검증 수단')).toMatchObject({ table_row: 1, table_col: 9, table_cols: 9 });
  expect(extracted.paragraphs.find(p => p.content === '설문')).toMatchObject({ table_row: 5, table_col: 9 });
  expect(extracted.paragraphs.some(p => p.table_row === 5 && p.table_col === 5)).toBe(false);
  const records = extracted.paragraphs.map((p, i) => ({ ...p, id: `p${i}`, document_id: 'doc' }));
  const parsed = parsePdmParagraphs(records, 'doc');
  expect(parsed).toHaveLength(6);
  expect(parsed.map(p => [p.name, p.level, p.target_value, p.mov])).toEqual([
    ['완성률', '산출물', '100%', '최종보고서'], ['제안 개수', '산출물', '1개', '계획서'],
    ['만족도', '산출물', '4점', '설문'], ['면담 횟수', '산출물', '2회', '종료보고서'],
    ['회의 건수', '중기성과', '1건', '회의록'], ['확산도', '영향', '5점', '조사'],
  ]);
  expect(parsed[3].planDetails).toContainEqual({ label: '구분', value: '네트워크' });
  expect(parsed[0].planDetails).toContainEqual({ label: '2024', value: '40%' });
  expect(parsed[0].planDetails).toContainEqual({ label: '2025', value: '100%' });
  const db = openDatabase(':memory:');
  createProject({ id: 'project', name: '가상 사업', created_at: '2026-11-02' });
  createDocument({ id: 'doc', project_id: 'project', file_name: 'pdm.docx', file_type: 'docx', status: extracted.status, doc_type: '성과관리표', is_included: 1, excluded_reason: null, is_past_final_report: false, created_at: '2026-11-02' });
  insertParagraphs(records);
  const toc = syncTocForProject('project', db)!;
  expect(toc.items).toHaveLength(6);
  const item = toc.items.find(i => i.indicator.name === '완성률')!;
  expect(item.indicator).toMatchObject({ level: '산출물', target_value: '100%', mov: '최종보고서' });
  expect(item.planDetails).toContainEqual({ label: '구분', value: '가상 자문' });
  expect(item.planDetails).toContainEqual({ label: '2024', value: '40%' });
  expect(toc.items.find(i => i.indicator.name === '면담 횟수')?.planDetails).toContainEqual({ label: '구분', value: '네트워크' });
});

it('단계 별칭과 판별 지문을 적용하고 동일 판은 다시 계산하지 않는다', () => {
  expect(['Activity / Output', 'Activity', 'Output', 'Outcome', 'Short-term outcome', '단기', 'Impact', '영향'].map(normalizeLevel)).toEqual(['산출물', '활동', '산출물', '중기성과', '단기성과', '단기성과', '영향', '영향']);
  const db = openDatabase(':memory:');
  createProject({ id: 'project', name: '가상 사업', created_at: '2026-11-02' });
  let calls = 0;
  const run = () => withTocSourceFingerprint('project', db, () => ++calls, () => calls);
  expect(run()).toBe(1);
  expect(run()).toBe(1);
  db.prepare('UPDATE toc_source_fingerprints SET fingerprint = ? WHERE project_id = ?').run(`old-${PDM_PARSER_VERSION}`, 'project');
  expect(run()).toBe(2);
  expect(run()).toBe(2);
});

it('옛 가로합침 좌표 문단은 옛 값을 유지하고 재추출 시 이력을 보존한다', async () => {
  const extracted = await extractDocx(await fixture());
  const db = openDatabase(':memory:');
  createProject({ id: 'project', name: '가상 사업', created_at: '2026-11-02' });
  createDocument({ id: 'doc', project_id: 'project', file_name: 'legacy-pdm.docx', file_type: 'docx', status: extracted.status, doc_type: '성과관리표', is_included: 1, excluded_reason: null, is_past_final_report: false, created_at: '2026-11-02' });

  // Simulate the previous extractor: the merged first header row is stored by
  // physical cell order, shifting the verification header from grid column 9 to column 5.
  const legacyRows = extracted.paragraphs.map(p => ({ ...p, grid_coord_version: null }));
  const firstHeader = legacyRows.filter(p => p.table_row === 1).sort((a, b) => a.table_col! - b.table_col!);
  firstHeader.forEach((p, index) => { p.table_col = index + 1; p.grid_coord_version = null; });
  const records = legacyRows.map((p, i) => ({ ...p, id: `legacy-${i}`, document_id: 'doc' }));
  insertParagraphs(records, db);

  const legacyToc = syncTocForProject('project', db)!;
  expect(legacyToc.warningMessage).toBe('표 다시 읽기 필요(자료를 다시 올리면 정확히 읽습니다)');
  const legacyItem = legacyToc.items.find(item => item.indicator.ovi === '완성률')!;
  expect(legacyItem).toBeDefined();
  const legacyIndicator = legacyItem.indicator;
  expect(legacyIndicator.mov).toBe('100%');
  expect(legacyToc.items.find(item => item.indicator.name === '완성률')?.planDetails).toBeUndefined();

  db.prepare(`INSERT INTO suggestions (id, indicator_id, verdict_status, error_reason, proposal_text, created_at)
    VALUES ('suggestion', ?, '기대', NULL, '가상 확정 제안', '2026-11-02')`).run(legacyIndicator.id);
  createConfirmation({ id: 'confirmation', indicator_id: legacyIndicator.id, confirmation_type: '확정', confirmer_name: '가상 평가자' }, db);
  db.prepare(`INSERT INTO indicator_baselines
    (id, project_id, indicator_id, document_id, document_name, target_value, selected_at, conflict_id, other_doc_id)
    VALUES ('baseline', 'project', ?, 'doc', 'legacy-pdm.docx', '기준 선택값', '2026-11-02', NULL, 'doc')`).run(legacyIndicator.id);

  const legacyAgain = syncTocForProject('project', db)!;
  const legacyAgainItem = legacyAgain.items.find(item => item.indicator.ovi === '완성률')!;
  expect(legacyAgain.warningMessage).toBe('표 다시 읽기 필요(자료를 다시 올리면 정확히 읽습니다)');
  expect(legacyAgainItem.indicator.mov).toBe('100%');
  expect(legacyAgainItem.indicator.id).toBe(legacyIndicator.id);
  expect(db.prepare('SELECT id FROM confirmations WHERE indicator_id = ?').get(legacyIndicator.id)).toEqual({ id: 'confirmation' });
  expect(db.prepare('SELECT id, target_value, conflict_id FROM indicator_baselines WHERE indicator_id = ?').get(legacyIndicator.id)).toEqual({ id: 'baseline', target_value: '기준 선택값', conflict_id: null });

  // Re-extraction replaces the old coordinates and records the grid version.
  db.prepare('DELETE FROM paragraphs WHERE document_id = ?').run('doc');
  insertParagraphs(extracted.paragraphs.map((p, i) => ({ ...p, id: `grid-${i}`, document_id: 'doc' })), db);
  const refreshed = syncTocForProject('project', db)!;
  const refreshedItem = refreshed.items.find(item => item.indicator.ovi === '완성률')!;
  expect(refreshedItem).toBeDefined();
  const refreshedIndicator = refreshedItem.indicator;
  expect(refreshed.warningMessage).not.toBe('표 다시 읽기 필요(자료를 다시 올리면 정확히 읽습니다)');
  expect(refreshedIndicator.id).toBe(legacyIndicator.id);
  expect(refreshedIndicator.mov).toBe('최종보고서');
  expect(refreshedItem.planDetails).toContainEqual({ label: '2025', value: '100%' });
  expect(db.prepare('SELECT id FROM confirmations WHERE indicator_id = ?').get(legacyIndicator.id)).toEqual({ id: 'confirmation' });
  expect(db.prepare('SELECT id, target_value FROM indicator_baselines WHERE indicator_id = ?').get(legacyIndicator.id)).toEqual({ id: 'baseline', target_value: '기준 선택값' });
});


it('구판 지문의 첫 조회는 main 파서의 필드와 키 및 확정·기준 선택을 유지한다', async () => {
  const extracted = await extractDocx(await fixture());
  const records = extracted.paragraphs.map((p, i) => ({ ...p, id: `old-${i}`, document_id: 'doc', grid_coord_version: null }));
  const headers = records.filter(p => p.table_row === 1).sort((a, b) => a.table_col! - b.table_col!);
  headers.forEach((p, index) => { p.table_col = index + 1; });
  const mainResults = parsePdmParagraphsLegacy(records, 'doc');
  const fields = (item: typeof mainResults[number]) => ({ level: item.level, name: item.name, target_value: item.target_value, mov: item.mov, key: getIndicatorNaturalKey(item.level, item.name, item.ovi) });
  const mainDataRow = mainResults.find(item => item.ovi === '완성률')!;
  expect(fields(mainDataRow)).toEqual({ level: '가상 자문', name: '가상 자문', target_value: '40%', mov: '100%', key: '가상자문:::가상자문:::완성률' });
  expect(parsePdmParagraphs(records, 'doc').map(fields)).toEqual(mainResults.map(fields));

  const db = openDatabase(':memory:');
  createProject({ id: 'project', name: '가상 사업', created_at: '2026-11-02' }, db);
  createDocument({ id: 'doc', project_id: 'project', file_name: 'pdm.docx', file_type: 'docx', status: extracted.status, doc_type: '성과관리표', is_included: 1, excluded_reason: null, is_past_final_report: false, created_at: '2026-11-02' }, db);
  insertParagraphs(records, db);
  mainResults.forEach((item, index) => createIndicator({ ...item, id: `main-${index}`, project_id: 'project', is_baseline: 0, created_at: '2026-11-02' }, db));
  const mainId = `main-${mainResults.indexOf(mainDataRow)}`;
  db.prepare("INSERT INTO suggestions (id, indicator_id, verdict_status, error_reason, proposal_text, created_at) VALUES ('old-suggestion', ?, '기대', NULL, '가상 제안', '2026-11-02')").run(mainId);
  createConfirmation({ id: 'old-confirmation', indicator_id: mainId, confirmation_type: '확정', confirmer_name: '가상 평가자' }, db);
  db.prepare(`INSERT INTO indicator_baselines (id, project_id, indicator_id, document_id, document_name, target_value, selected_at, conflict_id, other_doc_id)
    VALUES ('old-baseline', 'project', ?, 'doc', 'pdm.docx', '기준 선택값', '2026-11-02', NULL, 'doc')`).run(mainId);
  withTocSourceFingerprint('project', db, () => null, () => null);
  db.prepare('UPDATE toc_source_fingerprints SET fingerprint = ? WHERE project_id = ?').run('previous-parser-version', 'project');
  const first = getOrSyncTocForProject('project', db)!;
  expect(first.warningMessage).toBe('표 다시 읽기 필요(자료를 다시 올리면 정확히 읽습니다)');
  const item = first.items.find(entry => entry.indicator.id === mainId)!;
  expect(fields(item.indicator as typeof mainDataRow)).toEqual(fields(mainDataRow));
  expect(db.prepare('SELECT id FROM confirmations WHERE indicator_id = ?').get(mainId)).toEqual({ id: 'old-confirmation' });
  expect(db.prepare('SELECT id, target_value FROM indicator_baselines WHERE indicator_id = ?').get(mainId)).toEqual({ id: 'old-baseline', target_value: '기준 선택값' });
  expect(getOrSyncTocForProject('project', db)?.items.find(entry => entry.indicator.id === mainId)?.indicator.id).toBe(mainId);
});
