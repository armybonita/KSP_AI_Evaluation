import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import JSZip from 'jszip';
import answers from '../fixtures/answers.json';
import { extractDocx, extractDocument } from '../src/server/extract';
import {
  closeDatabase,
  createDocument,
  createProject,
  getIndicatorBaseline,
  insertParagraphs,
  openDatabase,
  saveIndicatorBaseline,
} from '../src/server/store';
import { syncTocForProject } from '../src/server/toc';

describe('ToC 실제 추출 → 성과 경로 저장 → 정답표 대조 통합 시험 (IT)', () => {
  const projectId = 'proj-toc-it';
  const fixturesDir = path.resolve(__dirname, '../fixtures');
  const pw = answers.performance_pathway;

  async function createPdmDocxWithTable(): Promise<Buffer> {
    const zip = new JSZip();
    const rows = [
      ['단계', '서술', '지표(OVI)', '검증수단(MoV)', '목표값'],
      ['영향', pw.impact.name, pw.impact.ovi, pw.impact.mov, pw.impact.target_value],
      [
        '중기성과',
        pw.midterm_outcome.name,
        pw.midterm_outcome.ovi,
        pw.midterm_outcome.mov,
        pw.midterm_outcome.target_value,
      ],
      [
        '단기성과',
        pw.shortterm_outcome.name,
        pw.shortterm_outcome.ovi,
        pw.shortterm_outcome.mov,
        pw.shortterm_outcome.target_value,
      ],
      ['산출물', pw.output.name, pw.output.ovi, pw.output.mov, pw.output.target_value],
      ['활동', pw.activity.name, pw.activity.ovi, pw.activity.mov, pw.activity.target_value],
    ];
    const trXmls = rows
      .map((cols) => {
        const tcXmls = cols
          .map((c) => `<w:tc><w:p><w:r><w:t>${c ?? ''}</w:t></w:r></w:p></w:tc>`)
          .join('');
        return `<w:tr>${tcXmls}</w:tr>`;
      })
      .join('');
    const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>성과관리표(PDM)</w:t></w:r></w:p>
    <w:tbl>${trXmls}</w:tbl>
  </w:body>
</w:document>`;
    zip.file('word/document.xml', documentXml);
    return zip.generateAsync({ type: 'nodebuffer' });
  }

  beforeEach(() => {
    openDatabase(':memory:');
    createProject({
      id: projectId,
      name: answers.project_name,
      created_at: new Date().toISOString(),
    });
  });

  afterEach(() => {
    closeDatabase();
  });

  it('표 구조가 없는 02_pdm.docx 는 성과 경로를 만들지 않고 경고를 반환한다 (검수 2회차 1번)', async () => {
    const pdmPath = path.join(fixturesDir, '02_pdm.docx');
    const pdmBuf = fs.readFileSync(pdmPath);
    const pdmExt = await extractDocument(pdmBuf, 'docx');
    expect(pdmExt.status).toBe('추출 완료');

    const pdmDocId = 'doc-02_pdm_notable.docx';
    createDocument({
      id: pdmDocId,
      project_id: projectId,
      file_name: '02_pdm.docx',
      file_type: 'docx',
      status: pdmExt.status,
      doc_type: '성과관리표',
      is_included: 1,
      excluded_reason: null, is_past_final_report: false,
      created_at: new Date().toISOString(),
    });

    insertParagraphs(
      pdmExt.paragraphs.map((p) => ({
        id: crypto.randomUUID(),
        document_id: pdmDocId,
        sequence_no: p.sequence_no,
        location: p.location,
        content: p.content,
        table_row: p.table_row ?? null,
        table_col: p.table_col ?? null,
      }))
    );

    const tocData = syncTocForProject(projectId);
    expect(tocData).not.toBeNull();
    expect(tocData!.hasPdm).toBe(true);
    expect(tocData!.items.length).toBe(0); // 표가 없으므로 경로 비움
    expect(tocData!.warningMessage).toBe('성과관리표에서 표를 찾지 못했습니다');
  });

  it('실제 DOCX 표 추출 → ToC 동기화 → 정답표(answers.json) 대조 및 기준 지표 보존 (AC 1, AC 2, 검수 2회차 1~3번)', async () => {
    // 1. 실제 01_project_plan.hwpx 추출 및 DB 저장
    const planPath = path.join(fixturesDir, '01_project_plan.hwpx');
    const planBuf = fs.readFileSync(planPath);
    const planExt = await extractDocument(planBuf, 'hwpx');
    expect(planExt.status).toBe('추출 완료');

    const planDocId = 'doc-01_project_plan.hwpx';
    createDocument({
      id: planDocId,
      project_id: projectId,
      file_name: '01_project_plan.hwpx',
      file_type: 'hwpx',
      status: planExt.status,
      doc_type: '사업계획서',
      is_included: 1,
      excluded_reason: null, is_past_final_report: false,
      created_at: new Date().toISOString(),
    });

    insertParagraphs(
      planExt.paragraphs.map((p) => ({
        id: crypto.randomUUID(),
        document_id: planDocId,
        sequence_no: p.sequence_no,
        location: p.location,
        content: p.content,
        table_row: p.table_row ?? null,
        table_col: p.table_col ?? null,
      }))
    );

    // 2. 실제 DOCX 표 추출 및 DB 저장
    const pdmTableBuf = await createPdmDocxWithTable();
    const pdmExt = await extractDocx(pdmTableBuf);
    expect(pdmExt.status).toBe('추출 완료');

    const pdmDocId = 'doc-table-pdm.docx';
    createDocument({
      id: pdmDocId,
      project_id: projectId,
      file_name: 'pdm_table.docx',
      file_type: 'docx',
      status: pdmExt.status,
      doc_type: '성과관리표',
      is_included: 1,
      excluded_reason: null, is_past_final_report: false,
      created_at: new Date().toISOString(),
    });

    // table_row, table_col 전달
    insertParagraphs(
      pdmExt.paragraphs.map((p) => ({
        id: crypto.randomUUID(),
        document_id: pdmDocId,
        sequence_no: p.sequence_no,
        location: p.location,
        content: p.content,
        table_row: p.table_row ?? null,
        table_col: p.table_col ?? null,
      }))
    );

    // 3. syncTocForProject 호출 (실제 추출 문단 기반 ToC 동기화)
    const tocData = syncTocForProject(projectId);
    expect(tocData).not.toBeNull();
    expect(tocData!.hasPdm).toBe(true);
    expect(tocData!.items.length).toBe(5);

    // 4. 정답표(answers.json) 대조 (AC 1)
    const items = tocData!.items;

    // 영향
    const impact = items.find((i) => i.indicator.level === '영향')!;
    expect(impact).toBeDefined();
    expect(impact.indicator.name).toBe(pw.impact.name);
    expect(impact.indicator.ovi).toBe(pw.impact.ovi);
    expect(impact.indicator.mov).toBe(pw.impact.mov);
    expect(impact.indicator.target_value).toBe(pw.impact.target_value);

    // 중기성과
    const midterm = items.find((i) => i.indicator.level === '중기성과')!;
    expect(midterm).toBeDefined();
    expect(midterm.indicator.name).toBe(pw.midterm_outcome.name);
    expect(midterm.indicator.ovi).toBe(pw.midterm_outcome.ovi);

    // 단기성과
    const shortterm = items.find((i) => i.indicator.level === '단기성과')!;
    expect(shortterm).toBeDefined();
    expect(shortterm.indicator.name).toBe(pw.shortterm_outcome.name);

    // 산출물
    const output = items.find((i) => i.indicator.level === '산출물')!;
    expect(output).toBeDefined();
    expect(output.indicator.name).toBe(pw.output.name);

    // 활동
    const activity = items.find((i) => i.indicator.level === '활동')!;
    expect(activity).toBeDefined();
    expect(activity.indicator.name).toBe(pw.activity.name);

    // 계층 부모 관계 검증 (영향 -> 중기성과 -> 단기성과 -> 산출물 -> 활동)
    expect(impact.indicator.parent_id).toBeNull();
    expect(midterm.indicator.parent_id).toBe(impact.indicator.id);
    expect(shortterm.indicator.parent_id).toBe(midterm.indicator.id);
    expect(output.indicator.parent_id).toBe(shortterm.indicator.id);
    expect(activity.indicator.parent_id).toBe(output.indicator.id);

    // 5. 지표 충돌 탐지 대조 (AC 2)
    expect(tocData!.conflicts.length).toBe(1);
    const conflict = tocData!.conflicts[0];
    expect(conflict.indicator_id).toBe(impact.indicator.id);
    expect(conflict.doc_a_name).toBe('사업계획서');
    expect(conflict.doc_a_value).toBe('80%');
    expect(conflict.doc_b_name).toBe('성과관리표');
    expect(conflict.doc_b_value).toBe('5점 척도 3.5점');

    // 6. 기준 지표 선택 및 저장: indicator target_value 는 덮어쓰지 않음 (검수 2회차 3번)
    saveIndicatorBaseline({
      id: 'base-impact',
      project_id: projectId,
      indicator_id: impact.indicator.id,
      document_id: planDocId,
      document_name: '사업계획서',
      target_value: '80%',
      selected_at: new Date().toISOString(),
    });

    const savedBase = getIndicatorBaseline(impact.indicator.id);
    expect(savedBase).toBeDefined();
    expect(savedBase!.document_name).toBe('사업계획서');
    expect(savedBase!.target_value).toBe('80%');

    // 재동기화 후 ToC 에 기준 지표 유지 확인 및 indicator.target_value 원본 보존 확인
    const refreshedToc = syncTocForProject(projectId);
    const refreshedImpact = refreshedToc!.items.find((i) => i.indicator.level === '영향')!;
    expect(refreshedImpact.baseline).toBeDefined();
    expect(refreshedImpact.baseline!.document_name).toBe('사업계획서');
    expect(refreshedImpact.baseline!.target_value).toBe('80%');
    expect(refreshedImpact.indicator.target_value).toBe(pw.impact.target_value); // 기준값으로 덮어쓰지 않음
  });
});
