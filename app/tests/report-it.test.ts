import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { seedDev, SEED_PROJECT_ID } from '../scripts/seed-dev';
import {
  closeDatabase,
  createConfirmation,
  getBannedSentencesByProject,
  openDatabase,
  saveIndicatorAttribution,
} from '../src/server/store';
import { createReportDraft, isDraftValid } from '../src/server/report/service';
import { generateReportDocx } from '../src/server/report/docx';
import { extractDocx } from '../src/server/extract';
import { setAiClient } from '../src/server/ai';
import { GET as downloadRouteGet } from '../src/app/projects/[projectId]/report/download/route';
import JSZip from 'jszip';

describe('보고서 초안 통합 시험 (IT: RQ-20, RQ-21, RQ-22, D04, D08, D33, D35, FE-11)', () => {
  let tempDbPath: string;

  beforeEach(() => {
    process.env.AIEAS_E2E_FAKE_AI = '1';
    setAiClient(null);
    tempDbPath = path.join(
      os.tmpdir(),
      `aieas-report-it-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.db`
    );
  });

  afterEach(() => {
    delete process.env.AIEAS_E2E_FAKE_AI;
    setAiClient(null);
    closeDatabase();
    if (fs.existsSync(tempDbPath)) {
      try {
        fs.unlinkSync(tempDbPath);
      } catch {}
    }
  });

  it('가짜 AI 시드 환경에서 확정 이력 → 초안 생성 → Word(DOCX) 생성 및 내용 자동 검증', async () => {
    // 1. 결정적 가짜 AI 모드로 전체 7개 지표 시드 초기화
    await seedDev({
      fakeAi: true,
      dbPath: tempDbPath,
      projectId: SEED_PROJECT_ID,
    });
    const db = openDatabase(tempDbPath);

    // 2. 확정 이력 구성 (RQ-20, D04, D33)
    // - ind-activity: '확정' (실현 제안)
    // - ind-shortterm: '수정 후 확정' (추진 중 제안 -> 수정본 기재)
    // - ind-midterm: '확정' (미확인 판정 지표 확정 -> D33 적용)
    // - ind-conflict: '보완 필요' (보고서에서 제외되어야 함)
    // - ind-output: 미확정 (보고서에서 제외되어야 함)
    createConfirmation(
      {
        indicator_id: 'ind-activity',
        confirmation_type: '확정',
        confirmer_name: '평가자A',
      },
      db
    );

    const editedShorttermText = '가입자 100만명 확보를 위해 적극적 홍보를 전개하여 목표에 근접함.';
    createConfirmation(
      {
        indicator_id: 'ind-shortterm',
        confirmation_type: '수정 후 확정',
        confirmer_name: '평가자A',
        edited_text: editedShorttermText,
        reason: '월간 통계 문서 실적 반영',
      },
      db
    );

    createConfirmation(
      {
        indicator_id: 'ind-midterm',
        confirmation_type: '확정',
        confirmer_name: '평가자B',
      },
      db
    );

    createConfirmation(
      {
        indicator_id: 'ind-conflict',
        confirmation_type: '보완 필요',
        confirmer_name: '평가자B',
      },
      db
    );

    // 기여 귀속 입력 (RQ-16, D08)
    const attributionInput = '전산화 기반 구축 및 부처 간 협업 지원에 따른 성과로 평가됨.';
    saveIndicatorAttribution(
      SEED_PROJECT_ID,
      'ind-activity',
      attributionInput,
      db
    );

    // 3. 보고서 초안 생성 (createReportDraft)
    const draft = await createReportDraft(SEED_PROJECT_ID, { db });

    // 4. 초안 구조 단언
    // 대상 건수는 정확히 3건 (ind-activity, ind-shortterm, ind-midterm)
    expect(draft.confirmed_count).toBe(3);

    // 1절: 성과지표 달성표
    const achievementRows = draft.sections.achievement_table.rows;
    expect(achievementRows.length).toBe(3);

    const activityRow = achievementRows.find((r) => r.indicator_id === 'ind-activity');
    expect(activityRow).toBeDefined();
    expect(activityRow?.status_display).toBe('실현');

    const shorttermRow = achievementRows.find((r) => r.indicator_id === 'ind-shortterm');
    expect(shorttermRow).toBeDefined();
    expect(shorttermRow?.status_display).toBe('추진 중');

    // D33 단언: 미확인을 확정한 지표는 달성표에 '근거 미확인'으로만 표기
    const midtermRow = achievementRows.find((r) => r.indicator_id === 'ind-midterm');
    expect(midtermRow).toBeDefined();
    expect(midtermRow?.status_display).toBe('근거 미확인');

    // 보완 필요(ind-conflict) 및 미확정(ind-output)은 달성표에 절대 없음
    expect(achievementRows.some((r) => r.indicator_id === 'ind-conflict')).toBe(false);
    expect(achievementRows.some((r) => r.indicator_id === 'ind-output')).toBe(false);

    // 2절: 성과 분석 서술
    const sentences = draft.sections.performance_analysis.sentences;
    expect(sentences.length).toBeGreaterThanOrEqual(1);

    // D33 단언: '미확인' 확정 지표는 서술 절에 문장이 없음
    expect(sentences.some((s) => s.indicator_id === 'ind-midterm')).toBe(false);

    // 서술 문장마다 유효한 근거 ID 가 부착되어 있어야 함 (RQ-21)
    for (const sent of sentences) {
      expect(sent.evidence_id).toBeDefined();
      expect(sent.evidence_id.length).toBeGreaterThan(0);
    }

    // 3절: 기여요인 (기여 귀속 입력 내용 연동, RQ-16, D08)
    expect(draft.sections.contributing_factors.content).toBe(attributionInput);

    // 4~7절: 자료가 없으므로 "확정한 판단이 없습니다" 안내
    expect(draft.sections.constraints_and_responses.empty_message).toBe('확정한 판단이 없습니다');
    expect(draft.sections.lessons_learned.empty_message).toBe('확정한 판단이 없습니다');
    expect(draft.sections.monitoring_plan.empty_message).toBe('확정한 판단이 없습니다');
    expect(draft.sections.overall_evaluation.empty_message).toBe('확정한 판단이 없습니다');

    // 5. Word DOCX 생성 및 extractDocx 검증 (RQ-22)
    const docxBuffer = await generateReportDocx(draft);
    expect(docxBuffer).toBeDefined();
    expect(docxBuffer.length).toBeGreaterThan(0);

    const extracted = await extractDocx(docxBuffer);
    expect(extracted.status).toBe('추출 완료');

    const fullDocxText = extracted.paragraphs.map((p) => p.content).join('\n');

    // 새 초안은 KSP 목차를 Word에 같은 순서로 출력한다.
    expect(draft.version).toBe(2);
    expect(draft.summary_format).toBe(1);
    expect(draft.template).toBe('ksp');
    const headings = ['1. 사업 개요', '2. 종료평가 종합 결과', '성과지표', '사업성과 평가', '기여요인', '제약요인', '대응 노력과 교훈', '성과 모니터링 계획', '4) 총평', '3. PDM에 따른 성과관리 현황', '4. 중간평가'];
    let previous = -1;
    for (const heading of headings) {
      const index = fullDocxText.indexOf(heading, previous + 1);
      expect(index).toBeGreaterThan(previous);
      previous = index;
    }
    const newWord = await JSZip.loadAsync(docxBuffer);
    expect(await newWord.file('word/document.xml')?.async('text')).toContain('w:footnoteReference');
    const wordFootnotes = await newWord.file('word/footnotes.xml')?.async('text');
    const firstFootnote = draft.footnotes?.[0];
    expect(firstFootnote).toBeDefined();
    expect(wordFootnotes).toContain(`[${firstFootnote!.number}] ${firstFootnote!.document_name} · ${firstFootnote!.location}`);

    // 버전 없는 옛 초안은 기존 일곱 절 제목을 유지한다.
    const legacyDraft = { ...draft };
    delete legacyDraft.version;
    delete legacyDraft.template;
    delete legacyDraft.report_sections;
    delete legacyDraft.footnotes;
    const legacyExtraction = await extractDocx(await generateReportDocx(legacyDraft));
    expect(legacyExtraction.status).toBe('추출 완료');
    const legacyDocxText = legacyExtraction.paragraphs.map((p) => p.content).join('\n');
    expect(legacyDocxText).toContain('1. 성과지표 달성표');
    expect(legacyDocxText).toContain('2. 성과 분석');
    expect(legacyDocxText).toContain('3. 기여요인');
    expect(legacyDocxText).toContain('4. 제약요인과 대응');
    expect(legacyDocxText).toContain('5. 교훈');
    expect(legacyDocxText).toContain('6. 모니터링 계획');
    expect(legacyDocxText).toContain('7. 종합평가');

    // 기여 귀속 내용 존재
    expect(fullDocxText).toContain(attributionInput);

    // 보완 필요 지표('대국민 행정 편의 증진') 및 미확정 지표('디지털 행정 기반 구축') 내용 0건 단언 (RQ-20, RQ-22, D04)
    expect(fullDocxText).not.toContain('대국민 행정 편의 증진');
    expect(fullDocxText).not.toContain('디지털 행정 기반 구축');

    // 인용 금지 문장 글자 0건 단언 (RQ-14)
    const bannedSentences = getBannedSentencesByProject(SEED_PROJECT_ID, db).map((s) => s.content);
    for (const forbidden of bannedSentences) {
      expect(fullDocxText).not.toContain(forbidden);
    }
    expect(fullDocxText).not.toContain('이름을 밝히지 말아');
  });

  it('초안 생성 뒤 판단이 바뀌면 오래된 Word 다운로드를 거부한다', async () => {
    // 1. 시드 초기화
    await seedDev({
      fakeAi: true,
      dbPath: tempDbPath,
      projectId: SEED_PROJECT_ID,
    });
    const db = openDatabase(tempDbPath);

    // 2. 활동 지표 '확정' 등록
    createConfirmation(
      {
        indicator_id: 'ind-activity',
        confirmation_type: '확정',
        confirmer_name: '평가자A',
      },
      db
    );

    // 3. 초안 생성
    const draft = await createReportDraft(SEED_PROJECT_ID, { db });
    expect(draft.confirmed_count).toBe(1);

    // 정상 상태에서는 다운로드 성공 (200)
    const normalRes = await downloadRouteGet(
      new Request(`http://localhost/projects/${SEED_PROJECT_ID}/report/download`) as any,
      { params: Promise.resolve({ projectId: SEED_PROJECT_ID }) }
    );
    expect(normalRes.status).toBe(200);

    // 4. 한 판단을 '보완 필요'로 재확정 (추가 전용 이력)
    createConfirmation(
      {
        indicator_id: 'ind-activity',
        confirmation_type: '보완 필요',
        confirmer_name: '평가자A',
        reason: '추가 검증 필요',
      },
      db
    );

    // 저장된 판은 유지되지만 변경된 근거의 Word 출력은 거부한다.
    expect(isDraftValid(draft, SEED_PROJECT_ID, db)).toBe(false);
    const savedRes = await downloadRouteGet(
      new Request(`http://localhost/projects/${SEED_PROJECT_ID}/report/download`) as any,
      { params: Promise.resolve({ projectId: SEED_PROJECT_ID }) }
    );
    expect(savedRes.status).toBe(400);
    expect(await savedRes.text()).toBe('확정 내용이 바뀌었습니다. 초안을 다시 만드세요.');
  });

  it('기여 귀속 수정 뒤에는 오래된 Word 다운로드를 거부한다', async () => {
    openDatabase(tempDbPath);
    await seedDev({
      fakeAi: true,
      dbPath: tempDbPath,
      projectId: SEED_PROJECT_ID,
    });
    const db = openDatabase(tempDbPath);

    createConfirmation(
      {
        indicator_id: 'ind-activity',
        confirmation_type: '확정',
        confirmer_name: '평가자A',
      },
      db
    );
    saveIndicatorAttribution(
      SEED_PROJECT_ID,
      'ind-activity',
      '초기 기여 귀속 내용',
      db
    );

    const draft = await createReportDraft(SEED_PROJECT_ID, { db });
    expect(draft.confirmed_count).toBe(1);

    // 정상 상태에서는 다운로드 성공 (200)
    const normalRes = await downloadRouteGet(
      new Request(`http://localhost/projects/${SEED_PROJECT_ID}/report/download`) as any,
      { params: Promise.resolve({ projectId: SEED_PROJECT_ID }) }
    );
    expect(normalRes.status).toBe(200);

    // 대상 지표의 기여 귀속 수정
    saveIndicatorAttribution(
      SEED_PROJECT_ID,
      'ind-activity',
      '수정된 기여 귀속 내용',
      db
    );

    expect(isDraftValid(draft, SEED_PROJECT_ID, db)).toBe(false);
    const savedRes = await downloadRouteGet(
      new Request(`http://localhost/projects/${SEED_PROJECT_ID}/report/download`) as any,
      { params: Promise.resolve({ projectId: SEED_PROJECT_ID }) }
    );
    expect(savedRes.status).toBe(400);
    expect(await savedRes.text()).toBe('확정 내용이 바뀌었습니다. 초안을 다시 만드세요.');
  });
});


