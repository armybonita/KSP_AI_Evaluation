import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { seedDev, SEED_PROJECT_ID } from '../../scripts/seed-dev';
import {
  closeDatabase,
  createConfirmation,
  getBannedSentencesByProject,
  openDatabase,
} from '../../src/server/store';
import { createReportDraft } from '../../src/server/report/service';
import { generateReportDocx } from '../../src/server/report/docx';
import { extractDocx } from '../../src/server/extract';

function checkRequiredEnvironment(): void {
  const requiredKeys = [
    'AIEAS_LLM_BASE_URL',
    // public-safety-allow: checking presence of required env vars for IT
    'AIEAS_LLM_API_KEY',
    'AIEAS_MODEL',
    'AIEAS_REASONING_EFFORT',
  ];

  const missing = requiredKeys.filter((k) => {
    const val = process.env[k];
    return !val || val.trim().length === 0;
  });

  if (missing.length > 0) {
    throw new Error(
      `[IT 환경변수 누락] 필수 환경변수가 설정되지 않았습니다: ${missing.join(', ')}. ` +
        `통합 시험(IT)은 실제 AI 호출을 관통하므로 건너뛰지 않고 즉시 실패합니다.`
    );
  }

  if (process.env.AIEAS_MODEL !== 'aieas-default') {
    throw new Error(
      `[IT 환경변수 오류] AIEAS_MODEL 은 'aieas-default' 이어야 합니다 (현재: '${process.env.AIEAS_MODEL}').`
    );
  }
}

describe('실제 AI 연동 보고서 초안 통합 시험 (IT: RQ-20, RQ-21, RQ-22, D35, FE-11)', () => {
  let tempDbPath: string;
  let db: ReturnType<typeof openDatabase>;

  beforeAll(async () => {
    checkRequiredEnvironment();
    tempDbPath = path.join(
      os.tmpdir(),
      `aieas-report-real-it-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.db`
    );

    // 실제 AI 호출로 시드 생성
    await seedDev({
      fakeAi: false,
      dbPath: tempDbPath,
      projectId: SEED_PROJECT_ID,
    });
    db = openDatabase(tempDbPath);
  });

  afterAll(() => {
    closeDatabase();
    if (tempDbPath && fs.existsSync(tempDbPath)) {
      try {
        fs.unlinkSync(tempDbPath);
      } catch {}
    }
  });

  it('실제 AI 게이트웨이를 호출하여 확정 판단에 대한 성과 분석 초안을 생성하고 Word 로 내보낸다', async () => {
    // ind-activity 확정
    createConfirmation(
      {
        indicator_id: 'ind-activity',
        confirmation_type: '확정',
        confirmer_name: '실제평가자A',
      },
      db
    );

    // 실제 AI 모델 호출을 통한 보고서 초안 생성
    const draft = await createReportDraft(SEED_PROJECT_ID, { db });

    expect(draft.confirmed_count).toBeGreaterThanOrEqual(1);
    expect(draft.sections.achievement_table.rows.length).toBeGreaterThanOrEqual(1);

    // 서술 문장 및 근거 링크 검증
    for (const sent of draft.sections.performance_analysis.sentences) {
      expect(sent.evidence_id).toBeDefined();
      expect(sent.sentence.length).toBeGreaterThan(0);
    }

    // DOCX 파일 생성 및 검증
    const docxBuf = await generateReportDocx(draft);
    expect(docxBuf.length).toBeGreaterThan(0);

    const extracted = await extractDocx(docxBuf);
    expect(extracted.status).toBe('추출 완료');

    const text = extracted.paragraphs.map((p) => p.content).join('\n');
    expect(text).toContain('1. 성과지표 달성표');
    expect(text).toContain('2. 성과 분석');
    expect(text).toContain('3. 기여요인');
    expect(text).toContain('4. 제약요인과 대응');
    expect(text).toContain('5. 교훈');
    expect(text).toContain('6. 모니터링 계획');
    expect(text).toContain('7. 종합평가');

    const bannedSentences = getBannedSentencesByProject(SEED_PROJECT_ID, db).map((s) => s.content);
    for (const forbidden of bannedSentences) {
      expect(text).not.toContain(forbidden);
    }
    expect(text).not.toContain('이름을 밝히지 말아');
  });
});
