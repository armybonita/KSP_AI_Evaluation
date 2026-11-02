import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extractDocument } from '../src/server/extract';
import answers from '../fixtures/answers.json';
import {
  createHwp,
  createHwpx,
  LEGACY_HWP_PARAGRAPHS,
} from '../fixtures/build';

type RhwpInit = typeof import('@rhwp/core')['default'];

const fixturesDir = path.resolve(__dirname, '../fixtures');

describe('추출기 단위 시험 (RQ-03, RQ-06)', () => {
  it('실패한 초기화는 재시도하고 성공 뒤에는 다른 WASM 경로로 다시 초기화하지 않는다', async () => {
    const previousWasmPath = process.env.RHWP_WASM_PATH;
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aieas-rhwp-init-'));
    const missingWasmPath = path.join(tempDir, 'missing.wasm');
    const wasmPath = path.resolve(__dirname, '../node_modules/@rhwp/core/rhwp_bg.wasm');
    const alternateWasmPath = path.join(tempDir, 'alternate.wasm');
    const init = vi.fn<RhwpInit>();
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const readFile = vi.spyOn(fs, 'readFileSync');
    const hwpBuffer = fs.readFileSync(path.join(fixturesDir, 'legacy', '09_legacy_minutes.hwp'));

    try {
      fs.copyFileSync(wasmPath, alternateWasmPath);

      vi.resetModules();
      vi.doMock('@rhwp/core', async () => {
        const rhwp = await vi.importActual<typeof import('@rhwp/core')>('@rhwp/core');
        init.mockImplementation(rhwp.default);
        return { ...rhwp, default: init };
      });
      process.env.RHWP_WASM_PATH = wasmPath;

      const { extractHwp: isolatedExtractHwp } = await import('../src/server/extract/hwp');
      const failedOnce = await isolatedExtractHwp(hwpBuffer, {
        wasmPath: missingWasmPath,
      });
      const failedTwice = await isolatedExtractHwp(hwpBuffer, {
        wasmPath: missingWasmPath,
      });

      for (const result of [failedOnce, failedTwice]) {
        expect(result).toEqual({
          status: '읽지 못함',
          paragraphs: [],
          reason: '한글 읽기 엔진을 불러오지 못했습니다(서버 설정 문제).',
        });
        expect(result.reason).not.toBe(
          '한글 문서가 손상되었거나 HWP 형식이 아니라 읽지 못합니다.'
        );
      }
      expect(errorLog).toHaveBeenCalledTimes(2);
      expect(
        readFile.mock.calls.filter(([filePath]) => String(filePath) === missingWasmPath)
      ).toHaveLength(2);

      const recovered = await isolatedExtractHwp(hwpBuffer);
      expect(recovered.status).toBe('추출 완료');
      expect(recovered.paragraphs.map(({ content }) => content)).toContain(
        LEGACY_HWP_PARAGRAPHS[0]
      );

      const reused = await isolatedExtractHwp(hwpBuffer, {
        wasmPath: alternateWasmPath,
      });
      expect(reused).toEqual(recovered);
      expect(init).toHaveBeenCalledTimes(1);
      expect(
        readFile.mock.calls.filter(([filePath]) => String(filePath) === alternateWasmPath)
      ).toHaveLength(0);
    } finally {
      errorLog.mockRestore();
      readFile.mockRestore();
      vi.doUnmock('@rhwp/core');
      vi.resetModules();
      if (previousWasmPath === undefined) delete process.env.RHWP_WASM_PATH;
      else process.env.RHWP_WASM_PATH = previousWasmPath;
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('HWPX 파일에서 알려진 문장이 기대 문단과 위치로 추출된다', async () => {
    const hwpxDoc = answers.documents.find((d) => d.file_name === '01_project_plan.hwpx')!;
    const buf = fs.readFileSync(path.join(fixturesDir, hwpxDoc.file_name));

    const result = await extractDocument(buf, 'hwpx');
    expect(result.status).toBe('추출 완료');
    expect(result.paragraphs.length).toBeGreaterThan(0);

    for (const known of hwpxDoc.known_sentences) {
      const found = result.paragraphs.find((p) => p.content.includes(known.sentence));
      expect(found, `문장 "${known.sentence}" 을 찾지 못했습니다.`).toBeDefined();
      expect(found!.location).toBe(known.expected_location);
      expect(found!.sequence_no).toBe(known.expected_sequence);
    }
  });

  it('DOCX 파일에서 알려진 문장이 기대 문단과 위치로 추출된다', async () => {
    const pdmDoc = answers.documents.find((d) => d.file_name === '02_pdm.docx')!;
    const buf = fs.readFileSync(path.join(fixturesDir, pdmDoc.file_name));

    const result = await extractDocument(buf, 'docx');
    expect(result.status).toBe('추출 완료');
    expect(result.paragraphs.length).toBeGreaterThan(0);

    for (const known of pdmDoc.known_sentences) {
      const found = result.paragraphs.find((p) => p.content.includes(known.sentence));
      expect(found, `문장 "${known.sentence}" 을 찾지 못했습니다.`).toBeDefined();
      expect(found!.location).toBe(known.expected_location);
      expect(found!.sequence_no).toBe(known.expected_sequence);
    }
  });

  it('옛 한글 HWP 파일에서 알려진 문장이 기대 문단과 위치로 추출된다', async () => {
    const buffer = fs.readFileSync(
      path.join(fixturesDir, 'legacy', '09_legacy_minutes.hwp')
    );
    const result = await extractDocument(buffer, 'hwp');

    expect(result.status).toBe('추출 완료');
    expect(result.paragraphs.map((p) => [p.sequence_no, p.location, p.content])).toEqual(
      LEGACY_HWP_PARAGRAPHS.map((content, index) => [index + 1, '¶' + (index + 1), content])
    );
  });

  it('옛 한글 표의 칸 내용은 1부터 시작하는 행·열 좌표로 추출된다', async () => {
    const buffer = fs.readFileSync(
      path.join(fixturesDir, 'legacy', '12_legacy_table.hwp')
    );
    const result = await extractDocument(buffer, 'hwp');
    const resultCell = result.paragraphs.find((p) => p.content === '96명');

    expect(result.status).toBe('추출 완료');
    expect(resultCell).toMatchObject({
      sequence_no: 9,
      location: '¶9',
      table_row: 2,
      table_col: 2,
    });

    const multiParagraphCell = result.paragraphs.find(
      (paragraph) => paragraph.table_row === 2 && paragraph.table_col === 1
    );
    expect(multiParagraphCell?.content).toBe('수료생\n추가 이수 실적은 가상으로 작성됨.');
    expect(multiParagraphCell?.content).not.toContain('수료생추가');
  });

  it('암호 및 손상된 HWP는 이유를 포함한 읽지 못함 결과로 반환된다', async () => {
    const passwordBuffer = fs.readFileSync(
      path.join(fixturesDir, 'legacy', '10_legacy_minutes_password.hwp')
    );
    const corruptBuffer = fs.readFileSync(
      path.join(fixturesDir, 'legacy', '11_legacy_minutes_corrupt.hwp')
    );

    const passwordResult = await extractDocument(passwordBuffer, 'hwp');
    const corruptResult = await extractDocument(corruptBuffer, 'hwp');

    expect(passwordResult).toEqual({
      status: '읽지 못함',
      paragraphs: [],
      reason: '암호가 걸린 한글 문서라 읽지 못합니다. 암호를 풀어 다시 올려 주세요.',
    });
    expect(corruptResult).toEqual({
      status: '읽지 못함',
      paragraphs: [],
      reason: '한글 문서가 손상되었거나 HWP 형식이 아니라 읽지 못합니다.',
    });
  });

  it('옛 워드 DOC 파일에서 다섯 문장이 ¶1부터 ¶5까지 추출된다', async () => {
    const buffer = fs.readFileSync(
      path.join(fixturesDir, 'legacy', '13_legacy_minutes.doc')
    );
    const result = await extractDocument(buffer, 'doc');

    expect(result.status).toBe('추출 완료');
    expect(result.paragraphs.map((p) => [p.location, p.content])).toEqual([
      ['¶1', '가상 사업 옛 워드 회의록 (지어낸 자료)'],
      ['¶2', '회의 일시: 가상 2차연도 3분기 정기 점검 회의.'],
      ['¶3', '현지 교육 과정 수료생은 목표 120명 가운데 96명으로 집계되었다.'],
      ['¶4', '교육 만족도 조사는 다음 분기에 실시할 예정이다.'],
      ['¶5', '장비 지원 품목 가운데 노트북 40대는 현지에 도착하였다.'],
    ]);
  });

  it('같은 문단 목록을 만든 HWP와 HWPX의 추출 내용·위치 순서가 같다', async () => {
    const [hwpBuffer, hwpxBuffer] = await Promise.all([
      createHwp(LEGACY_HWP_PARAGRAPHS),
      createHwpx(LEGACY_HWP_PARAGRAPHS),
    ]);
    const [hwpResult, hwpxResult] = await Promise.all([
      extractDocument(hwpBuffer, 'hwp'),
      extractDocument(hwpxBuffer, 'hwpx'),
    ]);

    expect(hwpResult.paragraphs.map(({ content, location }) => [content, location])).toEqual(
      hwpxResult.paragraphs.map(({ content, location }) => [content, location])
    );
  });

  it('올리기 화면에서 다섯 지원 형식이 accept 값과 안내 문구에 표시된다', () => {
    const uiSource = fs.readFileSync(
      path.resolve(
        __dirname,
        '../src/app/projects/[projectId]/documents/documents-client-view.tsx'
      ),
      'utf8'
    );

    expect(uiSource).toContain('accept=".hwp,.hwpx,.pdf,.doc,.docx"');
    expect(uiSource).toContain('HWP · HWPX · PDF · DOC · DOCX');
    expect(uiSource).toContain('data-testid="read-failures-section"');
    expect(uiSource).toContain('읽지 못함: {failure.reason}');
  });

  it('PDF 파일에서 쪽 번호와 문단 번호가 유지되며 알려진 문장이 기대 위치로 추출된다', async () => {
    const tripDoc = answers.documents.find((d) => d.file_name === '03_trip_report.pdf')!;
    const buf = fs.readFileSync(path.join(fixturesDir, tripDoc.file_name));

    const result = await extractDocument(buf, 'pdf');
    expect(result.status).toBe('추출 완료');
    expect(result.paragraphs.length).toBeGreaterThan(0);

    for (const known of tripDoc.known_sentences) {
      const found = result.paragraphs.find((p) => p.content.includes(known.sentence));
      expect(found, `문장 "${known.sentence}" 을 찾지 못했습니다.`).toBeDefined();
      expect(found!.location).toBe(known.expected_location);
      expect(found!.sequence_no).toBe(known.expected_sequence);
    }
  });

  it('PDF에서 여러 줄로 감긴 문단이 분리되지 않고 하나의 N쪽 ¶M 문단으로 추출된다', async () => {
    const tripDoc = answers.documents.find((d) => d.file_name === '03_trip_report.pdf')!;
    const buf = fs.readFileSync(path.join(fixturesDir, tripDoc.file_name));

    const result = await extractDocument(buf, 'pdf');
    expect(result.status).toBe('추출 완료');

    // 2쪽 3번째 문단이 두 줄이 합쳐진 단일 문단인지 확인
    const wrappedPara = result.paragraphs.find((p) => p.location === '2쪽 ¶3');
    expect(wrappedPara).toBeDefined();
    expect(wrappedPara!.content).toContain('면담에 참여한 현지 실무관은 이름을 밝히지 말아 달라고 요청하며');
    expect(wrappedPara!.content).toContain('초기 시스템 도입 과정에서 부서 간 이견이 상당했다고 진술함.');
  });

  it('텍스트가 없는 파일은 읽지 못함 상태로 반환된다 (RQ-06)', async () => {
    const emptyDoc = answers.documents.find((d) => d.file_name === '07_empty.pdf')!;
    const buf = fs.readFileSync(path.join(fixturesDir, emptyDoc.file_name));

    const result = await extractDocument(buf, 'pdf');
    expect(result.status).toBe('읽지 못함');
    expect(result.paragraphs.length).toBe(0);
  });

  it('지원하지 않는 형식은 오류를 던진다', async () => {
    await expect(extractDocument(Buffer.from('test'), 'xyz')).rejects.toThrow(
      '지원하지 않는 문서 형식입니다'
    );
  });
});
