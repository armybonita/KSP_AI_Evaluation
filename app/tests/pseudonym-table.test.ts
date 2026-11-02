import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { extractDocx } from '../src/server/extract/docx';
import { parsePdmParagraphs } from '../src/lib/baseline-key';

it('가명 글의 표를 앱이 행과 칸 및 성과 지표로 읽는다', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pseudonym-table-'));
  try {
    const src = join(dir, 'in');
    const dst = join(dir, 'out');
    mkdirSync(src);
    const cells = (values: string[]) => values.flatMap(v => ['[[[AIEAS_CELL]]]', v]);
    const lines = ['[[[AIEAS_TABLE]]]', '[[[AIEAS_ROW]]]', ...cells(['잡표', '무관']), '[[[AIEAS_END_TABLE]]]', '[[[AIEAS_TABLE]]]', '[[[AIEAS_ROW]]]', ...cells(['단계', '서술', '지표', '검증수단', '목표']),
      '[[[AIEAS_ROW]]]', ...cells(['산출물', '가상 교육', '참여 인원', '집계표', '10명']), '둘째 줄', '[[[AIEAS_END_TABLE]]]'];
    writeFileSync(join(src, 'doc-001.pseudo.txt'), lines.join('\n'));
    execFileSync('python3', ['-I', resolve(process.cwd(), '../packages/pseudonym/to_docx.py'), src, dst]);
    const result = await extractDocx(readFileSync(join(dst, 'doc-001.docx')));
    expect(result.status).toBe('추출 완료');
    expect(result.paragraphs.map(p => [p.table_row, p.table_col])).toEqual([
      [1, 1], [1, 2], [1, 1], [1, 2], [1, 3], [1, 4], [1, 5], [2, 1], [2, 2], [2, 3], [2, 4], [2, 5],
    ]);
    expect(result.paragraphs.at(-1)?.content).toBe('10명 둘째 줄');
    const records = result.paragraphs.map((p, i) => ({ ...p, id: String(i), document_id: 'sample' }));
    expect(parsePdmParagraphs(records, 'sample')).toEqual([
      expect.objectContaining({ level: '산출물', ovi: '참여 인원', target_value: '10명 둘째 줄' }),
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it('머리줄이 있는 여러 표를 각각 읽고 머리줄 없는 표를 제외한다', () => {
  const rows = [
    [1, 1, '기타'], [1, 2, '잡표'],
    [1, 1, '단계'], [1, 2, '서술'], [1, 3, '지표'], [1, 4, '검증'], [1, 5, '목표'],
    [2, 1, '산출물'], [2, 2, '첫 사업'], [2, 3, '첫 지표'],
    [1, 1, '단계'], [1, 2, '서술'], [1, 3, '지표'], [1, 4, '검증'], [1, 5, '목표'],
    [2, 1, '활동'], [2, 2, '둘째 사업'], [2, 3, '둘째 지표'],
  ] as const;
  const records = rows.map(([table_row, table_col, content], i) => ({
    id: String(i), document_id: 'sample', sequence_no: i + 1, location: `¶${i + 1}`,
    table_row, table_col, content,
  }));
  expect(parsePdmParagraphs(records, 'sample').map(item => item.ovi)).toEqual(['첫 지표', '둘째 지표']);
});

it('표 번호로 빈 첫 칸이 있는 다음 표를 분리하고 연속 표와 두 줄 머리를 읽는다', () => {
  const tables = [
    [[1, 1, '잡표']],
    [[1, 1, '단계'], [1, 2, '서술'], [1, 3, '성과지표'], [1, 4, '검증'], [1, 5, '목표'],
      [2, 3, '지표명'], [2, 4, '수단'], [2, 5, '목표값'],
      [3, 1, '산출물'], [3, 2, '첫 사업'], [3, 3, '첫 지표']],
    [[1, 2, '둘째 사업'], [1, 3, '둘째 지표'], [1, 5, '20명']],
    [[1, 1, '잡표'], [1, 2, '무관'], [1, 6, '별도']],
  ] as const;
  const records = tables.flatMap((rows, table_index) => rows.map(([table_row, table_col, content]) => ({
    id: `${table_index}-${table_row}-${table_col}`, document_id: 'sample', sequence_no: 1,
    location: '¶1', table_index, table_row, table_col, content,
  })));
  expect(parsePdmParagraphs(records, 'sample').map(item => [item.name, item.ovi])).toEqual([
    ['첫 사업', '첫 지표'], ['둘째 사업', '둘째 지표'],
  ]);
});

it('표 번호가 null인 옛 자료도 행 재시작으로 구분한다', () => {
  const rows = [[1, 1, '잡표'], [1, 1, '단계'], [1, 2, '서술'], [1, 3, '지표'],
    [2, 1, '활동'], [2, 2, '가상 사업'], [2, 3, '가상 지표']] as const;
  const records = rows.map(([table_row, table_col, content], i) => ({
    id: String(i), document_id: 'sample', sequence_no: i + 1, location: `¶${i + 1}`,
    table_index: null, table_row, table_col, content,
  }));
  expect(parsePdmParagraphs(records, 'sample').map(item => item.ovi)).toEqual(['가상 지표']);
});

it('같은 너비의 이어지는 표만 읽고 좁은 잡표는 제외한다', () => {
  const tables = [
    [[1, 1, '단계'], [1, 2, '서술'], [1, 3, '지표'], [1, 4, '검증'], [1, 5, '목표'],
      [2, 1, '활동'], [2, 2, '첫 사업'], [2, 3, '첫 지표'], [2, 5, '10']],
    [[1, 1, '산출물'], [1, 2, '둘째 사업'], [1, 3, '둘째 지표'], [1, 5, '20']],
    [[1, 1, '비고'], [1, 2, '참고']],
  ] as const;
  const records = tables.flatMap((rows, table_index) => rows.map(([table_row, table_col, content], i) => ({
    id: `${table_index}-${i}`, document_id: 'sample', sequence_no: i + 1,
    location: '¶1', table_index, table_row, table_col, content,
  })));
  expect(parsePdmParagraphs(records, 'sample').map(item => item.ovi)).toEqual(['첫 지표', '둘째 지표']);
  expect(parsePdmParagraphs(records.filter(p => p.table_index !== 1), 'sample').map(item => item.ovi)).toEqual(['첫 지표']);
});

it('짧은 둘째 머리줄은 제외하고 긴 서술과 숫자 목표가 든 자료행은 읽는다', () => {
  const tables = [
    [[1, 1, '단계'], [1, 2, '서술'], [1, 3, '지표'], [1, 4, '검증'], [1, 5, '목표'],
      [2, 2, '사업명'], [2, 3, '지표명'], [2, 4, '수단'], [2, 5, '목표값'],
      [3, 1, '활동'], [3, 2, '가상 사업'], [3, 3, '가상 지표'], [3, 5, '10']],
    [[1, 1, '단계'], [1, 2, '서술'], [1, 3, '지표'], [1, 4, '검증'], [1, 5, '목표'],
      [2, 1, '산출물'], [2, 2, '충분히 긴 가상 사업 설명 문장입니다'], [2, 3, '참여 인원'], [2, 5, '100']],
  ] as const;
  const records = tables.flatMap((rows, table_index) => rows.map(([table_row, table_col, content], i) => ({
    id: `${table_index}-${i}`, document_id: 'sample', sequence_no: i + 1,
    location: '¶1', table_index, table_row, table_col, content,
  })));
  expect(parsePdmParagraphs(records, 'sample').map(item => item.ovi)).toEqual(['가상 지표', '참여 인원']);
  const withUnknownHeader = records.map(p => p.table_index === 0 && p.table_row === 2 && p.table_col === 4 ? { ...p, content: '담당' } : p);
  expect(parsePdmParagraphs(withUnknownHeader, 'sample').map(item => item.ovi)).toEqual(['가상 지표', '참여 인원']);
});

it('중첩 표의 글자를 바깥 칸에 넣고 뒤 칸과 본문 좌표를 유지한다', async () => {
  const JSZip = (await import('jszip')).default;
  const zip = new JSZip();
  zip.file('word/document.xml', `<w:document><w:body>
    <w:tbl><w:tr><w:tc><w:p><w:r><w:t>앞</w:t></w:r></w:p>
      <w:tbl><w:tr><w:tc><w:p><w:r><w:t>안쪽</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
      <w:p><w:r><w:t>뒤</w:t></w:r></w:p></w:tc>
      <w:tc><w:p><w:r><w:t>다음 칸</w:t></w:r></w:p></w:tc></w:tr>
      <w:tr><w:tc><w:p><w:r><w:t>다음 행</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
    <w:p><w:r><w:t>본문</w:t></w:r></w:p></w:body></w:document>`);
  const result = await extractDocx(await zip.generateAsync({ type: 'nodebuffer' }));
  expect(result.paragraphs.map(p => [p.content, p.table_index, p.table_row, p.table_col])).toEqual([
    ['앞안쪽뒤', 0, 1, 1], ['다음 칸', 0, 1, 2], ['다음 행', 0, 2, 1],
    ['본문', undefined, undefined, undefined],
  ]);
});

it('자체 닫힌 빈 본문 문단 뒤의 문단과 표를 읽고 실제 표 너비를 보존한다', async () => {
  const JSZip = (await import('jszip')).default;
  const zip = new JSZip();
  zip.file('word/document.xml', `<w:document><w:body>
    <w:p><w:r><w:t>앞</w:t></w:r></w:p><w:p/><w:p w:rsidR="123"/>
    <w:p><w:r><w:t>뒤</w:t></w:r></w:p>
    <w:tbl><w:tblGrid><w:gridCol/><w:gridCol/><w:gridCol/></w:tblGrid>
    <w:tr><w:tc><w:p><w:r><w:t>칸</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
    <w:tbl><w:tr><w:tc><w:p><w:r><w:t>다음</w:t></w:r></w:p></w:tc><w:tc/></w:tr></w:tbl>
    </w:body></w:document>`);
  const result = await extractDocx(await zip.generateAsync({ type: 'nodebuffer' }));
  expect(result.paragraphs.map(p => [p.content, p.table_cols])).toEqual([
    ['앞', undefined], ['뒤', undefined], ['칸', 3], ['다음', 2],
  ]);
});

it('실제 너비와 긴 머리말, 흔한 자료 낱말, 병합 단계의 표 경계를 구분한다', () => {
  const tables = [
    [[1, 1, '단계'], [1, 2, '서술'], [1, 3, '지표'], [1, 4, '검증'], [1, 5, '목표'],
      [2, 2, '사업명'], [2, 3, '지표명'], [2, 4, '검증수단 및 측정방법 상세설명'], [2, 5, '목표값'],
      [3, 1, '산출물'], [3, 2, '첫 사업'], [3, 3, '첫 지표'],
      [4, 2, '둘째 사업'], [4, 3, '둘째 지표']],
    [[1, 2, '셋째 사업'], [1, 3, '셋째 지표'], [1, 4, '자료']],
    [[1, 1, '단계'], [1, 2, '서술'], [1, 3, '지표'], [1, 4, '검증'], [1, 5, '목표'],
      [2, 1, '계획'], [2, 2, '실적'], [2, 3, '내용'], [2, 4, '항목'], [2, 5, '방법']],
  ] as const;
  const records = tables.flatMap((rows, table_index) => rows.map(([table_row, table_col, content], i) => ({
    id: `${table_index}-${i}`, document_id: 'sample', sequence_no: i + 1,
    location: '¶1', table_index, table_cols: 5, table_row, table_col, content,
  })));
  expect(parsePdmParagraphs(records, 'sample').map(item => [item.level, item.ovi])).toEqual([
    ['산출물', '첫 지표'], ['산출물', '둘째 지표'], ['', '셋째 지표'], ['계획', '내용'],
  ]);
});
