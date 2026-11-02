import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import JSZip from 'jszip';
import answers from '../fixtures/answers.json';
import { extractDocx } from '../src/server/extract';
import {
  closeDatabase,
  createConfirmation,
  createDocument,
  createProject,
  getIndicator,
  getIndicatorBaseline,
  getIndicatorAttribution,
  getParagraphsByDocument,
  getReviewData,
  getTocData,
  IndicatorRecord,
  insertParagraphs,
  listConfirmations,
  listIndicators,
  openDatabase,
  saveIndicatorAttribution,
  saveIndicatorBaseline,
  saveSuggestion,
  updateDocumentInclusion,
} from '../src/server/store';
import { selectBaselineAction } from '../src/app/projects/[projectId]/toc/actions';
import {
  detectConflicts,
  firstIndicatorParagraphs,
  getOrSyncTocForProject,
  normalizeIndicatorName,
  parsePdmParagraphs,
  syncTocForProject,
} from '../src/server/toc';
import { getBaselineKey, syncSelectedDocsFromToc } from '../src/lib/baseline-key';

describe('문단 일괄 검색 동등성', () => {
  it('기존 지표별 첫 일치 검색과 중복, 부분 문자열, 빈 지표에서 같다', () => {
    const paragraphs = ['다른 문단', '교육 만족도 10명', '교육 20명', '만족도 30명'].map((content, index) => ({ id: `p-${index}`, document_id: 'doc', sequence_no: index, location: `${index}`, content }));
    const pairs = [['교육', ''], ['교육 만족도', '대안'], ['없는 것', '만족도'], ['', '교육'], ['만족도', '교육']].map(([name, ovi]) => [normalizeIndicatorName(name), normalizeIndicatorName(ovi)] as [string, string]);
    const reference = pairs.map(([name, ovi]) => !name ? undefined : paragraphs.find(p => {
      const text = normalizeIndicatorName(p.content);
      return text.includes(name) || (!!ovi && text.includes(ovi));
    }));
    expect(firstIndicatorParagraphs(paragraphs, pairs)).toEqual(reference);
  });
  it('정규화, 빈 값, 중복 및 많은 문단에서 기존 첫 일치와 같다', () => {
    const paragraphs = Array.from({ length: 3000 }, (_, index) => ({
      id: `large-${index}`, document_id: 'doc', sequence_no: index, location: `${index}`,
      content: index % 17 === 0 ? ` 교육  성과 ${index % 43} 건 ` : `자료 ${index % 71} 항목`,
    }));
    const pairs = Array.from({ length: 180 }, (_, index) =>
      [index % 19 === 0 ? '' : `교육 성과 ${index % 43}`, index % 11 === 0 ? '' : `자료 ${index % 71}`]
        .map(normalizeIndicatorName) as [string, string]);
    const expected = pairs.map(([name, ovi]) => !name ? undefined : paragraphs.find(p => {
      const text = normalizeIndicatorName(p.content);
      return text.includes(name) || (!!ovi && text.includes(ovi));
    }));
    expect(firstIndicatorParagraphs(paragraphs, pairs)).toEqual(expected);
  });

});

describe('ToC 성과 경로 추출 및 충돌 탐지 단위 시험 (FE-05, FE-06, RQ-07, RQ-08, UC-03)', () => {
  let db: Database.Database;

  const mockProjectId = 'proj-toc-test';

  function createMockTableParagraphs(
    docId: string,
    rows: Array<{
      level: string;
      name: string;
      ovi: string;
      mov: string | null;
      target_value: string;
      location?: string;
    }>
  ) {
    const paragraphs: Array<{
      id: string;
      document_id: string;
      sequence_no: number;
      location: string;
      content: string;
      table_index: number;
      table_row: number;
      table_col: number;
    }> = [];

    let seq = 1;
    // Row 1: Header
    const headers = ['단계', '서술', '지표(OVI)', '검증수단(MoV)', '목표값'];
    for (let c = 1; c <= 5; c++) {
      paragraphs.push({
        id: `${docId}-r1-c${c}`,
        document_id: docId,
        sequence_no: seq,
        location: `¶${seq}`,
        content: headers[c - 1],
        table_index: 0,
        table_row: 1,
        table_col: c,
      });
      seq++;
    }

    // Data rows
    rows.forEach((row, rIdx) => {
      const rowNum = rIdx + 2;
      const values = [row.level, row.name, row.ovi, row.mov ?? '', row.target_value];
      for (let c = 1; c <= 5; c++) {
        paragraphs.push({
          id: `${docId}-r${rowNum}-c${c}`,
          document_id: docId,
          sequence_no: seq,
          location: row.location ?? `¶${seq}`,
          content: values[c - 1],
          table_index: 0,
          table_row: rowNum,
          table_col: c,
        });
        seq++;
      }
    });

    return paragraphs;
  }

  const pw = answers.performance_pathway;
  const standardTableRows = [
    {
      level: '영향',
      name: pw.impact.name,
      ovi: pw.impact.ovi,
      mov: pw.impact.mov,
      target_value: pw.impact.target_value,
      location: '¶3',
    },
    {
      level: '중기성과',
      name: pw.midterm_outcome.name,
      ovi: pw.midterm_outcome.ovi,
      mov: pw.midterm_outcome.mov,
      target_value: pw.midterm_outcome.target_value,
      location: '¶4',
    },
    {
      level: '단기성과',
      name: pw.shortterm_outcome.name,
      ovi: pw.shortterm_outcome.ovi,
      mov: pw.shortterm_outcome.mov,
      target_value: pw.shortterm_outcome.target_value,
      location: '¶5',
    },
    {
      level: '산출물',
      name: pw.output.name,
      ovi: pw.output.ovi,
      mov: pw.output.mov,
      target_value: pw.output.target_value,
      location: '¶6',
    },
    {
      level: '활동',
      name: pw.activity.name,
      ovi: pw.activity.ovi,
      mov: pw.activity.mov,
      target_value: pw.activity.target_value,
      location: '¶7',
    },
  ];

  beforeEach(() => {
    db = openDatabase(':memory:');
    createProject(
      {
        id: mockProjectId,
        name: answers.project_name,
        created_at: new Date().toISOString(),
      },
      db
    );
  });

  afterEach(() => {
    closeDatabase();
  });

  it('목차 원문이 같으면 다시 쓰지 않고 문단과 포함 상태 변경을 감지한다', () => {
    createDocument({ id: 'pdm-cache', project_id: mockProjectId, file_name: 'pdm.docx',
      file_type: 'docx', status: '추출 완료', doc_type: '성과관리표', is_included: 1,
      excluded_reason: null, is_past_final_report: false, created_at: '2026-01-01' }, db);
    insertParagraphs(createMockTableParagraphs('pdm-cache', [standardTableRows[0]]), db);
    const first = getOrSyncTocForProject(mockProjectId, db);
    const changes = () => (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n;
    const before = changes();
    expect(getOrSyncTocForProject(mockProjectId, db)).toEqual(first);
    expect(changes()).toBe(before);
    db.prepare('UPDATE paragraphs SET content = ? WHERE document_id = ? AND table_row = 2 AND table_col = 2')
      .run('수정된 가상 지표', 'pdm-cache');
    const modified = getOrSyncTocForProject(mockProjectId, db);
    expect(modified?.items[0].indicator.name).toBe('수정된 가상 지표');
    updateDocumentInclusion('pdm-cache', false, null, 'user', db);
    expect(getOrSyncTocForProject(mockProjectId, db)?.items).toEqual([]);
  });

  it('추출 결과의 table_row·table_col 이 저장(paragraphs)까지 전달되는지 실제 DOCX 로 확인한다 (검수 2회차 1번)', async () => {
    // 1. 실제 DOCX 바이너리를 인메모리로 생성 (표 포함)
    const zip = new JSZip();
    const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>성과관리표 서두 문단</w:t></w:r></w:p>
    <w:tbl>
      <w:tr>
        <w:tc><w:p><w:r><w:t>단계</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>서술</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>목표값</w:t></w:r></w:p></w:tc>
      </w:tr>
      <w:tr>
        <w:tc><w:p><w:r><w:t>영향</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>대국민 편의 증진</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>5점 척도 4.5점</w:t></w:r></w:p></w:tc>
      </w:tr>
    </w:tbl>
  </w:body>
</w:document>`;
    zip.file('word/document.xml', documentXml);
    const docxBuf = await zip.generateAsync({ type: 'nodebuffer' });

    // 2. extractDocx 로 실제 DOCX 추출 실행
    const extraction = await extractDocx(docxBuf);
    expect(extraction.status).toBe('추출 완료');
    expect(extraction.paragraphs.length).toBe(7); // 1개 본문 + 6개 셀 문단

    // 추출 결과에 table_row, table_col 메타데이터 존재 확인
    const tableExtParas = extraction.paragraphs.filter((p) => p.table_row != null && p.table_col != null);
    expect(tableExtParas.length).toBe(6);

    const docId = 'doc-real-table-docx';
    createDocument(
      {
        id: docId,
        project_id: mockProjectId,
        file_name: 'real_table.docx',
        file_type: 'docx',
        status: extraction.status,
        doc_type: '성과관리표',
        is_included: 1,
        excluded_reason: null, is_past_final_report: false,
        created_at: new Date().toISOString(),
      },
      db
    );

    // 3. documents/service 와 동일하게 DB 매핑 및 삽입 수행 (table_row, table_col 전달)
    const paragraphsToInsert = extraction.paragraphs.map((p) => ({
      id: crypto.randomUUID(),
      document_id: docId,
      sequence_no: p.sequence_no,
      location: p.location,
      content: p.content,
      table_index: p.table_index ?? null,
      table_cols: p.table_cols ?? null,
      table_row: p.table_row ?? null,
      table_col: p.table_col ?? null,
    }));
    insertParagraphs(paragraphsToInsert, db);

    // 4. SQLite DB 저장소(paragraphs)에서 조회하여 table_row, table_col 전달 확인
    const storedParas = getParagraphsByDocument(docId, db);
    expect(storedParas.length).toBe(7);

    // 서두 일반 문단은 table_row, table_col 이 null
    const firstPara = storedParas.find((p) => p.sequence_no === 1)!;
    expect(firstPara.content).toBe('성과관리표 서두 문단');
    expect(firstPara.table_row).toBeNull();
    expect(firstPara.table_col).toBeNull();

    // 표 1행 1열 헤더 셀
    const headerCell = storedParas.find((p) => p.table_row === 1 && p.table_col === 1)!;
    expect(headerCell).toBeDefined();
    expect(headerCell.content).toBe('단계');
    expect(headerCell.table_index).toBe(0);
    expect(headerCell.table_cols).toBe(3);

    // 표 2행 1열 셀 (영향)
    const impactCell = storedParas.find((p) => p.table_row === 2 && p.table_col === 1)!;
    expect(impactCell).toBeDefined();
    expect(impactCell.content).toBe('영향');

    // 표 2행 3열 셀 (목표값)
    const targetCell = storedParas.find((p) => p.table_row === 2 && p.table_col === 3)!;
    expect(targetCell).toBeDefined();
    expect(targetCell.content).toBe('5점 척도 4.5점');
  });

  it('표 구조가 없는 문단(table_row/col 부재)은 폴백 없이 빈 배열을 반환하고 S3에 경고가 설정된다 (검수 2회차 1번)', () => {
    const plainParas = [
      {
        id: 'plain-1',
        document_id: 'doc-plain-pdm',
        sequence_no: 1,
        location: '¶1',
        content: '성과관리표(PDM) - 가상국 디지털 행정 역량 강화 사업',
      },
      {
        id: 'plain-2',
        document_id: 'doc-plain-pdm',
        sequence_no: 2,
        location: '¶2',
        content: '영향 단계 성과지표로 대국민 전자정부 서비스 체감 만족도 5점 척도 3.5점 달성을 설정함.',
      },
    ];

    // parsePdmParagraphs 는 표 구조(table_row, table_col)가 없으면 폴백 없이 빈 배열 반환
    const parsed = parsePdmParagraphs(plainParas as any, 'doc-plain-pdm');
    expect(parsed).toEqual([]);

    createDocument(
      {
        id: 'doc-plain-pdm',
        project_id: mockProjectId,
        file_name: 'plain_pdm.docx',
        file_type: 'docx',
        status: '추출 완료',
        doc_type: '성과관리표',
        is_included: 1,
        excluded_reason: null, is_past_final_report: false,
        created_at: new Date().toISOString(),
      },
      db
    );
    insertParagraphs(plainParas as any, db);

    const toc = syncTocForProject(mockProjectId);
    expect(toc).not.toBeNull();
    expect(toc!.items.length).toBe(0);
    expect(toc!.warningMessage).toBe('성과관리표에서 표를 찾지 못했습니다');
  });

  it('단계 판별은 셀 값 정규화 뒤 다섯 이름과 완전 일치만 표준으로 보며 "활동지원"은 비표준 경고 처리한다 (검수 2회차 2번)', () => {
    const rows = [
      {
        level: '  영향  ', // 공백 정규화 후 '영향' 과 완전 일치 -> 표준
        name: '행정 편의 증진',
        ovi: '만족도 지수',
        mov: '보고서',
        target_value: '90%',
      },
      {
        level: '활동지원', // 표준 5단계와 불일치 -> 비표준 (경고)
        name: '지원 체계 마련',
        ovi: '지원 센터 구축',
        mov: '인수증',
        target_value: '1식',
      },
      {
        level: '활동', // 표준 5단계와 완전 일치 -> 표준
        name: '공무원 교육',
        ovi: '이수 공무원 수',
        mov: '대장',
        target_value: '100명',
      },
    ];

    const tableParas = createMockTableParagraphs('doc-levels', rows);
    const parsed = parsePdmParagraphs(tableParas as any, 'doc-levels');

    expect(parsed.length).toBe(3);

    const impactItem = parsed.find((p) => p.name === '행정 편의 증진')!;
    expect(impactItem.level).toBe('영향');
    expect(impactItem.is_unknown_level).toBe(false);

    const supportItem = parsed.find((p) => p.name === '지원 체계 마련')!;
    expect(supportItem.level).toBe('활동지원');
    expect(supportItem.is_unknown_level).toBe(true); // 비표준 경고 플래그

    const activityItem = parsed.find((p) => p.name === '공무원 교육')!;
    expect(activityItem.level).toBe('활동');
    expect(activityItem.is_unknown_level).toBe(false);
  });

  it('성과관리표 표 구조를 해석하면 5단계 성과 경로가 정답표(answers.json)와 100% 일치한다 (FE-05, RQ-07)', () => {
    const tableParas = createMockTableParagraphs('doc-pdm-table', standardTableRows);
    const parsed = parsePdmParagraphs(tableParas as any, 'doc-pdm-table');

    // 정확히 5단계가 추출되어야 함
    expect(parsed.length).toBe(5);

    const levels = parsed.map((p) => p.level);
    expect(levels).toEqual(['영향', '중기성과', '단기성과', '산출물', '활동']);

    // 1. 영향
    const impact = parsed.find((p) => p.level === '영향')!;
    expect(impact.name).toBe(pw.impact.name);
    expect(impact.ovi).toBe(pw.impact.ovi);
    expect(impact.mov).toBe(pw.impact.mov);
    expect(impact.target_value).toBe(pw.impact.target_value);
    expect(impact.source_location).toBe('¶3');

    // 2. 중기성과
    const midterm = parsed.find((p) => p.level === '중기성과')!;
    expect(midterm.name).toBe(pw.midterm_outcome.name);
    expect(midterm.ovi).toBe(pw.midterm_outcome.ovi);
    expect(midterm.mov).toBe(pw.midterm_outcome.mov);
    expect(midterm.target_value).toBe(pw.midterm_outcome.target_value);
    expect(midterm.source_location).toBe('¶4');

    // 3. 단기성과
    const shortterm = parsed.find((p) => p.level === '단기성과')!;
    expect(shortterm.name).toBe(pw.shortterm_outcome.name);
    expect(shortterm.ovi).toBe(pw.shortterm_outcome.ovi);
    expect(shortterm.mov).toBe(pw.shortterm_outcome.mov);
    expect(shortterm.target_value).toBe(pw.shortterm_outcome.target_value);
    expect(shortterm.source_location).toBe('¶5');

    // 4. 산출물
    const output = parsed.find((p) => p.level === '산출물')!;
    expect(output.name).toBe(pw.output.name);
    expect(output.ovi).toBe(pw.output.ovi);
    expect(output.mov).toBe(pw.output.mov);
    expect(output.target_value).toBe(pw.output.target_value);
    expect(output.source_location).toBe('¶6');

    // 5. 활동
    const activity = parsed.find((p) => p.level === '활동')!;
    expect(activity.name).toBe(pw.activity.name);
    expect(activity.ovi).toBe(pw.activity.ovi);
    expect(activity.mov).toBe(pw.activity.mov);
    expect(activity.target_value).toBe(pw.activity.target_value);
    expect(activity.source_location).toBe('¶7');
  });

  it('계획 문서끼리 목표값이 다르면 충돌(80% 대 5점 척도 3.5점)을 올바르게 탐지한다 (FE-06, RQ-08)', () => {
    // 1. 사업계획서 등록 및 문단 삽입
    createDocument(
      {
        id: 'doc-plan',
        project_id: mockProjectId,
        file_name: '01_project_plan.hwpx',
        file_type: 'hwpx',
        status: '추출 완료',
        doc_type: '사업계획서',
        is_included: 1,
        excluded_reason: null, is_past_final_report: false,
        created_at: new Date().toISOString(),
      },
      db
    );
    insertParagraphs(
      [
        {
          id: 'plan-p4',
          document_id: 'doc-plan',
          sequence_no: 4,
          location: '¶4',
          content: '핵심 성과지표로서 행정 시스템 이용 만족도 80% 달성을 최종 목표로 설정한다.',
        },
      ],
      db
    );

    // 2. 성과관리표 등록 및 문단 삽입
    createDocument(
      {
        id: 'doc-pdm',
        project_id: mockProjectId,
        file_name: '02_pdm.docx',
        file_type: 'docx',
        status: '추출 완료',
        doc_type: '성과관리표',
        is_included: 1,
        excluded_reason: null, is_past_final_report: false,
        created_at: new Date().toISOString(),
      },
      db
    );
    insertParagraphs(
      [
        {
          id: 'pdm-p3',
          document_id: 'doc-pdm',
          sequence_no: 3,
          location: '¶3',
          content:
            '영향 단계 성과지표로 대국민 전자정부 서비스 체감 만족도 5점 척도 3.5점 달성을 설정함.',
        },
      ],
      db
    );

    const indicators: IndicatorRecord[] = [
      {
        id: 'ind-impact',
        project_id: mockProjectId,
        level: '영향',
        name: pw.impact.name,
        ovi: pw.impact.ovi,
        mov: pw.impact.mov,
        target_value: pw.impact.target_value,
        source_doc_id: 'doc-pdm',
        source_location: '¶3',
        sort_order: 1,
        is_baseline: 0,
        created_at: new Date().toISOString(),
      },
    ];

    const documents = [
      {
        id: 'doc-plan',
        project_id: mockProjectId,
        file_name: '01_project_plan.hwpx',
        file_type: 'hwpx',
        status: '추출 완료' as const,
        doc_type: '사업계획서' as const,
        is_included: 1,
        excluded_reason: null, is_past_final_report: false,
        created_at: new Date().toISOString(),
      },
      {
        id: 'doc-pdm',
        project_id: mockProjectId,
        file_name: '02_pdm.docx',
        file_type: 'docx',
        status: '추출 완료' as const,
        doc_type: '성과관리표' as const,
        is_included: 1,
        excluded_reason: null, is_past_final_report: false,
        created_at: new Date().toISOString(),
      },
    ];

    const pdmItems = [
      {
        level: '영향',
        name: pw.impact.name,
        ovi: pw.impact.ovi,
        mov: pw.impact.mov,
        target_value: pw.impact.target_value,
        source_doc_id: 'doc-pdm',
        source_location: '¶3',
        sort_order: 1,
      },
    ];

    const conflicts = detectConflicts(mockProjectId, indicators, documents, pdmItems);
    expect(conflicts.length).toBe(1);
    expect(conflicts[0].doc_a_name).toBe('사업계획서');
    expect(conflicts[0].doc_a_value).toBe('80%');
    expect(conflicts[0].doc_a_location).toBe('¶4');
    expect(conflicts[0].doc_b_name).toBe('성과관리표');
    expect(conflicts[0].doc_b_value).toBe('5점 척도 3.5점');
    expect(conflicts[0].doc_b_location).toBe('¶3');
  });

  it('syncTocForProject 는 성과관리표가 없을 때 hasPdm=false 를 반환한다 (AC 4)', () => {
    // 성과관리표가 없는 사업
    const toc = syncTocForProject(mockProjectId);
    expect(toc).not.toBeNull();
    expect(toc!.hasPdm).toBe(false);
    expect(toc!.items.length).toBe(0);
  });

  it('syncTocForProject 동기화 후 고른 기준 지표가 유지되며 목표값을 덮어쓰지 않는다 (AC 2, 검수 2회차 3번)', () => {
    // 문서 등록
    createDocument(
      {
        id: 'doc-plan',
        project_id: mockProjectId,
        file_name: '01_project_plan.hwpx',
        file_type: 'hwpx',
        status: '추출 완료',
        doc_type: '사업계획서',
        is_included: 1,
        excluded_reason: null, is_past_final_report: false,
        created_at: new Date().toISOString(),
      },
      db
    );
    insertParagraphs(
      [
        {
          id: 'plan-p4',
          document_id: 'doc-plan',
          sequence_no: 4,
          location: '¶4',
          content: '핵심 성과지표로서 행정 시스템 이용 만족도 80% 달성을 최종 목표로 설정한다.',
        },
      ],
      db
    );

    createDocument(
      {
        id: 'doc-pdm',
        project_id: mockProjectId,
        file_name: '02_pdm.docx',
        file_type: 'docx',
        status: '추출 완료',
        doc_type: '성과관리표',
        is_included: 1,
        excluded_reason: null, is_past_final_report: false,
        created_at: new Date().toISOString(),
      },
      db
    );
    const tableParas = createMockTableParagraphs('doc-pdm', standardTableRows);
    insertParagraphs(tableParas, db);

    // 1차 동기화
    const toc1 = syncTocForProject(mockProjectId);
    expect(toc1).not.toBeNull();
    expect(toc1!.hasPdm).toBe(true);
    expect(toc1!.items.length).toBe(5);

    const impactItem = toc1!.items.find((i) => i.indicator.level === '영향')!;
    expect(impactItem.conflict).toBeDefined();

    // 기준 지표 선택 저장
    saveIndicatorBaseline(
      {
        id: 'base-impact',
        project_id: mockProjectId,
        indicator_id: impactItem.indicator.id,
        document_id: 'doc-plan',
        document_name: '사업계획서',
        target_value: '80%',
        selected_at: new Date().toISOString(),
      },
      db
    );

    // 지표 목표값을 기준값으로 덮어쓰지 않고 원래 PDM 목표값이 보존되는지 확인
    const indAfterSave = getIndicator(impactItem.indicator.id, db);
    expect(indAfterSave!.target_value).toBe('5점 척도 3.5점 달성');
    expect(indAfterSave!.is_baseline).toBe(1);

    // 2차 동기화 (재동기화 뒤에도 기준 지표가 유지되는지 확인)
    const toc2 = syncTocForProject(mockProjectId);
    const impactItemAfter = toc2!.items.find((i) => i.indicator.level === '영향')!;
    expect(impactItemAfter.baseline).toBeDefined();
    expect(impactItemAfter.baseline!.document_name).toBe('사업계획서');
    expect(impactItemAfter.baseline!.target_value).toBe('80%');
    expect(impactItemAfter.indicator.target_value).toBe('5점 척도 3.5점 달성'); // 목표값 덮어쓰지 않음
  });

  it('같은 문서·행에서 자연 키가 바뀌어도 확정과 기준 선택을 보존하고 충돌이 사라지면 다시 확인으로 남긴다', () => {
    createDocument({ id: 'doc-plan-key-change', project_id: mockProjectId, file_name: 'plan.docx', file_type: 'docx', status: '추출 완료', doc_type: '사업계획서', is_included: 1, excluded_reason: null, is_past_final_report: false, created_at: new Date().toISOString() }, db);
    insertParagraphs([{ id: 'plan-key-change-p', document_id: 'doc-plan-key-change', sequence_no: 1, location: '¶plan', content: '서비스 만족도 향상 80%' }], db);
    createDocument({ id: 'doc-pdm-key-change', project_id: mockProjectId, file_name: 'pdm.docx', file_type: 'docx', status: '추출 완료', doc_type: '성과관리표', is_included: 1, excluded_reason: null, is_past_final_report: false, created_at: new Date().toISOString() }, db);
    const initialRow = [{ level: '영향', name: '서비스 만족도 향상', ovi: '이용자 만족도', mov: '설문', target_value: '70%' }];
    insertParagraphs(createMockTableParagraphs('doc-pdm-key-change', initialRow), db);
    const initial = syncTocForProject(mockProjectId)!;
    const original = initial.items[0].indicator;
    saveSuggestion({ id: 'sugg-key-change', indicator_id: original.id, verdict_status: '실현', error_reason: null, proposal_text: '가상 확인 결과', created_at: new Date().toISOString() }, [], db);
    createConfirmation({ indicator_id: original.id, confirmation_type: '확정', confirmer_name: '평가자' }, db);
    saveIndicatorBaseline({ id: 'base-key-change', project_id: mockProjectId, indicator_id: original.id, document_id: 'doc-plan-key-change', document_name: '사업계획서', target_value: '80%', selected_at: new Date().toISOString(), conflict_id: initial.items[0].conflict?.id, other_doc_id: 'doc-pdm-key-change' }, db);

    db.prepare('DELETE FROM paragraphs WHERE document_id = ?').run('doc-pdm-key-change');
    insertParagraphs(createMockTableParagraphs('doc-pdm-key-change', [{ level: '영향', name: '서비스 만족도 개선', ovi: '이용자 체감 만족도', mov: '설문', target_value: '70%' }]), db);
    db.prepare('UPDATE paragraphs SET content = ? WHERE id = ?').run('서비스 만족도 개선 80%', 'plan-key-change-p');
    const changed = syncTocForProject(mockProjectId)!;
    const matched = changed.items[0];
    expect(matched.indicator.id).toBe(original.id);
    expect(listConfirmations(original.id, db)).toHaveLength(1);
    expect(matched.baseline?.id).toBe('base-key-change');
    expect(matched.conflicts).toHaveLength(1);

    db.prepare('UPDATE paragraphs SET content = ? WHERE id = ?').run('서비스 만족도 개선 70%', 'plan-key-change-p');
    const noConflict = syncTocForProject(mockProjectId)!;
    const retained = noConflict.items[0];
    expect(retained.conflicts).toHaveLength(0);
    expect(retained.baseline?.id).toBe('base-key-change');
    expect(retained.baseline?.conflict_id).toBeNull();
    db.prepare('UPDATE indicator_baselines SET other_doc_id = NULL WHERE id = ?').run('base-key-change');
    const repeatedReview = syncTocForProject(mockProjectId)!;
    expect(repeatedReview.items[0].baseline?.id).toBe('base-key-change');
    expect(repeatedReview.items[0].baseline?.conflict_id).toBeNull();
  });

  it('미매칭 기준만 있는 옛 지표를 고아로 보존하고 다음 동기화에서도 다시 확인 상태를 유지한다', () => {
    createDocument({ id: 'doc-plan-baseline-only', project_id: mockProjectId, file_name: 'plan.docx', file_type: 'docx', status: '추출 완료', doc_type: '사업계획서', is_included: 1, excluded_reason: null, is_past_final_report: false, created_at: new Date().toISOString() }, db);
    createDocument({ id: 'doc-pdm-baseline-only', project_id: mockProjectId, file_name: 'pdm.docx', file_type: 'docx', status: '추출 완료', doc_type: '성과관리표', is_included: 1, excluded_reason: null, is_past_final_report: false, created_at: new Date().toISOString() }, db);
    insertParagraphs(createMockTableParagraphs('doc-pdm-baseline-only', [{ level: '영향', name: '기존 기준 선택 지표', ovi: '기존 성과 지표', mov: '가상 설문', target_value: '70%' }]), db);
    const first = syncTocForProject(mockProjectId)!;
    const oldIndicator = first.items[0].indicator;
    saveIndicatorBaseline({ id: 'base-only-history', project_id: mockProjectId, indicator_id: oldIndicator.id, document_id: 'doc-plan-baseline-only', document_name: '사업계획서', target_value: '60%', selected_at: new Date().toISOString(), other_doc_id: 'doc-pdm-baseline-only' }, db);

    db.prepare('DELETE FROM paragraphs WHERE document_id = ?').run('doc-pdm-baseline-only');
    insertParagraphs(createMockTableParagraphs('doc-pdm-baseline-only', [{ level: '영향', name: '완전히 다른 새 지표', ovi: '새 성과 지표', mov: '가상 확인서', target_value: '5건' }]), db);
    const changed = syncTocForProject(mockProjectId)!;
    let orphan = changed.items.find((item) => item.indicator.id === oldIndicator.id);
    expect(orphan?.indicator.is_orphaned).toBe(1);
    expect(orphan?.baseline?.id).toBe('base-only-history');
    expect(orphan?.baseline?.conflict_id).toBeNull();

    const repeated = syncTocForProject(mockProjectId)!;
    orphan = repeated.items.find((item) => item.indicator.id === oldIndicator.id);
    expect(orphan?.indicator.is_orphaned).toBe(1);
    expect(orphan?.baseline?.id).toBe('base-only-history');
    expect(orphan?.baseline?.conflict_id).toBeNull();
  });

  it('동기화: 성과관리표 값 변경 → 재동기화 → 새 값 반영·사라진 지표 제거·빠졌던 단계 추가 및 성과관리표 제외 → 경로 비움 (검수 2회차 3번)', () => {
    // 1. 초기 성과관리표 (영향, 중기성과 2개 단계만 존재)
    const initialRows = [
      {
        level: '영향',
        name: '초기 영향 지표',
        ovi: '초기 OVI A',
        mov: '출처 1',
        target_value: '70%',
      },
      {
        level: '중기성과',
        name: '제거될 중기성과 지표',
        ovi: '초기 OVI B',
        mov: '출처 2',
        target_value: '20% 단축',
      },
    ];

    createDocument(
      {
        id: 'doc-sync-test-pdm',
        project_id: mockProjectId,
        file_name: 'test_pdm.docx',
        file_type: 'docx',
        status: '추출 완료',
        doc_type: '성과관리표',
        is_included: 1,
        excluded_reason: null, is_past_final_report: false,
        created_at: new Date().toISOString(),
      },
      db
    );

    const initialParas = createMockTableParagraphs('doc-sync-test-pdm', initialRows);
    insertParagraphs(initialParas, db);

    const toc1 = syncTocForProject(mockProjectId);
    expect(toc1!.items.length).toBe(2);
    expect(toc1!.items.map((i) => i.indicator.name)).toEqual(['초기 영향 지표', '제거될 중기성과 지표']);

    // 2. 성과관리표 내용 변경 (값 변경, 지표 제거, 빠졌던 단계 추가)
    db.prepare(`DELETE FROM paragraphs WHERE document_id = 'doc-sync-test-pdm'`).run();
    const updatedRows = [
      {
        level: '영향',
        name: '초기 영향 지표',
        ovi: '초기 OVI A',
        mov: '출처 1',
        target_value: '85%', // 값 변경
      },
      {
        level: '단기성과',
        name: '새로 추가된 단기성과',
        ovi: '신규 OVI C',
        mov: '출처 3',
        target_value: '500건', // 신규 추가
      },
      {
        level: '산출물',
        name: '새로 추가된 산출물',
        ovi: '신규 OVI D',
        mov: '출처 4',
        target_value: '1식', // 신규 추가
      },
    ];
    const updatedParas = createMockTableParagraphs('doc-sync-test-pdm', updatedRows);
    insertParagraphs(updatedParas, db);

    // 재동기화 실행
    const toc2 = syncTocForProject(mockProjectId);
    expect(toc2!.items.length).toBe(3);

    const impactUpdated = toc2!.items.find((i) => i.indicator.level === '영향')!;
    expect(impactUpdated.indicator.target_value).toBe('85%'); // 새 값 반영

    const midtermRemoved = toc2!.items.find((i) => i.indicator.level === '중기성과');
    expect(midtermRemoved).toBeUndefined(); // 사라진 지표 제거

    const shorttermAdded = toc2!.items.find((i) => i.indicator.level === '단기성과')!;
    expect(shorttermAdded).toBeDefined(); // 빠졌던 단계 추가
    expect(shorttermAdded.indicator.target_value).toBe('500건');

    // 3. 성과관리표 제외 시 경로·충돌·기준 모두 비움 검증
    updateDocumentInclusion('doc-sync-test-pdm', false, '제외', 'user', db);
    const toc3 = syncTocForProject(mockProjectId);
    expect(toc3!.items.length).toBe(0);
    expect(toc3!.conflicts.length).toBe(0);
    expect(toc3!.baselines.length).toBe(0);
  });

  it('충돌 탐지: 일반 단어만 겹치는 다른 지표는 짝짓지 않고 "3일 이내" 대 "5일 이내" 충돌을 탐지한다 (검수 2회차 4번)', () => {
    const testProjId = 'proj-conflict-test-item4';
    createProject({ id: testProjId, name: '충돌 단위 시험', created_at: new Date().toISOString() }, db);

    createDocument(
      {
        id: 'doc-plan-4',
        project_id: testProjId,
        file_name: 'plan4.hwpx',
        file_type: 'hwpx',
        status: '추출 완료',
        doc_type: '사업계획서',
        is_included: 1,
        excluded_reason: null, is_past_final_report: false,
        created_at: new Date().toISOString(),
      },
      db
    );
    insertParagraphs(
      [
        {
          id: 'p4-1',
          document_id: 'doc-plan-4',
          sequence_no: 1,
          location: '¶1',
          content: '민원 처리 소요시간 단축을 위해 3일 이내 처리를 목표로 수립한다.',
        },
        {
          id: 'p4-2',
          document_id: 'doc-plan-4',
          sequence_no: 2,
          location: '¶2',
          content: '민원 행정 만족도 조사 결과 90% 이상을 목표로 설정한다.',
        },
      ],
      db
    );

    createDocument(
      {
        id: 'doc-pdm-4',
        project_id: testProjId,
        file_name: 'pdm4.docx',
        file_type: 'docx',
        status: '추출 완료',
        doc_type: '성과관리표',
        is_included: 1,
        excluded_reason: null, is_past_final_report: false,
        created_at: new Date().toISOString(),
      },
      db
    );

    // 지표 1: "민원 처리 소요시간" (목표값 5일 이내) -> 사업계획서의 "3일 이내" 와 충돌해야 함
    // 지표 2: "민원 서비스 만족도" (일반 단어 "민원" 만 겹치고 이름이 다른 지표) -> 짝지어지지 않아야 함
    const indicators: IndicatorRecord[] = [
      {
        id: 'ind-duration',
        project_id: testProjId,
        level: '중기성과',
        name: '민원 처리 소요시간',
        ovi: '민원 처리 소요시간',
        mov: '시스템 로그',
        target_value: '5일 이내',
        source_doc_id: 'doc-pdm-4',
        source_location: '¶1',
        sort_order: 1,
        is_baseline: 0,
        created_at: new Date().toISOString(),
      },
      {
        id: 'ind-other-service',
        project_id: testProjId,
        level: '단기성과',
        name: '민원 대민 포털 서비스 실적', // 일반 단어 '민원' 만 겹침
        ovi: '민원 대민 포털 서비스 실적',
        mov: '포털 통계',
        target_value: '500건',
        source_doc_id: 'doc-pdm-4',
        source_location: '¶2',
        sort_order: 2,
        is_baseline: 0,
        created_at: new Date().toISOString(),
      },
    ];

    const documents = [
      {
        id: 'doc-plan-4',
        project_id: testProjId,
        file_name: 'plan4.hwpx',
        file_type: 'hwpx',
        status: '추출 완료' as const,
        doc_type: '사업계획서' as const,
        is_included: 1,
        excluded_reason: null, is_past_final_report: false,
        created_at: new Date().toISOString(),
      },
      {
        id: 'doc-pdm-4',
        project_id: testProjId,
        file_name: 'pdm4.docx',
        file_type: 'docx',
        status: '추출 완료' as const,
        doc_type: '성과관리표' as const,
        is_included: 1,
        excluded_reason: null, is_past_final_report: false,
        created_at: new Date().toISOString(),
      },
    ];

    const pdmItems = indicators.map((ind) => ({
      level: ind.level,
      name: ind.name,
      ovi: ind.ovi,
      mov: ind.mov ?? '',
      target_value: ind.target_value ?? '',
      source_doc_id: ind.source_doc_id ?? '',
      source_location: ind.source_location ?? '',
      sort_order: ind.sort_order ?? 0,
    }));

    const conflicts = detectConflicts(testProjId, indicators, documents, pdmItems);

    // 1. "3일 이내" 대 "5일 이내" 충돌이 정확히 탐지됨
    expect(conflicts.length).toBe(1);
    expect(conflicts[0].indicator_id).toBe('ind-duration');
    expect(conflicts[0].doc_a_value).toBe('3일 이내');
    expect(conflicts[0].doc_b_value).toBe('5일 이내');

    // 2. 일반 단어 '민원' 만 겹치는 지표는 짝지어지지 않음
    const otherConflict = conflicts.find((c) => c.indicator_id === 'ind-other-service');
    expect(otherConflict).toBeUndefined();
  });

  it('충돌 탐지: 포함된 모든 계획 문서(복수 사업계획서·성과관리표)를 대상으로 충돌을 탐지한다 (검수 2회차 4번)', () => {
    const multiDocProjId = 'proj-multi-doc-conflict';
    createProject({ id: multiDocProjId, name: '다중 문서 충돌 시험', created_at: new Date().toISOString() }, db);

    // 사업계획서 1 (만족도 80%)
    createDocument(
      {
        id: 'doc-plan-1',
        project_id: multiDocProjId,
        file_name: 'plan_1.hwpx',
        file_type: 'hwpx',
        status: '추출 완료',
        doc_type: '사업계획서',
        is_included: 1,
        excluded_reason: null, is_past_final_report: false,
        created_at: new Date().toISOString(),
      },
      db
    );
    insertParagraphs(
      [
        {
          id: 'p1-1',
          document_id: 'doc-plan-1',
          sequence_no: 1,
          location: '¶1',
          content: '핵심 성과지표로서 행정 시스템 이용 만족도 80% 달성을 목표로 한다.',
        },
      ],
      db
    );

    // 사업계획서 2 (만족도 90%)
    createDocument(
      {
        id: 'doc-plan-2',
        project_id: multiDocProjId,
        file_name: 'plan_2.hwpx',
        file_type: 'hwpx',
        status: '추출 완료',
        doc_type: '사업계획서',
        is_included: 1,
        excluded_reason: null, is_past_final_report: false,
        created_at: new Date().toISOString(),
      },
      db
    );
    insertParagraphs(
      [
        {
          id: 'p2-1',
          document_id: 'doc-plan-2',
          sequence_no: 1,
          location: '¶1',
          content: '수정 사업계획서에서 행정 시스템 이용 만족도 90% 달성을 설정함.',
        },
      ],
      db
    );

    // 성과관리표 (만족도 5점 척도 3.5점)
    createDocument(
      {
        id: 'doc-pdm-multi',
        project_id: multiDocProjId,
        file_name: 'pdm_multi.docx',
        file_type: 'docx',
        status: '추출 완료',
        doc_type: '성과관리표',
        is_included: 1,
        excluded_reason: null, is_past_final_report: false,
        created_at: new Date().toISOString(),
      },
      db
    );

    const indicators: IndicatorRecord[] = [
      {
        id: 'ind-impact-multi',
        project_id: multiDocProjId,
        level: '영향',
        name: '대국민 전자정부 서비스 체감 만족도',
        ovi: '대국민 전자정부 서비스 체감 만족도',
        mov: '보고서',
        target_value: '5점 척도 3.5점',
        source_doc_id: 'doc-pdm-multi',
        source_location: '¶1',
        sort_order: 1,
        is_baseline: 0,
        created_at: new Date().toISOString(),
      },
    ];

    const documents = [
      {
        id: 'doc-plan-1',
        project_id: multiDocProjId,
        file_name: 'plan_1.hwpx',
        file_type: 'hwpx',
        status: '추출 완료' as const,
        doc_type: '사업계획서' as const,
        is_included: 1,
        excluded_reason: null, is_past_final_report: false,
        created_at: new Date().toISOString(),
      },
      {
        id: 'doc-plan-2',
        project_id: multiDocProjId,
        file_name: 'plan_2.hwpx',
        file_type: 'hwpx',
        status: '추출 완료' as const,
        doc_type: '사업계획서' as const,
        is_included: 1,
        excluded_reason: null, is_past_final_report: false,
        created_at: new Date().toISOString(),
      },
      {
        id: 'doc-pdm-multi',
        project_id: multiDocProjId,
        file_name: 'pdm_multi.docx',
        file_type: 'docx',
        status: '추출 완료' as const,
        doc_type: '성과관리표' as const,
        is_included: 1,
        excluded_reason: null, is_past_final_report: false,
        created_at: new Date().toISOString(),
      },
    ];

    const pdmItems = indicators.map((ind) => ({
      level: ind.level,
      name: ind.name,
      ovi: ind.ovi,
      mov: ind.mov ?? '',
      target_value: ind.target_value ?? '',
      source_doc_id: ind.source_doc_id ?? '',
      source_location: ind.source_location ?? '',
      sort_order: ind.sort_order ?? 0,
    }));

    const conflicts = detectConflicts(multiDocProjId, indicators, documents, pdmItems);

    // 첫 번째 사업계획서만이 아닌 모든 포함된 계획 문서(plan_1, plan_2) 대상 충돌 탐지
    expect(conflicts.length).toBe(2);
    const plan1Conflict = conflicts.find((c) => c.doc_a_id === 'doc-plan-1');
    const plan2Conflict = conflicts.find((c) => c.doc_a_id === 'doc-plan-2');
    expect(plan1Conflict).toBeDefined();
    expect(plan1Conflict!.doc_a_value).toBe('80%');
    expect(plan2Conflict).toBeDefined();
    expect(plan2Conflict!.doc_a_value).toBe('90%');
  });

  it('기준 선택 액션은 충돌 대상인 두 문서(doc_a, doc_b) 중 하나만 허용하고 제3의 문서는 거부한다', async () => {
    createDocument(
      {
        id: 'doc-act-plan',
        project_id: mockProjectId,
        file_name: 'plan.hwpx',
        file_type: 'hwpx',
        status: '추출 완료',
        doc_type: '사업계획서',
        is_included: 1,
        excluded_reason: null, is_past_final_report: false,
        created_at: new Date().toISOString(),
      },
      db
    );
    insertParagraphs(
      [
        {
          id: 'p-act-plan',
          document_id: 'doc-act-plan',
          sequence_no: 1,
          location: '¶1',
          content: '행정 시스템 이용 만족도 80% 달성을 목표로 한다.',
        },
      ],
      db
    );

    createDocument(
      {
        id: 'doc-act-pdm',
        project_id: mockProjectId,
        file_name: 'pdm.docx',
        file_type: 'docx',
        status: '추출 완료',
        doc_type: '성과관리표',
        is_included: 1,
        excluded_reason: null, is_past_final_report: false,
        created_at: new Date().toISOString(),
      },
      db
    );
    const tableParas = createMockTableParagraphs('doc-act-pdm', standardTableRows);
    insertParagraphs(tableParas, db);

    createDocument(
      {
        id: 'doc-act-other',
        project_id: mockProjectId,
        file_name: '03_trip_report.pdf',
        file_type: 'pdf',
        status: '추출 완료',
        doc_type: '출장결과보고서',
        is_included: 1,
        excluded_reason: null, is_past_final_report: false,
        created_at: new Date().toISOString(),
      },
      db
    );

    const tocData = syncTocForProject(mockProjectId);
    expect(tocData).not.toBeNull();
    const impactItem = tocData!.items.find((i) => i.indicator.level === '영향')!;
    expect(impactItem.conflict).toBeDefined();

    // 제3의 문서 선택 시도 -> 거부되어야 함
    const rejectRes = await selectBaselineAction(
      mockProjectId,
      impactItem.indicator.id,
      'doc-act-other'
    );
    expect(rejectRes.success).toBe(false);
    expect(rejectRes.error).toBe(
      '충돌에 관련된 두 문서 중 하나만 기준 문서로 선택할 수 있습니다.'
    );

    // 올바른 충돌 문서(doc-act-plan) 선택 시도 -> 성공
    const acceptRes = await selectBaselineAction(
      mockProjectId,
      impactItem.indicator.id,
      'doc-act-plan'
    );
    expect(acceptRes.success).toBe(true);
    expect(
      acceptRes.data!.items.find((i) => i.indicator.id === impactItem.indicator.id)!.baseline!
        .document_id
    ).toBe('doc-act-plan');
  });

  it('동기화: 문서 포함 상태가 변경되면 사라진 충돌이 삭제되고 기준이 해제되며, 재포함 시 충돌이 다시 계산된다', () => {
    createDocument(
      {
        id: 'doc-sync-plan',
        project_id: mockProjectId,
        file_name: 'plan.hwpx',
        file_type: 'hwpx',
        status: '추출 완료',
        doc_type: '사업계획서',
        is_included: 1,
        excluded_reason: null, is_past_final_report: false,
        created_at: new Date().toISOString(),
      },
      db
    );
    insertParagraphs(
      [
        {
          id: 'p-sync-plan',
          document_id: 'doc-sync-plan',
          sequence_no: 1,
          location: '¶1',
          content: '행정 시스템 이용 만족도 80% 달성을 목표로 한다.',
        },
      ],
      db
    );

    createDocument(
      {
        id: 'doc-sync-pdm',
        project_id: mockProjectId,
        file_name: 'pdm.docx',
        file_type: 'docx',
        status: '추출 완료',
        doc_type: '성과관리표',
        is_included: 1,
        excluded_reason: null, is_past_final_report: false,
        created_at: new Date().toISOString(),
      },
      db
    );
    const tableParas = createMockTableParagraphs('doc-sync-pdm', standardTableRows);
    insertParagraphs(tableParas, db);

    const toc1 = syncTocForProject(mockProjectId);
    const impact1 = toc1!.items.find((i) => i.indicator.level === '영향')!;
    expect(impact1.conflict).toBeDefined();

    // 기준 지표 선택
    saveIndicatorBaseline(
      {
        id: 'sync-base',
        project_id: mockProjectId,
        indicator_id: impact1.indicator.id,
        document_id: 'doc-sync-plan',
        document_name: '사업계획서',
        target_value: '80%',
        selected_at: new Date().toISOString(),
      },
      db
    );

    // 2. 사업계획서를 '제외'로 변경 후 재동기화
    updateDocumentInclusion('doc-sync-plan', false, '제외 사유', 'user', db);
    const tocAfterExclude = syncTocForProject(mockProjectId);

    const impactAfterExclude = tocAfterExclude!.items.find((i) => i.indicator.level === '영향')!;
    expect(impactAfterExclude.conflict).toBeNull(); // 충돌이 사라짐
    expect(impactAfterExclude.baseline).toBeNull(); // 기준 지표 선택이 해제됨
    expect(impactAfterExclude.indicator.is_baseline).toBe(0);
    expect(impactAfterExclude.indicator.target_value).toBe('5점 척도 3.5점 달성'); // 원본 목표값 보존

    // 3. 사업계획서를 다시 '포함'으로 변경 후 재동기화
    updateDocumentInclusion('doc-sync-plan', true, null, 'user', db);
    const tocAfterReinclude = syncTocForProject(mockProjectId);

    const impactAfterReinclude = tocAfterReinclude!.items.find((i) => i.indicator.level === '영향')!;
    expect(impactAfterReinclude.conflict).not.toBeNull(); // 충돌이 다시 계산되어 부활
    expect(impactAfterReinclude.baseline).toBeNull(); // 기준은 새로 선택해야 하므로 해제 상태 유지
  });

  // =========================================================================
  // 검수 3회차 반영 시험 (#19)
  // =========================================================================

  it('지표 매칭: 같은 단계에 지표 두 개가 있을 때 각자 자기 목표값만 짝지으며, 이름이 맞지 않으면 짝이 없다 (검수 3회차 1번)', () => {
    const testProjId = 'proj-same-level-match';
    createProject({ id: testProjId, name: '동일 단계 지표 매칭 시험', created_at: new Date().toISOString() }, db);

    const indicators: IndicatorRecord[] = [
      {
        id: 'ind-out-1',
        project_id: testProjId,
        level: '산출물',
        name: '디지털 행정 기반 구축',
        ovi: '공통 플랫폼 개발',
        mov: '인수 확인서',
        target_value: '1식',
        source_doc_id: 'doc-pdm-sl',
        source_location: '¶1',
        sort_order: 1,
        is_baseline: 0,
        created_at: new Date().toISOString(),
      },
      {
        id: 'ind-out-2',
        project_id: testProjId,
        level: '산출물',
        name: '시스템 보안 체계 수립',
        ovi: '보안 체계 수립',
        mov: '보안 점검표',
        target_value: '1건',
        source_doc_id: 'doc-pdm-sl',
        source_location: '¶2',
        sort_order: 2,
        is_baseline: 0,
        created_at: new Date().toISOString(),
      },
      {
        id: 'ind-out-3',
        project_id: testProjId,
        level: '산출물',
        name: '이름불일치 산출물',
        ovi: '불일치 지표',
        mov: null,
        target_value: '99건',
        source_doc_id: 'doc-pdm-sl',
        source_location: '¶3',
        sort_order: 3,
        is_baseline: 0,
        created_at: new Date().toISOString(),
      },
    ];

    const pdmItems = [
      {
        level: '산출물',
        name: '디지털 행정 기반 구축',
        ovi: '공통 플랫폼 개발',
        mov: '인수 확인서',
        target_value: '1식',
        source_doc_id: 'doc-pdm-sl',
        source_location: '¶1',
        sort_order: 1,
      },
      {
        level: '산출물',
        name: '시스템 보안 체계 수립',
        ovi: '보안 체계 수립',
        mov: '보안 점검표',
        target_value: '1건',
        source_doc_id: 'doc-pdm-sl',
        source_location: '¶2',
        sort_order: 2,
      },
    ];

    createDocument(
      {
        id: 'doc-plan-sl',
        project_id: testProjId,
        file_name: 'plan_sl.hwpx',
        file_type: 'hwpx',
        status: '추출 완료',
        doc_type: '사업계획서',
        is_included: 1,
        excluded_reason: null, is_past_final_report: false,
        created_at: new Date().toISOString(),
      },
      db
    );
    insertParagraphs(
      [
        {
          id: 'p-sl-1',
          document_id: 'doc-plan-sl',
          sequence_no: 1,
          location: '¶1',
          content: '디지털 행정 기반 구축 목표로 통합 플랫폼 5식 개발 완료를 추진한다.',
        },
        {
          id: 'p-sl-2',
          document_id: 'doc-plan-sl',
          sequence_no: 2,
          location: '¶2',
          content: '시스템 보안 체계 수립 인증 3건 획득을 추진한다.',
        },
      ],
      db
    );

    createDocument(
      {
        id: 'doc-pdm-sl',
        project_id: testProjId,
        file_name: 'pdm_sl.docx',
        file_type: 'docx',
        status: '추출 완료',
        doc_type: '성과관리표',
        is_included: 1,
        excluded_reason: null, is_past_final_report: false,
        created_at: new Date().toISOString(),
      },
      db
    );

    const documents = [
      {
        id: 'doc-plan-sl',
        project_id: testProjId,
        file_name: 'plan_sl.hwpx',
        file_type: 'hwpx',
        status: '추출 완료' as const,
        doc_type: '사업계획서' as const,
        is_included: 1,
        excluded_reason: null, is_past_final_report: false,
        created_at: new Date().toISOString(),
      },
      {
        id: 'doc-pdm-sl',
        project_id: testProjId,
        file_name: 'pdm_sl.docx',
        file_type: 'docx',
        status: '추출 완료' as const,
        doc_type: '성과관리표' as const,
        is_included: 1,
        excluded_reason: null, is_past_final_report: false,
        created_at: new Date().toISOString(),
      },
    ];

    const conflicts = detectConflicts(testProjId, indicators, documents, pdmItems);

    // 각자 자기 목표값만 짝지어 충돌 생성
    expect(conflicts.length).toBe(2);
    const conf1 = conflicts.find((c) => c.indicator_id === 'ind-out-1')!;
    const conf2 = conflicts.find((c) => c.indicator_id === 'ind-out-2')!;
    expect(conf1).toBeDefined();
    expect(conf1.doc_a_value).toBe('5식 개발 완료');
    expect(conf1.doc_b_value).toBe('1식');

    expect(conf2).toBeDefined();
    expect(conf2.doc_a_value).toBe('3건');
    expect(conf2.doc_b_value).toBe('1건');

    // ind-out-3은 이름이 PDM 항목과 일치하지 않으므로 같은 단계(산출물)여도 짝지어지지 않음
    const conf3 = conflicts.find((c) => c.indicator_id === 'ind-out-3');
    expect(conf3).toBeUndefined();
  });

  it('기준 재부착: 한 지표에 문서 충돌 두 개가 있을 때, 두 번째 충돌에서 기준 선택 후 재동기화해도 정확히 그 충돌의 기준이 유지된다 (검수 3회차 2번)', async () => {
    const rebindProjId = 'proj-rebind-baseline';
    createProject({ id: rebindProjId, name: '기준 재부착 충돌 시험', created_at: new Date().toISOString() }, db);

    // 사업계획서 1 (80%)
    createDocument(
      {
        id: 'doc-rebind-plan-1',
        project_id: rebindProjId,
        file_name: 'plan_1.hwpx',
        file_type: 'hwpx',
        status: '추출 완료',
        doc_type: '사업계획서',
        is_included: 1,
        excluded_reason: null, is_past_final_report: false,
        created_at: new Date().toISOString(),
      },
      db
    );
    insertParagraphs(
      [
        {
          id: 'p-rb-1',
          document_id: 'doc-rebind-plan-1',
          sequence_no: 1,
          location: '¶1',
          content: '행정 시스템 이용 만족도 80% 달성을 목표로 한다.',
        },
      ],
      db
    );

    // 사업계획서 2 (90%)
    createDocument(
      {
        id: 'doc-rebind-plan-2',
        project_id: rebindProjId,
        file_name: 'plan_2.hwpx',
        file_type: 'hwpx',
        status: '추출 완료',
        doc_type: '사업계획서',
        is_included: 1,
        excluded_reason: null, is_past_final_report: false,
        created_at: new Date().toISOString(),
      },
      db
    );
    insertParagraphs(
      [
        {
          id: 'p-rb-2',
          document_id: 'doc-rebind-plan-2',
          sequence_no: 1,
          location: '¶1',
          content: '행정 시스템 이용 만족도 90% 달성을 목표로 한다.',
        },
      ],
      db
    );

    // 성과관리표 (5점 척도 3.5점)
    createDocument(
      {
        id: 'doc-rebind-pdm',
        project_id: rebindProjId,
        file_name: 'pdm.docx',
        file_type: 'docx',
        status: '추출 완료',
        doc_type: '성과관리표',
        is_included: 1,
        excluded_reason: null, is_past_final_report: false,
        created_at: new Date().toISOString(),
      },
      db
    );
    const tableParas = createMockTableParagraphs('doc-rebind-pdm', standardTableRows);
    insertParagraphs(tableParas, db);

    // 1. 초기 동기화 -> 충돌 2개 발생 (doc-rebind-plan-1 vs pdm, doc-rebind-plan-2 vs pdm)
    const initialToc = syncTocForProject(rebindProjId);
    expect(initialToc).not.toBeNull();
    const impactItem = initialToc!.items.find((i) => i.indicator.level === '영향')!;
    const conflicts = initialToc!.conflicts.filter((c) => c.indicator_id === impactItem.indicator.id);
    expect(conflicts.length).toBe(2);

    const conflict1 = conflicts.find((c) => c.doc_a_id === 'doc-rebind-plan-1')!;
    const conflict2 = conflicts.find((c) => c.doc_a_id === 'doc-rebind-plan-2')!;
    expect(conflict1).toBeDefined();
    expect(conflict2).toBeDefined();

    // 2. 두 번째 충돌(conflict2: doc-rebind-plan-2)에서 기준 선택
    const selectRes = await selectBaselineAction(
      rebindProjId,
      impactItem.indicator.id,
      'doc-rebind-plan-2',
      conflict2.id
    );
    expect(selectRes.success).toBe(true);

    // 3. 재동기화 실행
    const resyncedToc = syncTocForProject(rebindProjId);
    expect(resyncedToc).not.toBeNull();

    // 두 번째 충돌의 기준(doc-rebind-plan-2)이 유지되어야 하고, 첫 번째 충돌에는 잘못 붙지 않아야 함
    const resyncedBaselines = resyncedToc!.baselines.filter(
      (b) => b.indicator_id === impactItem.indicator.id
    );
    expect(resyncedBaselines.length).toBe(1);
    expect(resyncedBaselines[0].document_id).toBe('doc-rebind-plan-2');
    expect(resyncedBaselines[0].target_value).toBe('90%');
  });

  it('replaceProjectToc INSERT 에 is_unknown_level 포함: 비표준 단계(활동지원)가 재동기화 뒤에도 DB 와 S3 경고에 남는다 (검수 3회차 3번)', () => {
    const unknownProjId = 'proj-unknown-level-db';
    createProject({ id: unknownProjId, name: '비표준 단계 유지 시험', created_at: new Date().toISOString() }, db);

    createDocument(
      {
        id: 'doc-unknown-pdm',
        project_id: unknownProjId,
        file_name: 'pdm_unknown.docx',
        file_type: 'docx',
        status: '추출 완료',
        doc_type: '성과관리표',
        is_included: 1,
        excluded_reason: null, is_past_final_report: false,
        created_at: new Date().toISOString(),
      },
      db
    );

    const unknownTableRows = [
      {
        level: '영향',
        name: '대국민 전자정부 서비스 만족도',
        ovi: '대국민 전자정부 서비스 체감 만족도',
        mov: '설문조사 보고서',
        target_value: '5점 척도 3.5점 달성',
      },
      {
        level: '활동지원',
        name: '비표준 지원 활동',
        ovi: '업무 지원 만족도',
        mov: '지원 실적 보고서',
        target_value: '10회 달성',
      },
    ];
    const tableParas = createMockTableParagraphs('doc-unknown-pdm', unknownTableRows);
    insertParagraphs(tableParas, db);

    // 1. 초기 동기화
    const toc1 = syncTocForProject(unknownProjId);
    expect(toc1).not.toBeNull();
    const item1 = toc1!.items.find((i) => i.indicator.level === '활동지원')!;
    expect(item1).toBeDefined();
    expect(item1.is_unknown_level).toBe(true);

    // DB 직접 검증
    const ind1 = db
      .prepare('SELECT is_unknown_level FROM indicators WHERE level = ?')
      .get('활동지원') as { is_unknown_level: number };
    expect(ind1.is_unknown_level).toBe(1);

    // 2. 재동기화 후에도 DB 및 S3에 온전히 보존되는지 검증
    const toc2 = syncTocForProject(unknownProjId);
    expect(toc2).not.toBeNull();
    const item2 = toc2!.items.find((i) => i.indicator.level === '활동지원')!;
    expect(item2).toBeDefined();
    expect(item2.is_unknown_level).toBe(true);

    const ind2 = db
      .prepare('SELECT is_unknown_level FROM indicators WHERE level = ?')
      .get('활동지원') as { is_unknown_level: number };
    expect(ind2.is_unknown_level).toBe(1);
  });

  it('한 지표에 복수 충돌 시 S3 에 충돌 목록이 모두 보이고 각각 기준을 고를 수 있으며, S4 지표 머리에 고른 기준들이 모두 보인다 (검수 3회차 4번)', async () => {
    const multiConflictProjId = 'proj-multi-conflict-s3-s4';
    createProject({ id: multiConflictProjId, name: '복수 충돌 S3 S4 시험', created_at: new Date().toISOString() }, db);

    // 사업계획서 1 (80%)
    createDocument(
      {
        id: 'doc-mc-plan-1',
        project_id: multiConflictProjId,
        file_name: 'plan_1.hwpx',
        file_type: 'hwpx',
        status: '추출 완료',
        doc_type: '사업계획서',
        is_included: 1,
        excluded_reason: null, is_past_final_report: false,
        created_at: new Date().toISOString(),
      },
      db
    );
    insertParagraphs(
      [
        {
          id: 'p-mc-1',
          document_id: 'doc-mc-plan-1',
          sequence_no: 1,
          location: '¶1',
          content: '행정 시스템 이용 만족도 80% 달성을 목표로 한다.',
        },
      ],
      db
    );

    // 사업계획서 2 (90%)
    createDocument(
      {
        id: 'doc-mc-plan-2',
        project_id: multiConflictProjId,
        file_name: 'plan_2.hwpx',
        file_type: 'hwpx',
        status: '추출 완료',
        doc_type: '사업계획서',
        is_included: 1,
        excluded_reason: null, is_past_final_report: false,
        created_at: new Date().toISOString(),
      },
      db
    );
    insertParagraphs(
      [
        {
          id: 'p-mc-2',
          document_id: 'doc-mc-plan-2',
          sequence_no: 1,
          location: '¶1',
          content: '행정 시스템 이용 만족도 90% 달성을 목표로 한다.',
        },
      ],
      db
    );

    // 성과관리표 (5점 척도 3.5점)
    createDocument(
      {
        id: 'doc-mc-pdm',
        project_id: multiConflictProjId,
        file_name: 'pdm.docx',
        file_type: 'docx',
        status: '추출 완료',
        doc_type: '성과관리표',
        is_included: 1,
        excluded_reason: null, is_past_final_report: false,
        created_at: new Date().toISOString(),
      },
      db
    );
    const tableParas = createMockTableParagraphs('doc-mc-pdm', standardTableRows);
    insertParagraphs(tableParas, db);

    // 1. S3 데이터 검증: item.conflicts 목록에 두 충돌이 모두 보임
    const tocData = syncTocForProject(multiConflictProjId);
    expect(tocData).not.toBeNull();
    const item = tocData!.items.find((i) => i.indicator.level === '영향')!;
    expect(item.conflicts).toBeDefined();
    expect(item.conflicts!.length).toBe(2);

    const conf1 = item.conflicts!.find((c) => c.doc_a_id === 'doc-mc-plan-1')!;
    const conf2 = item.conflicts!.find((c) => c.doc_a_id === 'doc-mc-plan-2')!;
    expect(conf1).toBeDefined();
    expect(conf2).toBeDefined();

    // 2. 각각 기준을 고를 수 있음 (두 충돌 각각에서 기준 선택)
    const res1 = await selectBaselineAction(multiConflictProjId, item.indicator.id, 'doc-mc-plan-1', conf1.id);
    expect(res1.success).toBe(true);

    const res2 = await selectBaselineAction(multiConflictProjId, item.indicator.id, 'doc-mc-plan-2', conf2.id);
    expect(res2.success).toBe(true);

    const reToc = getTocData(multiConflictProjId);
    const reItem = reToc!.items.find((i) => i.indicator.level === '영향')!;
    expect(reItem.baselines).toBeDefined();
    expect(reItem.baselines!.length).toBe(2);
  });

  it('PDM 지표 매칭: 정규화한 지표 이름이 일치할 때만 짝, OVI만 같은 경우·일치 항목 없을 때 짝 없음 (충돌 없음) (#19 검수 4회차 1번)', () => {
    const testProjId = 'proj-pdm-matching-test';
    // public-safety-allow: test timestamp placeholder
    createProject({ id: testProjId, name: 'PDM 지표 매칭 시험', created_at: new Date().toISOString() }, db);

    // 성과관리표 원본 항목 (이름: '공통 플랫폼 구축', ovi: '공통 플랫폼 개발 및 인수')
    const pdmItems = [
      {
        level: '산출물',
        name: '공통 플랫폼 구축',
        ovi: '공통 플랫폼 개발 및 인수',
        mov: '인수증',
        target_value: '1식',
        source_doc_id: 'doc-pdm-match',
        source_location: '¶1',
        sort_order: 1,
      },
    ];

    createDocument(
      {
        id: 'doc-pdm-match',
        project_id: testProjId,
        file_name: 'pdm.docx',
        file_type: 'docx',
        status: '추출 완료',
        doc_type: '성과관리표',
        is_included: 1,
        excluded_reason: null, is_past_final_report: false,
        created_at: new Date().toISOString(),
      },
      db
    );

    // 사업계획서 문서 등록 및 문단 삽입
    createDocument(
      {
        id: 'doc-plan-match',
        project_id: testProjId,
        file_name: 'plan.hwpx',
        file_type: 'hwpx',
        status: '추출 완료',
        doc_type: '사업계획서',
        is_included: 1,
        excluded_reason: null, is_past_final_report: false,
        created_at: new Date().toISOString(),
      },
      db
    );
    insertParagraphs(
      [
        {
          id: 'p-match-1',
          document_id: 'doc-plan-match',
          sequence_no: 1,
          location: '¶1',
          // OVI만 같은 다른 지표(전자정부 인프라 확대)에 대한 문단 (목표값: 50식)
          content: '전자정부 인프라 확대 관련하여 50식 구축을 목표로 한다.',
        },
        {
          id: 'p-match-2',
          document_id: 'doc-plan-match',
          sequence_no: 2,
          location: '¶2',
          // 일치 항목 없는 지표(신규 독자 지표)에 대한 문단 (목표값: 5건)
          content: '신규 독자 지표 달성 건수 5건 달성을 추진한다.',
        },
      ],
      db
    );

    const documents = [
      {
        id: 'doc-plan-match',
        project_id: testProjId,
        file_name: 'plan.hwpx',
        file_type: 'hwpx' as const,
        status: '추출 완료' as const,
        doc_type: '사업계획서' as const,
        is_included: 1,
        excluded_reason: null, is_past_final_report: false,
        created_at: new Date().toISOString(),
      },
      {
        id: 'doc-pdm-match',
        project_id: testProjId,
        file_name: 'pdm.docx',
        file_type: 'docx' as const,
        status: '추출 완료' as const,
        doc_type: '성과관리표' as const,
        is_included: 1,
        excluded_reason: null, is_past_final_report: false,
        created_at: new Date().toISOString(),
      },
    ];

    const indicators: IndicatorRecord[] = [
      // 1. OVI 만 같고 이름이 다른 지표: 짝 없음 -> 충돌 없어야 함
      {
        id: 'ind-same-ovi-diff-name',
        project_id: testProjId,
        level: '산출물',
        name: '전자정부 인프라 확대', // 이름 불일치
        ovi: '공통 플랫폼 개발 및 인수', // OVI만 PDM 항목과 일치
        mov: null,
        target_value: '10식',
        source_doc_id: 'doc-pdm-match',
        source_location: '¶1',
        sort_order: 1,
        is_baseline: 0,
        created_at: new Date().toISOString(),
      },
      // 2. PDM 항목 중 일치 항목이 아예 없는 지표: ind.target_value 로 비교를 이어가지 않고 짝 없음 -> 충돌 없어야 함
      {
        id: 'ind-no-matching-item',
        project_id: testProjId,
        level: '산출물',
        name: '신규 독자 지표', // PDM 항목에 없음
        ovi: '새로운 측정 방법',
        mov: null,
        target_value: '99건', // ind.target_value 가 존재해도 비교로 이어지지 않음
        source_doc_id: 'doc-pdm-match',
        source_location: '¶2',
        sort_order: 2,
        is_baseline: 0,
        created_at: new Date().toISOString(),
      },
    ];

    const conflicts = detectConflicts(testProjId, indicators, documents, pdmItems);

    // OVI 만 같은 다른 지표는 짝 없음, 일치 항목 없으면 충돌 없음
    expect(conflicts.length).toBe(0);
  });

  it('S3 라디오 선택 상태를 기준 식별자(지표 정규화 이름, 두 문서 id)로 저장하고 서버가 돌려준 기준 목록으로 매번 다시 맞춤 (#19 검수 4회차 2번)', async () => {
    const radioProjId = 'proj-s3-radio-sync-test';
    // public-safety-allow: test timestamp placeholder
    createProject({ id: radioProjId, name: 'S3 라디오 식별자 동기화 시험', created_at: new Date().toISOString() }, db);

    // 1. 사업계획서 1 (80%)
    createDocument(
      {
        id: 'doc-radio-plan-1',
        project_id: radioProjId,
        file_name: '01_plan1.hwpx',
        file_type: 'hwpx',
        status: '추출 완료',
        doc_type: '사업계획서',
        is_included: 1,
        excluded_reason: null, is_past_final_report: false,
        created_at: new Date().toISOString(),
      },
      db
    );
    insertParagraphs(
      [
        {
          id: 'p-r-1',
          document_id: 'doc-radio-plan-1',
          sequence_no: 1,
          location: '¶1',
          content: '행정 시스템 이용 만족도 80% 달성을 최종 목표로 설정한다.',
        },
      ],
      db
    );

    // 2. 사업계획서 2 (90%)
    createDocument(
      {
        id: 'doc-radio-plan-2',
        project_id: radioProjId,
        file_name: '02_plan2.hwpx',
        file_type: 'hwpx',
        status: '추출 완료',
        doc_type: '사업계획서',
        is_included: 1,
        excluded_reason: null, is_past_final_report: false,
        created_at: new Date().toISOString(),
      },
      db
    );
    insertParagraphs(
      [
        {
          id: 'p-r-2',
          document_id: 'doc-radio-plan-2',
          sequence_no: 1,
          location: '¶1',
          content: '행정 시스템 이용 만족도 90% 달성을 목표로 한다.',
        },
      ],
      db
    );

    // 3. 성과관리표 (5점 척도 3.5점)
    createDocument(
      {
        id: 'doc-radio-pdm',
        project_id: radioProjId,
        file_name: 'pdm.docx',
        file_type: 'docx',
        status: '추출 완료',
        doc_type: '성과관리표',
        is_included: 1,
        excluded_reason: null, is_past_final_report: false,
        created_at: new Date().toISOString(),
      },
      db
    );
    const tableParas = createMockTableParagraphs('doc-radio-pdm', standardTableRows);
    insertParagraphs(tableParas, db);

    // 4. 초기 ToC 동기화: 영향 지표에 충돌 2개 존재
    const tocData = syncTocForProject(radioProjId);
    expect(tocData).not.toBeNull();
    const item = tocData!.items.find((i) => i.indicator.level === '영향')!;
    expect(item.conflicts).toBeDefined();
    expect(item.conflicts!.length).toBe(2);

    const conf1 = item.conflicts!.find((c) => c.doc_a_id === 'doc-radio-plan-1')!;
    const conf2 = item.conflicts!.find((c) => c.doc_a_id === 'doc-radio-plan-2')!;
    expect(conf1).toBeDefined();
    expect(conf2).toBeDefined();

    // 초기 라디오 선택 상태: 기준 식별자(지표 정규화 이름, 두 문서 id)로 구성
    let selectedDocs = syncSelectedDocsFromToc(tocData!);
    const key1 = getBaselineKey(item.indicator.name, conf1.doc_a_id, conf1.doc_b_id);
    const key2 = getBaselineKey(item.indicator.name, conf2.doc_a_id, conf2.doc_b_id);

    expect(selectedDocs[key1]).toBe('doc-radio-plan-1');
    expect(selectedDocs[key2]).toBe('doc-radio-plan-2');

    // 두 번째 충돌에서 '다른 문서'(성과관리표, doc-radio-pdm) 선택
    selectedDocs[key2] = 'doc-radio-pdm';

    // 두 번째 충돌 저장
    const resSave2 = await selectBaselineAction(radioProjId, item.indicator.id, selectedDocs[key2], conf2.id);
    expect(resSave2.success).toBe(true);
    expect(resSave2.data).toBeDefined();

    // 재동기화: 서버가 돌려준 기준 목록으로 매번 다시 맞춤
    selectedDocs = syncSelectedDocsFromToc(resSave2.data!, selectedDocs);

    // 라디오 선택 상태와 서버 저장 표시 일치 검증
    expect(selectedDocs[key2]).toBe('doc-radio-pdm');

    const updatedItem = resSave2.data!.items.find((i) => i.indicator.id === item.indicator.id)!;
    const b2 = updatedItem.baselines?.find(
      (b) =>
        (b.document_id === conf2.doc_a_id && b.other_doc_id === conf2.doc_b_id) ||
        (b.document_id === conf2.doc_b_id && b.other_doc_id === conf2.doc_a_id)
    );
    expect(b2).toBeDefined();
    expect(b2!.document_id).toBe('doc-radio-pdm');
    // 라디오와 저장 표시 일치
    expect(selectedDocs[key2]).toBe(b2!.document_id);

    // 재선택 없이 저장해도 엉뚱한 값(기본값인 doc-radio-plan-2)으로 바뀌지 않음
    const reSaveDocId = selectedDocs[key2];
    expect(reSaveDocId).toBe('doc-radio-pdm');

    const resReSave = await selectBaselineAction(radioProjId, item.indicator.id, reSaveDocId, conf2.id);
    expect(resReSave.success).toBe(true);

    const reUpdatedItem = resReSave.data!.items.find((i) => i.indicator.id === item.indicator.id)!;
    const reB2 = reUpdatedItem.baselines?.find(
      (b) =>
        (b.document_id === conf2.doc_a_id && b.other_doc_id === conf2.doc_b_id) ||
        (b.document_id === conf2.doc_b_id && b.other_doc_id === conf2.doc_a_id)
    );
    expect(reB2).toBeDefined();
    expect(reB2!.document_id).toBe('doc-radio-pdm'); // 엉뚱한 값으로 변경되지 않고 유지
  });

  it('pdmItems 미전달 또는 빈 배열 시 ind.target_value 폴백 없이 짝 없음·충돌 없음 (#19 검수 5회차)', () => {
    const testProjId = 'proj-pdm-missing-test';
    // public-safety-allow: test timestamp placeholder
    createProject({ id: testProjId, name: 'PDM 미전달 시험', created_at: new Date().toISOString() }, db);

    // 사업계획서 문서 및 문단 등록
    createDocument(
      {
        id: 'doc-plan-5',
        project_id: testProjId,
        file_name: 'plan5.hwpx',
        file_type: 'hwpx',
        status: '추출 완료',
        doc_type: '사업계획서',
        is_included: 1,
        excluded_reason: null, is_past_final_report: false,
        // public-safety-allow: test timestamp placeholder
        created_at: new Date().toISOString(),
      },
      db
    );
    insertParagraphs(
      [
        {
          id: 'p-5-1',
          document_id: 'doc-plan-5',
          sequence_no: 1,
          location: '¶1',
          content: '행정 시스템 이용 만족도 80% 달성을 최종 목표로 설정한다.',
        },
      ],
      db
    );

    // 성과관리표 문서 등록
    createDocument(
      {
        id: 'doc-pdm-5',
        project_id: testProjId,
        file_name: 'pdm5.docx',
        file_type: 'docx',
        status: '추출 완료',
        doc_type: '성과관리표',
        is_included: 1,
        excluded_reason: null, is_past_final_report: false,
        // public-safety-allow: test timestamp placeholder
        created_at: new Date().toISOString(),
      },
      db
    );

    const documents = [
      {
        id: 'doc-plan-5',
        project_id: testProjId,
        file_name: 'plan5.hwpx',
        file_type: 'hwpx' as const,
        status: '추출 완료' as const,
        doc_type: '사업계획서' as const,
        is_included: 1,
        excluded_reason: null, is_past_final_report: false,
        // public-safety-allow: test timestamp placeholder
        created_at: new Date().toISOString(),
      },
      {
        id: 'doc-pdm-5',
        project_id: testProjId,
        file_name: 'pdm5.docx',
        file_type: 'docx' as const,
        status: '추출 완료' as const,
        doc_type: '성과관리표' as const,
        is_included: 1,
        excluded_reason: null, is_past_final_report: false,
        // public-safety-allow: test timestamp placeholder
        created_at: new Date().toISOString(),
      },
    ];

    const indicators: IndicatorRecord[] = [
      {
        id: 'ind-5-1',
        project_id: testProjId,
        level: '영향',
        name: '행정 시스템 이용 만족도',
        ovi: '체감 만족도',
        mov: '설문조사',
        target_value: '5점 척도 3.5점',
        source_doc_id: 'doc-pdm-5',
        source_location: '¶1',
        sort_order: 1,
        is_baseline: 0,
        // public-safety-allow: test timestamp placeholder
        created_at: new Date().toISOString(),
      },
    ];

    // 1. pdmItems 미전달: ind.target_value 로 비교를 이어가지 않고 짝 없음·충돌 없음
    const conflictsMissing = detectConflicts(testProjId, indicators, documents);
    expect(conflictsMissing.length).toBe(0);

    // 2. pdmItems 빈 배열 전달: 정규화 이름 일치 항목 없으므로 짝 없음·충돌 없음
    const conflictsEmpty = detectConflicts(testProjId, indicators, documents, []);
    expect(conflictsEmpty.length).toBe(0);
  });

  it('확정 이력이 있는 지표가 있는 상태에서 재동기화 → 오류 없음·id 유지·이력 유지, 성과관리표에서 그 지표를 빼면 orphaned 로 남음, 이력 없는 지표는 삭제됨 (#19)', () => {
    const testProjId = 'proj-toc-confirm-orphan-test';
    // public-safety-allow: test timestamp placeholder
    createProject({ id: testProjId, name: 'ToC 재동기화 이력 보존 시험', created_at: new Date().toISOString() }, db);

    createDocument(
      {
        id: 'doc-pdm-orphan',
        project_id: testProjId,
        file_name: '02_pdm.docx',
        file_type: 'docx' as const,
        status: '추출 완료' as const,
        doc_type: '성과관리표' as const,
        is_included: 1,
        excluded_reason: null, is_past_final_report: false,
        // public-safety-allow: test timestamp placeholder
        created_at: new Date().toISOString(),
      },
      db
    );

    const initialRows = [
      {
        level: '영향',
        name: '대국민 전자정부 서비스 만족도',
        ovi: '대국민 전자정부 서비스 체감 만족도',
        mov: '설문조사 보고서',
        target_value: '5점 척도 3.5점 달성',
      },
      {
        level: '중기성과',
        name: '행정 업무 효율 증진',
        ovi: '업무 처리 시간 단축률',
        mov: '로그 분석',
        target_value: '30% 단축',
      },
      {
        level: '산출물',
        name: '디지털 행정 기반 구축',
        ovi: '공통 플랫폼 구축',
        mov: '검사 확인서',
        target_value: '1식 완료',
      },
    ];

    insertParagraphs(createMockTableParagraphs('doc-pdm-orphan', initialRows), db);

    // 1. 초기 동기화
    const toc1 = syncTocForProject(testProjId);
    expect(toc1).not.toBeNull();
    const ind1List = listIndicators(testProjId, db);
    expect(ind1List.length).toBe(3);

    const indImpact = ind1List.find((i) => i.name === '대국민 전자정부 서비스 만족도')!;
    const indMidterm = ind1List.find((i) => i.name === '행정 업무 효율 증진')!;
    const indOutput = ind1List.find((i) => i.name === '디지털 행정 기반 구축')!;
    expect(indImpact).toBeDefined();
    expect(indMidterm).toBeDefined();
    expect(indOutput).toBeDefined();

    // indImpact: 제안 1건 + 확정 1건 추가
    saveSuggestion(
      {
        id: 'sugg-impact-1',
        indicator_id: indImpact.id,
        verdict_status: '실현',
        error_reason: null,
        proposal_text: '만족도 지표가 충족되었습니다.',
        // public-safety-allow: test timestamp placeholder
        created_at: new Date().toISOString(),
      },
      [],
      db
    );
    createConfirmation(
      {
        indicator_id: indImpact.id,
        confirmation_type: '확정',
        confirmer_name: '홍길동',
      },
      db
    );

    // indMidterm: 제안만 1건 추가 (이력 있음, 확정 없음)
    saveSuggestion(
      {
        id: 'sugg-midterm-1',
        indicator_id: indMidterm.id,
        verdict_status: '추진 중',
        error_reason: null,
        proposal_text: '행정 효율 지표 추진 중입니다.',
        // public-safety-allow: test timestamp placeholder
        created_at: new Date().toISOString(),
      },
      [],
      db
    );

    // indOutput: 제안 없음, 확정 없음 (이력 없음)

    // 2. 확정 이력이 있는 상태에서 그대로 재동기화
    // 지표는 지우고 다시 만들지 않고 (단계, 정규화 지표 이름)으로 갱신
    const toc2 = syncTocForProject(testProjId);
    expect(toc2).not.toBeNull();

    const ind2List = listIndicators(testProjId, db);
    const indImpact2 = ind2List.find((i) => i.name === '대국민 전자정부 서비스 만족도')!;
    const indMidterm2 = ind2List.find((i) => i.name === '행정 업무 효율 증진')!;
    const indOutput2 = ind2List.find((i) => i.name === '디지털 행정 기반 구축')!;

    // id 유지 확인
    expect(indImpact2.id).toBe(indImpact.id);
    expect(indMidterm2.id).toBe(indMidterm.id);
    expect(indOutput2.id).toBe(indOutput.id);

    // 이력 유지 확인
    const confirmationsAfterResync = listConfirmations(indImpact.id, db);
    expect(confirmationsAfterResync.length).toBe(1);
    expect(confirmationsAfterResync[0].confirmer_name).toBe('홍길동');

    // 모두 활성(is_orphaned !== 1)
    expect(indImpact2.is_orphaned ?? 0).toBe(0);
    expect(indMidterm2.is_orphaned ?? 0).toBe(0);
    expect(indOutput2.is_orphaned ?? 0).toBe(0);

    // 3. 성과관리표에서 indImpact 와 indOutput 을 빼고, indMidterm 만 남김
    db.prepare('DELETE FROM paragraphs WHERE document_id = ?').run('doc-pdm-orphan');
    const updatedRows = [
      {
        level: '중기성과',
        name: '행정 업무 효율 증진',
        ovi: '업무 처리 시간 단축률',
        mov: '로그 분석',
        target_value: '30% 단축',
      },
    ];
    insertParagraphs(createMockTableParagraphs('doc-pdm-orphan', updatedRows), db);

    const toc3 = syncTocForProject(testProjId);
    expect(toc3).not.toBeNull();

    const ind3List = listIndicators(testProjId, db);
    // indOutput 은 이력이 전혀 없으므로 삭제됨!
    const indOutput3 = ind3List.find((i) => i.name === '디지털 행정 기반 구축');
    expect(indOutput3).toBeUndefined();

    // indImpact 는 확정 이력이 있으므로 삭제되지 않고 is_orphaned=1 로 남음!
    const indImpact3 = ind3List.find((i) => i.name === '대국민 전자정부 서비스 만족도');
    expect(indImpact3).toBeDefined();
    expect(indImpact3!.id).toBe(indImpact.id);
    expect(indImpact3!.is_orphaned).toBe(1);

    // indImpact 의 확정 이력도 여전히 온전히 보존됨!
    const confirmationsOrphaned = listConfirmations(indImpact.id, db);
    expect(confirmationsOrphaned.length).toBe(1);

    // indMidterm 은 문서에 계속 남아있으므로 id 유지 및 is_orphaned=0
    const indMidterm3 = ind3List.find((i) => i.name === '행정 업무 효율 증진');
    expect(indMidterm3).toBeDefined();
    expect(indMidterm3!.id).toBe(indMidterm.id);
    expect(indMidterm3!.is_orphaned ?? 0).toBe(0);

    // 4. S3 getTocData 및 S4 getReviewData 에 "문서에서 사라진 지표 — 이력 보존" 확인
    const s3Data = getTocData(testProjId, db);
    expect(s3Data).not.toBeNull();
    const orphanedInS3 = s3Data!.items.filter((item) => item.indicator.is_orphaned === 1);
    expect(orphanedInS3.length).toBe(1);
    expect(orphanedInS3[0].indicator.name).toBe('대국민 전자정부 서비스 만족도');

    const s4Data = getReviewData(testProjId, db);
    expect(s4Data).not.toBeNull();
    const orphanedInS4 = s4Data!.indicators.filter((item) => item.indicator.is_orphaned === 1);
    expect(orphanedInS4.length).toBe(1);
    expect(orphanedInS4[0].indicator.name).toBe('대국민 전자정부 서비스 만족도');

    // 5. 다시 나타나면 orphaned 해제
    db.prepare('DELETE FROM paragraphs WHERE document_id = ?').run('doc-pdm-orphan');
    insertParagraphs(createMockTableParagraphs('doc-pdm-orphan', initialRows), db);

    const toc4 = syncTocForProject(testProjId);
    expect(toc4).not.toBeNull();

    const ind4List = listIndicators(testProjId, db);
    const indImpact4 = ind4List.find((i) => i.name === '대국민 전자정부 서비스 만족도');
    expect(indImpact4).toBeDefined();
    expect(indImpact4!.id).toBe(indImpact.id);
    expect(indImpact4!.is_orphaned ?? 0).toBe(0); // orphaned 해제!
    expect(listConfirmations(indImpact.id, db).length).toBe(1); // 이력 유지!
  });

  it('지표를 참조하는 임시/외부 테이블이 있고 행이 있으면 문서 삭제 시 지우지 않고 orphaned 보존 (#19 2회차)', () => {
    const testProjId = 'proj-toc-fk-dyn-orphan-test';
    // public-safety-allow: test timestamp placeholder
    createProject({ id: testProjId, name: '외래키 동적 조회 orphaned 시험', created_at: new Date().toISOString() }, db);

    createDocument(
      {
        id: 'doc-pdm-fk-dyn',
        project_id: testProjId,
        file_name: '02_pdm.docx',
        file_type: 'docx' as const,
        status: '추출 완료' as const,
        doc_type: '성과관리표' as const,
        is_included: 1,
        excluded_reason: null, is_past_final_report: false,
        // public-safety-allow: test timestamp placeholder
        created_at: new Date().toISOString(),
      },
      db
    );

    const initialRows = [
      {
        level: '산출물',
        name: '임시 참조 지표',
        ovi: '외래키 참조 지표 OVI',
        mov: '검사 확인서',
        target_value: '1식 완료',
      },
      {
        level: '활동',
        name: '일반 삭제 지표',
        ovi: '참조 없는 일반 지표 OVI',
        mov: '보고서',
        target_value: '10회',
      },
    ];

    insertParagraphs(createMockTableParagraphs('doc-pdm-fk-dyn', initialRows), db);

    // 1. 초기 동기화
    const toc1 = syncTocForProject(testProjId);
    expect(toc1).not.toBeNull();
    const ind1List = listIndicators(testProjId, db);
    expect(ind1List.length).toBe(2);

    const indRef = ind1List.find((i) => i.name === '임시 참조 지표')!;
    const indNormal = ind1List.find((i) => i.name === '일반 삭제 지표')!;
    expect(indRef).toBeDefined();
    expect(indNormal).toBeDefined();

    // suggestions, confirmations 는 없음
    // 시험용 임시/외부 참조 테이블 동적 생성 (indicators 참조)
    db.exec(`
      CREATE TABLE test_custom_attributions (
        id TEXT PRIMARY KEY,
        target_ind_id TEXT NOT NULL REFERENCES indicators(id)
      );
    `);
    db.prepare('INSERT INTO test_custom_attributions VALUES (?, ?)').run('attr-1', indRef.id);

    // 2. 성과관리표에서 두 지표 모두 제거
    db.prepare('DELETE FROM paragraphs WHERE document_id = ?').run('doc-pdm-fk-dyn');
    const updatedRows = [
      {
        level: '영향',
        name: '새로운 영향 지표',
        ovi: '새로운 OVI',
        mov: '보고서',
        target_value: '100%',
      },
    ];
    insertParagraphs(createMockTableParagraphs('doc-pdm-fk-dyn', updatedRows), db);

    const toc2 = syncTocForProject(testProjId);
    expect(toc2).not.toBeNull();

    const ind2List = listIndicators(testProjId, db);

    // indNormal 은 외래키 참조가 어디에도 없으므로 DB에서 완전히 삭제됨
    expect(ind2List.find((i) => i.id === indNormal.id)).toBeUndefined();

    // indRef 는 test_custom_attributions 가 참조하고 행이 있으므로 삭제되지 않고 is_orphaned=1 로 보존됨!
    const indRefAfter = ind2List.find((i) => i.id === indRef.id);
    expect(indRefAfter).toBeDefined();
    expect(indRefAfter!.is_orphaned).toBe(1);

    // 3. 외부 테이블에서 행을 삭제한 후 다시 재동기화하면 완전히 삭제됨
    db.prepare('DELETE FROM test_custom_attributions WHERE id = ?').run('attr-1');
    const toc3 = syncTocForProject(testProjId);
    expect(toc3).not.toBeNull();

    const ind3List = listIndicators(testProjId, db);
    expect(ind3List.find((i) => i.id === indRef.id)).toBeUndefined();
  });

  it('자연 키가 중복인 경우 첫 번째만 지표로 생성하고 S3에 "같은 지표가 두 번 나옵니다" 경고 표출 (#19 2회차)', () => {
    const testProjId = 'proj-toc-natural-duplicate-test';
    // public-safety-allow: test timestamp placeholder
    createProject({ id: testProjId, name: '자연 키 중복 정책 시험', created_at: new Date().toISOString() }, db);

    createDocument(
      {
        id: 'doc-pdm-dup',
        project_id: testProjId,
        file_name: '02_pdm.docx',
        file_type: 'docx' as const,
        status: '추출 완료' as const,
        doc_type: '성과관리표' as const,
        is_included: 1,
        excluded_reason: null, is_past_final_report: false,
        // public-safety-allow: test timestamp placeholder
        created_at: new Date().toISOString(),
      },
      db
    );

    const duplicateRows = [
      {
        level: '중기성과',
        name: '대국민 서비스 만족도',
        ovi: '체감 만족도 80% 달성',
        mov: '설문조사',
        target_value: '80%',
      },
      {
        level: '중기성과',
        name: '대국민  서비스  만족도 ', // 정규화 시 동일
        ovi: '체감 만족도 80% 달성', // 정규화 시 동일
        mov: '로그 분석',
        target_value: '85%', // 두 번째 행 (중복)
      },
      {
        level: '산출물',
        name: '디지털 행정 기반 구축',
        ovi: '공통 플랫폼 구축',
        mov: '검사 확인서',
        target_value: '1식 완료',
      },
    ];

    insertParagraphs(createMockTableParagraphs('doc-pdm-dup', duplicateRows), db);

    const toc = syncTocForProject(testProjId);
    expect(toc).not.toBeNull();

    // 중복된 키는 첫 번째만 생성되어 총 지표 수는 2개여야 함
    const indList = listIndicators(testProjId, db);
    expect(indList.length).toBe(2);

    const firstInd = indList.find((i) => i.name === '대국민 서비스 만족도');
    expect(firstInd).toBeDefined();
    // 첫 번째 행의 목표값 80% 반영
    expect(firstInd!.target_value).toBe('80%');

    // S3 warningMessage 확인: "같은 지표가 두 번 나옵니다"
    expect(toc!.warningMessage).toBe('같은 지표가 두 번 나옵니다 · 표 다시 읽기 필요(자료를 다시 올리면 정확히 읽습니다)');
    const s3Data = getTocData(testProjId, db);
    expect(s3Data!.warningMessage).toBe('같은 지표가 두 번 나옵니다 · 표 다시 읽기 필요(자료를 다시 올리면 정확히 읽습니다)');
  });

  it('성과관리표 행 순서가 바뀌어도 확정 이력이 자연 키(단계, 정규화 이름, 정규화 OVI)가 같은 지표에 붙음 (#19 2회차)', () => {
    const testProjId = 'proj-toc-reorder-confirm-test';
    // public-safety-allow: test timestamp placeholder
    createProject({ id: testProjId, name: '순서 변경 이력 보존 시험', created_at: new Date().toISOString() }, db);

    createDocument(
      {
        id: 'doc-pdm-reorder',
        project_id: testProjId,
        file_name: '02_pdm.docx',
        file_type: 'docx' as const,
        status: '추출 완료' as const,
        doc_type: '성과관리표' as const,
        is_included: 1,
        excluded_reason: null, is_past_final_report: false,
        // public-safety-allow: test timestamp placeholder
        created_at: new Date().toISOString(),
      },
      db
    );

    const initialRows = [
      {
        level: '중기성과',
        name: '행정 업무 효율 증진',
        ovi: '업무 처리 시간 단축률',
        mov: '로그 분석',
        target_value: '30% 단축',
      },
      {
        level: '산출물',
        name: '디지털 행정 기반 구축',
        ovi: '공통 플랫폼 구축',
        mov: '검사 확인서',
        target_value: '1식 완료',
      },
    ];

    insertParagraphs(createMockTableParagraphs('doc-pdm-reorder', initialRows), db);

    // 1. 초기 동기화
    const toc1 = syncTocForProject(testProjId);
    expect(toc1).not.toBeNull();
    const ind1List = listIndicators(testProjId, db);
    const indEfficiency = ind1List.find((i) => i.name === '행정 업무 효율 증진')!;
    const indPlatform = ind1List.find((i) => i.name === '디지털 행정 기반 구축')!;
    expect(indEfficiency).toBeDefined();
    expect(indPlatform).toBeDefined();

    // indEfficiency 에 제안 및 확정 이력 부여
    saveSuggestion(
      {
        id: 'sugg-eff-1',
        indicator_id: indEfficiency.id,
        verdict_status: '실현',
        error_reason: null,
        proposal_text: '업무 효율 달성 제안',
        // public-safety-allow: test timestamp placeholder
        created_at: new Date().toISOString(),
      },
      [],
      db
    );
    createConfirmation(
      {
        indicator_id: indEfficiency.id,
        confirmation_type: '확정',
        confirmer_name: '홍길동',
      },
      db
    );

    expect(listConfirmations(indEfficiency.id, db).length).toBe(1);
    expect(listConfirmations(indPlatform.id, db).length).toBe(0);

    // 2. 성과관리표 행 순서를 뒤바꿈 (산출물이 먼저, 중기성과가 나중에)
    db.prepare('DELETE FROM paragraphs WHERE document_id = ?').run('doc-pdm-reorder');
    const reversedRows = [
      {
        level: '산출물',
        name: '디지털 행정 기반 구축',
        ovi: '공통 플랫폼 구축',
        mov: '검사 확인서',
        target_value: '1식 완료',
      },
      {
        level: '중기성과',
        name: '행정 업무 효율 증진',
        ovi: '업무 처리 시간 단축률',
        mov: '로그 분석',
        target_value: '30% 단축',
      },
    ];
    insertParagraphs(createMockTableParagraphs('doc-pdm-reorder', reversedRows), db);

    const toc2 = syncTocForProject(testProjId);
    expect(toc2).not.toBeNull();

    const ind2List = listIndicators(testProjId, db);
    const indEfficiency2 = ind2List.find((i) => i.name === '행정 업무 효율 증진')!;
    const indPlatform2 = ind2List.find((i) => i.name === '디지털 행정 기반 구축')!;

    // 순서가 바뀌었어도 각각 원래 id 를 유지
    expect(indEfficiency2.id).toBe(indEfficiency.id);
    expect(indPlatform2.id).toBe(indPlatform.id);

    // 확정 이력은 여전히 '행정 업무 효율 증진' 지표에 붙어있음
    const confEfficiency = listConfirmations(indEfficiency2.id, db);
    expect(confEfficiency.length).toBe(1);
    expect(confEfficiency[0].confirmer_name).toBe('홍길동');

    const confPlatform = listConfirmations(indPlatform2.id, db);
    expect(confPlatform.length).toBe(0);
  });

  it('기존 DB에 같은 키 행이 여럿 존재할 경우 이력(확정/제안) 있는 행을 우선 매칭 (#19 2회차)', () => {
    const testProjId = 'proj-toc-multi-same-key-test';
    // public-safety-allow: test timestamp placeholder
    createProject({ id: testProjId, name: '복수 키 행 중 이력 우선 매칭 시험', created_at: new Date().toISOString() }, db);

    createDocument(
      {
        id: 'doc-pdm-multi-match',
        project_id: testProjId,
        file_name: '02_pdm.docx',
        file_type: 'docx' as const,
        status: '추출 완료' as const,
        doc_type: '성과관리표' as const,
        is_included: 1,
        excluded_reason: null, is_past_final_report: false,
        // public-safety-allow: test timestamp placeholder
        created_at: new Date().toISOString(),
      },
      db
    );

    // DB에 수동으로 동일한 자연 키(중기성과, '성과 지표 A', 'OVI A')를 가진 행 2개를 생성
    // 하나는 이력 없음(ind-no-hist), 하나는 확정 이력 있음(ind-with-hist)
    const indNoHistId = 'ind-no-hist';
    const indWithHistId = 'ind-with-hist';

    db.prepare(`
      INSERT INTO indicators (
        id, project_id, level, name, ovi, mov, target_value,
        sort_order, is_baseline, is_unknown_level, is_orphaned, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?)
    `).run(
      indNoHistId,
      testProjId,
      '중기성과',
      '성과 지표 A',
      'OVI A',
      '보고서',
      '10%',
      1,
      // public-safety-allow: test timestamp placeholder
      new Date().toISOString()
    );

    db.prepare(`
      INSERT INTO indicators (
        id, project_id, level, name, ovi, mov, target_value,
        sort_order, is_baseline, is_unknown_level, is_orphaned, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?)
    `).run(
      indWithHistId,
      testProjId,
      '중기성과',
      '성과 지표 A',
      'OVI A',
      '보고서',
      '20%',
      2,
      // public-safety-allow: test timestamp placeholder
      new Date().toISOString()
    );

    // ind-with-hist 에 제안 및 확정 이력 부여
    saveSuggestion(
      {
        id: 'sugg-with-hist-1',
        indicator_id: indWithHistId,
        verdict_status: '실현',
        error_reason: null,
        proposal_text: '성과 제안',
        // public-safety-allow: test timestamp placeholder
        created_at: new Date().toISOString(),
      },
      [],
      db
    );
    createConfirmation(
      {
        indicator_id: indWithHistId,
        confirmation_type: '확정',
        confirmer_name: '이순신',
      },
      db
    );

    // PDM 문서에는 이 자연 키 1개만 등록
    const rows = [
      {
        level: '중기성과',
        name: '성과 지표 A',
        ovi: 'OVI A',
        mov: '보고서',
        target_value: '30%',
      },
    ];
    insertParagraphs(createMockTableParagraphs('doc-pdm-multi-match', rows), db);

    // 동기화 실행
    const toc = syncTocForProject(testProjId);
    expect(toc).not.toBeNull();

    const indList = listIndicators(testProjId, db);
    // ind-no-hist 는 이력이 없으므로 삭제되고, ind-with-hist 가 우선 매칭되어 살아남아야 함
    expect(indList.length).toBe(1);
    expect(indList[0].id).toBe(indWithHistId);
    expect(indList[0].target_value).toBe('30%');

    // 확정 이력도 유지
    const confs = listConfirmations(indWithHistId, db);
    expect(confs.length).toBe(1);
    expect(confs[0].confirmer_name).toBe('이순신');
  });

  it('동적 FK 확인이 #20 의 기여 귀속 테이블(indicator_attributions)도 감지하여 기여 귀속만 있는 지표는 삭제되지 않고 orphaned 보존 (#19, #20)', () => {
    const testProjId = 'proj-toc-attribution-fk-test';
    // public-safety-allow: test timestamp placeholder
    createProject({ id: testProjId, name: '기여 귀속 외래키 orphaned 시험', created_at: new Date().toISOString() }, db);

    createDocument(
      {
        id: 'doc-pdm-attr-fk',
        project_id: testProjId,
        file_name: '02_pdm.docx',
        file_type: 'docx' as const,
        status: '추출 완료' as const,
        doc_type: '성과관리표' as const,
        is_included: 1,
        excluded_reason: null, is_past_final_report: false,
        // public-safety-allow: test timestamp placeholder
        created_at: new Date().toISOString(),
      },
      db
    );

    const initialRows = [
      {
        level: '단기성과',
        name: '기여 귀속 보존 대상 지표',
        ovi: 'OVI A',
        mov: '보고서',
        target_value: '50%',
      },
      {
        level: '단기성과',
        name: '미참조 일반 지표',
        ovi: 'OVI B',
        mov: '보고서',
        target_value: '30%',
      },
    ];

    insertParagraphs(createMockTableParagraphs('doc-pdm-attr-fk', initialRows), db);

    const toc1 = syncTocForProject(testProjId);
    expect(toc1).not.toBeNull();
    const ind1List = listIndicators(testProjId, db);
    expect(ind1List.length).toBe(2);

    const indWithAttr = ind1List.find((i) => i.name === '기여 귀속 보존 대상 지표')!;
    const indNormal = ind1List.find((i) => i.name === '미참조 일반 지표')!;
    expect(indWithAttr).toBeDefined();
    expect(indNormal).toBeDefined();

    // suggestions, confirmations 는 없이 #20 기여 귀속(indicator_attributions)만 저장
    saveIndicatorAttribution(testProjId, indWithAttr.id, '평가자 기여 귀속 판단 내용', db);
    expect(getIndicatorAttribution(indWithAttr.id, db)).toBe('평가자 기여 귀속 판단 내용');

    // 성과관리표에서 두 지표 모두 제거하고 새로운 지표만 등록
    db.prepare('DELETE FROM paragraphs WHERE document_id = ?').run('doc-pdm-attr-fk');
    const updatedRows = [
      {
        level: '영향',
        name: '새로운 영향 지표',
        ovi: '새로운 OVI',
        mov: '보고서',
        target_value: '100%',
      },
    ];
    insertParagraphs(createMockTableParagraphs('doc-pdm-attr-fk', updatedRows), db);

    const toc2 = syncTocForProject(testProjId);
    expect(toc2).not.toBeNull();

    const ind2List = listIndicators(testProjId, db);

    // 미참조 일반 지표는 외래키 참조가 없으므로 완전히 삭제됨
    expect(ind2List.find((i) => i.id === indNormal.id)).toBeUndefined();

    // 기여 귀속만 있는 지표는 동적 FK 확인에 의해 삭제되지 않고 is_orphaned=1 로 보존됨
    const indWithAttrAfter = ind2List.find((i) => i.id === indWithAttr.id);
    expect(indWithAttrAfter).toBeDefined();
    expect(indWithAttrAfter!.is_orphaned).toBe(1);

    // 기여 귀속 내용도 유지됨
    expect(getIndicatorAttribution(indWithAttr.id, db)).toBe('평가자 기여 귀속 판단 내용');
  });
});

