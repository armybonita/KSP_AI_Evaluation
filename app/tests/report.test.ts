import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import * as store from '../src/server/store';
import {
  createReportDraft,
  filterReportTargetsForAi,
  getSavedReportDraft,
} from '../src/server/report/service';
import { defaultReportTemplate, prepareTemplate } from '../src/server/report/templates';
import { generateReportDocx } from '../src/server/report/docx';
import { extractDocx } from '../src/server/extract';
import { AiClient, createE2EFakeAiClient } from '../src/server/ai';
import JSZip from 'jszip';
import {
  computeReportFingerprint,
  computeJudgmentFingerprint,
  isDraftValid,
} from '../src/server/report/service';

describe('보고서 초안 및 Word 생성 단위 시험 (RQ-20, RQ-21, RQ-22, D04, D08, D33, D35, FE-11)', () => {
  let tempDbPath: string;
  let db: ReturnType<typeof store.openDatabase>;
  const PROJECT_ID = 'proj-test-report';

  const insertEvidenceParagraphs = (items: Array<{ id: string; document_id: string; location: string; content: string; sequence_no?: number }>) => {
    store.insertParagraphs(items.map((item, index) => ({ ...item, sequence_no: item.sequence_no ?? index + 1 })), db);
  };

  beforeEach(() => {
    tempDbPath = path.join(
      os.tmpdir(),
      `aieas-report-test-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.db`
    );
    db = store.openDatabase(tempDbPath);

    store.createProject(
      {
        id: PROJECT_ID,
        name: '가상국 디지털 행정 평가 사업',
        created_at: new Date().toISOString(),
      },
      db
    );
  });

  afterEach(() => {
    store.closeDatabase();
    if (fs.existsSync(tempDbPath)) {
      try {
        fs.unlinkSync(tempDbPath);
      } catch {}
    }
  });

  it('출처 없는 확정 지표는 보고서 AI 입력에서 제외한다', () => {
    const target = {
      indicator: { id: 'no-source', name: '가상 지표' },
      evidences: [],
    } as unknown as Parameters<typeof filterReportTargetsForAi>[0][number];
    const result = filterReportTargetsForAi([target], [], 'solar');
    expect(result.eligibleTargets).toEqual([]);
    expect(result.exclusions).toContainEqual({ subject: '가상 지표', reasons: ['지표 원문 출처 문서 확인 불가'] });
  });

  it('AI에는 검증된 근거만 보내고 검증 통과 근거가 없는 지표는 제외 사유를 저장한다', async () => {
    const docId = 'doc-ai-citations';
    store.createDocument({ id: docId, project_id: PROJECT_ID, file_name: '가상 문서.docx', file_type: 'docx', status: '추출 완료', doc_type: '사업계획서', is_included: 1, excluded_reason: null, masked: true, approved_ai: 'solar', is_past_final_report: false, created_at: new Date().toISOString() }, db);
    insertEvidenceParagraphs([
      { id: 'p-ai-good', document_id: docId, location: '1쪽', content: '유효한 근거 문장입니다.' },
      { id: 'p-ai-banned', document_id: docId, location: '2쪽', content: '인용 금지 근거 문장입니다.' },
      { id: 'p-ai-wrong', document_id: docId, location: '3쪽', content: '원문의 다른 내용입니다.' },
    ]);
    for (const id of ['mixed', 'none']) {
      store.createIndicator({ id, project_id: PROJECT_ID, level: '활동', name: `가상 지표 ${id}`, ovi: '목표', mov: null, target_value: null, source_doc_id: docId, is_baseline: 0, created_at: new Date().toISOString() }, db);
      const suggestionId = `sugg-${id}`;
      const evidences = id === 'mixed' ? [
        { id: 'ev-ai-good', suggestion_id: suggestionId, quote: '유효한 근거 문장입니다.', document_id: docId, location: '1쪽', speaker: '평가자' },
        { id: 'ev-ai-banned', suggestion_id: suggestionId, quote: '인용 금지 근거 문장입니다.', document_id: docId, location: '2쪽', speaker: '평가자', is_citation_banned: 1 },
        { id: 'ev-ai-wrong-mixed', suggestion_id: suggestionId, quote: '원문과 다른 인용', document_id: docId, location: '3쪽', speaker: '평가자' },
      ] : [
        { id: 'ev-ai-wrong-none', suggestion_id: suggestionId, quote: '원문과 다른 인용', document_id: docId, location: '3쪽', speaker: '평가자' },
      ];
      store.saveSuggestion({ id: suggestionId, indicator_id: id, verdict_status: '실현', error_reason: null, proposal_text: '가상 확인', created_at: new Date().toISOString() }, evidences, db);
      store.createConfirmation({ indicator_id: id, confirmation_type: '확정', confirmer_name: '평가자' }, db);
    }
    const client = createE2EFakeAiClient();
    const call = vi.spyOn(client, 'generateReportDraft');
    const draft = await createReportDraft(PROJECT_ID, { db, aiClient: client });
    expect(call).toHaveBeenCalledTimes(1);
    const input = JSON.parse(call.mock.calls[0][0][1].content);
    expect(input.indicators.map((item: { id: string }) => item.id)).toEqual(['mixed']);
    expect(input.indicators[0].evidences.map((item: { id: string }) => item.id)).toEqual(['ev-ai-good']);
    expect(draft.ai_exclusions).toContainEqual({ subject: '가상 지표 none', reasons: ['검증 통과 근거 없음'] });
  });

  it('선택한 KSP·EIPP 서식과 각주를 저장하고 화면과 Word에 같은 절과 스니펫 각주를 표시한다', async () => {
    expect(defaultReportTemplate('가상 KSP 사업')).toBe('ksp');
    expect(defaultReportTemplate('가상 EIPP 사업')).toBe('eipp');
    expect(defaultReportTemplate('가상 사업')).toBe('ksp');
    expect(defaultReportTemplate('KSP EIPP 사업')).toBe('ksp');
    for (const template of ['ksp', 'eipp'] as const) {
      const draft = await createReportDraft(PROJECT_ID, { db, template });
      const persisted = getSavedReportDraft(PROJECT_ID, db);
      expect(persisted?.version).toBe(2);
      expect(persisted?.summary_format).toBe(1);
      expect(persisted?.template).toBe(template);
      expect(persisted?.report_sections).toEqual(draft.report_sections);
      expect(persisted?.footnotes).toEqual([]);
      draft.sections.achievement_table.rows = [{ indicator_id: 'ind-row', indicator_name: '가상 달성 지표', target_value: '1건', status_display: '실현', evidence_id: 'snippet-row', evidence_document_name: '행 원문 문서', evidence_location: '3쪽' }];
      draft.sections.performance_analysis.sentences = [{ indicator_id: 'ind-fixture', indicator_name: '가상 지표', sentence: '가상 성과가 확인됐다.', evidence_id: 'snippet-fixture', evidence_ids: ['snippet-fixture', 'snippet-second'], evidences: [{ id: 'snippet-fixture', quote: '가상 성과', location: '2쪽', speaker: '가상 평가자', document_name: '가상 문서' }, { id: 'snippet-second', quote: '후속 성과', location: '4쪽', speaker: '가상 평가자', document_name: '두 번째 문서' }] }];
      prepareTemplate(draft, template);
      const numberById = new Map(draft.footnotes?.map((note) => [note.evidence_id, note.number]));
      const flatten = (sections: NonNullable<typeof draft.report_sections>): NonNullable<typeof draft.report_sections> => sections.flatMap((section) => [section, ...flatten(section.children ?? [])]);
      const allSections = flatten(draft.report_sections ?? []);
      expect(numberById.get(allSections.flatMap((section) => section.rows ?? []).find((row) => row.indicator_id === 'ind-row')?.evidence_id ?? '')).toBe(1);
      expect(allSections.flatMap((section) => section.sentences ?? []).flatMap((sentence) => sentence.evidence_ids.map((id) => [numberById.get(id), id]))).toEqual([[2, 'snippet-fixture'], [3, 'snippet-second']]);
      expect(draft.footnotes).toEqual([
        { number: 1, evidence_id: 'snippet-row', document_name: '행 원문 문서', location: '3쪽' },
        { number: 2, evidence_id: 'snippet-fixture', document_name: '가상 문서', location: '2쪽' },
        { number: 3, evidence_id: 'snippet-second', document_name: '두 번째 문서', location: '4쪽' },
      ]);
      const word = await JSZip.loadAsync(await generateReportDocx(draft));
      const body = await word.file('word/document.xml')?.async('text');
      const footnotes = await word.file('word/footnotes.xml')?.async('text');
      for (const title of template === 'ksp' ? ['1. 사업 개요', '2. 종료평가 종합 결과', '3. PDM에 따른 성과관리 현황', '4. 중간평가'] : ['2. 사업별 모니터링 및 평가 결과', '1) 사업 개요', '2) 사업의 성과', '3) 종합평가 및 제언']) expect(body).toContain(title);
      expect(body).toContain('가상 성과가 확인됐다.');
      expect(body).toContain('w:footnoteReference');
      const referenceOrder = [...(body ?? '').matchAll(/w:footnoteReference[^>]*w:id="(\d+)"/g)].map((match) => Number(match[1]));
      expect(referenceOrder).toEqual([1, 2, 3]);
      const footnoteEntries = [...(footnotes ?? '').matchAll(/<w:footnote w:id="(\d+)"[\s\S]*?<\/w:footnote>/g)].map((match) => ({ id: Number(match[1]), xml: match[0] }));
      expect(footnoteEntries.filter((entry) => entry.id > 0).map((entry) => entry.id)).toEqual([1, 2, 3]);
      expect(footnoteEntries.find((entry) => entry.id === 1)?.xml).toContain('[1] 행 원문 문서 · 3쪽');
      expect(footnoteEntries.find((entry) => entry.id === 2)?.xml).toContain('[2] 가상 문서 · 2쪽');
      expect(footnoteEntries.find((entry) => entry.id === 3)?.xml).toContain('[3] 두 번째 문서 · 4쪽');
      expect(footnotes).toContain('가상 문서');
    }
  });

  it('저장 플래그와 사업 금지문 8자 대조에 걸린 스니펫은 각주와 문장 연결에서 제외한다', () => {
    const draft = {
      project_id: PROJECT_ID,
      project_name: '가상 사업',
      confirmed_count: 1,
      created_at: new Date().toISOString(),
      sections: {
        achievement_table: { title: '성과지표 달성표' as const, rows: [{ indicator_id: 'ind-row-ban', indicator_name: '가상 지표', target_value: '1건', status_display: '실현', evidence_id: 'ev-banned-flag' }] },
        performance_analysis: { title: '성과 분석' as const, sentences: [{
          indicator_id: 'ind-banned', indicator_name: '가상 지표', sentence: '가상 서술',
          evidence_id: 'ev-banned-flag', evidence_ids: ['ev-banned-flag', 'ev-banned-overlap'],
          evidences: [
            { id: 'ev-banned-flag', quote: '인용 금지 문장 있음', location: '2쪽', speaker: '—', is_citation_banned: 1 },
            { id: 'ev-banned-overlap', quote: '부서 간 이견이 상당했다고 함', location: '3쪽', speaker: '가상 평가자' },
          ],
        }] },
        contributing_factors: { title: '기여요인' as const, sentences: [] },
        constraints_and_responses: { title: '제약요인과 대응' as const },
        lessons_learned: { title: '교훈' as const },
        monitoring_plan: { title: '모니터링 계획' as const },
        overall_evaluation: { title: '종합평가' as const },
      },
    };
    prepareTemplate(draft, 'ksp', ['초기 시스템 도입 과정에서 부서 간 이견이 상당했다고 진술함']);
    expect(draft.sections.performance_analysis.sentences[0].evidence_ids).toEqual([]);
    expect(draft.sections.performance_analysis.sentences[0].evidence_id).toBeUndefined();
    expect(draft.sections.achievement_table.rows[0].evidence_id).toBeUndefined();
    expect((draft as any).footnotes).toEqual([]);
  });

  it('원문 대조에 통과한 근거만 문장과 Word 각주에 연결하고 실패·미확인 사유를 표시한다', async () => {
    const docId = 'doc-quote-match';
    const indId = 'ind-quote-match';
    store.createDocument({ id: docId, project_id: PROJECT_ID, file_name: '가상 대조 문서.docx', file_type: 'docx', status: '추출 완료', doc_type: '사업계획서', is_included: 1, excluded_reason: null, is_past_final_report: false, created_at: new Date().toISOString() }, db);
    store.insertParagraphs([
      { id: 'p-quote-mismatch', document_id: docId, sequence_no: 1, location: '1쪽', content: '원문에는 다른 실적 내용만 적혀 있다.' },
    ], db);
    store.createIndicator({ id: indId, project_id: PROJECT_ID, level: '활동', name: '원문 대조 지표', ovi: '100건', mov: null, target_value: '100건', is_baseline: 0, created_at: new Date().toISOString() }, db);
    store.saveSuggestion({ id: 'sugg-quote-match', indicator_id: indId, verdict_status: '실현', error_reason: null, proposal_text: '100건 달성', created_at: new Date().toISOString() }, [
      { id: 'ev-quote-mismatch', suggestion_id: 'sugg-quote-match', quote: '100건 달성 근거', document_id: docId, location: '1쪽', speaker: '가상 작성자' },
      { id: 'ev-quote-unavailable', suggestion_id: 'sugg-quote-match', quote: '100건 추가 근거', document_id: docId, location: '2쪽', speaker: '가상 작성자' },
    ], db);
    store.createConfirmation({ indicator_id: indId, confirmation_type: '수정 후 확정', confirmer_name: '가상 평가자', edited_text: '사업 목표를 달성하였다.', reason: '원문 대조 표시 시험' }, db);

    const draft = await createReportDraft(PROJECT_ID, { db });
    expect(draft.fingerprint_version).toBe(4);
    expect(isDraftValid(draft, PROJECT_ID, db)).toBe(true);
    const row = draft.sections.achievement_table.rows.find((item) => item.indicator_id === indId);
    const sentence = draft.sections.performance_analysis.sentences.find((item) => item.indicator_id === indId);
    expect(row?.evidence_id).toBeUndefined();
    expect(row?.evidence_match_warning).toContain('원문 대조 실패');
    expect(row?.evidence_match_warning).toContain('원문 문단 미확인');
    expect(sentence?.evidence_ids).toEqual([]);
    expect(sentence?.evidence_match_warning).toContain('원문 대조 실패');
    expect(draft.footnotes?.some((note) => note.evidence_id === 'ev-quote-mismatch' || note.evidence_id === 'ev-quote-unavailable')).toBe(false);

    const word = await JSZip.loadAsync(await generateReportDocx(draft));
    const body = await word.file('word/document.xml')?.async('text');
    expect(body).toContain('원문 대조 실패: 인용문이 원문 문단과 일치하지 않아 근거를 인용에서 제외했습니다.');
    expect(body).toContain('원문 문단 미확인으로 근거를 인용에서 제외했습니다.');
    expect(body).not.toContain('w:footnoteReference');
    db.prepare('UPDATE paragraphs SET content = ? WHERE id = ?').run('원문 문단이 검토 뒤 변경되었다.', 'p-quote-mismatch');
    expect(isDraftValid(draft, PROJECT_ID, db)).toBe(false);
  });

  it('인용된 원문 문단이 바뀌면 저장 후 다시 읽은 초안의 지문이 무효화된다', async () => {
    const docId = 'doc-fingerprint-cited';
    const indicatorId = 'ind-fingerprint-cited';
    const quote = '가상 사업에서 교육생 40명이 과정을 수료했다.';
    store.createDocument({ id: docId, project_id: PROJECT_ID, file_name: '가상 지문 문서.docx', file_type: 'docx', status: '추출 완료', doc_type: '사업계획서', is_included: 1, excluded_reason: null, is_past_final_report: false, created_at: new Date().toISOString() }, db);
    store.insertParagraphs([{ id: 'p-fingerprint-cited', document_id: docId, sequence_no: 1, location: '1쪽', content: quote }], db);
    store.createIndicator({ id: indicatorId, project_id: PROJECT_ID, level: '활동', name: '가상 인용 지문 지표', ovi: '40명', mov: null, target_value: '40명', is_baseline: 0, created_at: new Date().toISOString() }, db);
    store.saveSuggestion({ id: 'sugg-fingerprint-cited', indicator_id: indicatorId, verdict_status: '실현', error_reason: null, proposal_text: quote, created_at: new Date().toISOString() }, [
      { id: 'ev-fingerprint-cited', suggestion_id: 'sugg-fingerprint-cited', quote, document_id: docId, location: '1쪽', speaker: '가상 작성자' },
    ], db);
    store.createConfirmation({ indicator_id: indicatorId, confirmation_type: '수정 후 확정', confirmer_name: '가상 평가자', edited_text: '교육생 40명이 과정을 수료했다.', reason: '가상 지문 시험' }, db);

    const created = await createReportDraft(PROJECT_ID, { db });
    expect(created.footnotes?.map((note) => note.evidence_id)).toContain('ev-fingerprint-cited');
    expect(isDraftValid(created, PROJECT_ID, db)).toBe(true);
    const reread = getSavedReportDraft(PROJECT_ID, db);
    expect(reread?.fingerprint_version).toBe(4);
    expect(isDraftValid(reread, PROJECT_ID, db)).toBe(true);
    db.prepare('UPDATE paragraphs SET content = ? WHERE id = ?').run('가상 사업에서 교육생 41명이 과정을 수료했다.', 'p-fingerprint-cited');
    expect(isDraftValid(reread, PROJECT_ID, db)).toBe(false);
  });

  it('초안 저장 뒤 사업 금지문이 등록되면 다시 읽을 때 화면 연결과 Word 각주를 함께 제거한다', async () => {
    const docId = 'doc-ban-after-draft';
    const indId = 'ind-ban-after-draft';
    const quote = '사업담당자는 현장 점검을 진행했다.';
    store.createDocument({ id: docId, project_id: PROJECT_ID, file_name: '가상 사후 금지 문서.docx', file_type: 'docx', status: '추출 완료', doc_type: '사업계획서', is_included: 1, excluded_reason: null, is_past_final_report: false, created_at: new Date().toISOString() }, db);
    store.insertParagraphs([{ id: 'p-ban-after-draft', document_id: docId, sequence_no: 1, location: '1쪽', content: quote }], db);
    store.createIndicator({ id: indId, project_id: PROJECT_ID, level: '활동', name: '사후 금지 지표', ovi: '근거 확인', mov: null, target_value: '확인', is_baseline: 0, created_at: new Date().toISOString() }, db);
    store.saveSuggestion({ id: 'sugg-ban-after-draft', indicator_id: indId, verdict_status: '실현', error_reason: null, proposal_text: '사업 수행 결과 확인', created_at: new Date().toISOString() }, [
      { id: 'ev-ban-after-draft', suggestion_id: 'sugg-ban-after-draft', quote, document_id: docId, location: '1쪽', speaker: '가상 담당자' },
    ], db);
    store.createConfirmation({ indicator_id: indId, confirmation_type: '수정 후 확정', confirmer_name: '가상 평가자', edited_text: '사업 수행 결과를 확인하였다.', reason: '가상 확인' }, db);

    const originalDraft = await createReportDraft(PROJECT_ID, { db });
    expect(originalDraft.footnotes?.map((note) => note.evidence_id)).toContain('ev-ban-after-draft');
    store.insertSentences([{ id: 's-ban-after-draft', document_id: docId, paragraph_id: 'p-ban-after-draft', sequence_no: 1, location: '1쪽', content: '사업담당자는 현장 점검을 진행했다. 인용 금지로 등록된 문장입니다.', is_citation_banned: 1 }], db);

    const sanitized = getSavedReportDraft(PROJECT_ID, db);
    expect(sanitized?.footnotes?.some((note) => note.evidence_id === 'ev-ban-after-draft')).toBe(false);
    // 금지된 근거에 연결된 문장 전체가 저장본 출력에서 사라진다.
    expect(sanitized?.sections.performance_analysis.sentences.some((sentence) => sentence.indicator_id === indId)).toBe(false);
    const allSections = sanitized?.report_sections ?? [];
    const flatten = (sections: typeof allSections): typeof allSections => sections.flatMap((section) => [section, ...flatten(section.children ?? [])]);
    expect(flatten(allSections).flatMap((section) => section.sentences ?? []).some((sentence) => sentence.evidence_ids.includes('ev-ban-after-draft'))).toBe(false);
    const word = await JSZip.loadAsync(await generateReportDocx(sanitized!));
    const body = await word.file('word/document.xml')?.async('text');
    const footnotes = await word.file('word/footnotes.xml')?.async('text');
    expect(body).not.toContain('w:footnoteReference');
    expect(footnotes).not.toContain('ev-ban-after-draft');
  });

  describe('1. 보고서 대상 선별 (getReportTargets, RQ-20, D04, D33)', () => {
    it('확정·수정 후 확정만 대상에 포함하고, 미확정·보완 필요·채택 제외는 배제한다', () => {
      // 1) 지표 5개 생성
      const indConfirmed = 'ind-1-confirmed';
      const indEdited = 'ind-2-edited';
      const indRevising = 'ind-3-revising';
      const indExcluded = 'ind-4-excluded';
      const indUnconfirmed = 'ind-5-unconfirmed';

      const indicators = [
        { id: indConfirmed, name: '확정 지표', level: '활동', ovi: 'OVI-1', target_value: '500명' },
        { id: indEdited, name: '수정 후 확정 지표', level: '단기성과', ovi: 'OVI-2', target_value: '100만명' },
        { id: indRevising, name: '보완 필요 지표', level: '산출물', ovi: 'OVI-3', target_value: '1식' },
        { id: indExcluded, name: '채택 제외 지표', level: '영향', ovi: 'OVI-4', target_value: '3.5점' },
        { id: indUnconfirmed, name: '미확정 지표', level: '중기성과', ovi: 'OVI-5', target_value: '30%' },
      ] as const;

      for (const ind of indicators) {
        store.createIndicator(
          {
            id: ind.id,
            project_id: PROJECT_ID,
            level: ind.level,
            name: ind.name,
            ovi: ind.ovi,
            mov: null,
            target_value: ind.target_value,
            is_baseline: 0,
            created_at: new Date().toISOString(),
          },
          db
        );

        // 제안 생성
        store.saveSuggestion(
          {
            id: `sugg-${ind.id}`,
            indicator_id: ind.id,
            verdict_status: '실현',
            error_reason: null,
            proposal_text: `${ind.name}에 대한 제안 문장`,
            created_at: new Date().toISOString(),
          },
          [],
          db
        );
      }

      // 확정 등록
      store.createConfirmation(
        {
          indicator_id: indConfirmed,
          confirmation_type: '확정',
          confirmer_name: '평가자A',
        },
        db
      );

      const editedText = '현장 실적 검증에 따른 수정본 문장';
      store.createConfirmation(
        {
          indicator_id: indEdited,
          confirmation_type: '수정 후 확정',
          confirmer_name: '평가자A',
          edited_text: editedText,
          reason: '실적 문서 확인',
        },
        db
      );

      store.createConfirmation(
        {
          indicator_id: indRevising,
          confirmation_type: '보완 필요',
          confirmer_name: '평가자A',
        },
        db
      );

      store.createConfirmation(
        {
          indicator_id: indExcluded,
          confirmation_type: '채택 제외',
          confirmer_name: '평가자A',
        },
        db
      );

      // indUnconfirmed 는 확정 등록 없음 (미확정)

      // 대상 조회
      const targets = store.getReportTargets(PROJECT_ID, db);

      // 단언: 대상은 정확히 2건 (확정, 수정 후 확정)
      expect(targets.length).toBe(2);

      const ids = targets.map((t) => t.indicator.id);
      expect(ids).toContain(indConfirmed);
      expect(ids).toContain(indEdited);
      expect(ids).not.toContain(indRevising);
      expect(ids).not.toContain(indExcluded);
      expect(ids).not.toContain(indUnconfirmed);

      // 수정 후 확정은 수정본 텍스트를 사용
      const editedTarget = targets.find((t) => t.indicator.id === indEdited);
      expect(editedTarget?.confirmedText).toBe(editedText);
    });

    it('수정 후 확정 지표에 edited_verdict_status 가 있으면 보고서 대상의 verdictStatus 로 채택된다 (#23 결정)', () => {
      const indId = 'ind-edited-verdict-report';
      store.createIndicator(
        {
          id: indId,
          project_id: PROJECT_ID,
          level: '산출물',
          name: '판정 변경 지표',
          ovi: 'OVI',
          mov: null,
          target_value: '1식',
          is_baseline: 0,
          created_at: new Date().toISOString(),
        },
        db
      );

      // AI 제안 판정은 '추진 중'
      store.saveSuggestion(
        {
          id: `sugg-${indId}`,
          indicator_id: indId,
          verdict_status: '추진 중',
          error_reason: null,
          proposal_text: 'AI 추진 중 제안',
          created_at: new Date().toISOString(),
        },
        [],
        db
      );

      // 평가자가 '수정 후 확정'에서 판정을 '실현'으로 변경
      store.createConfirmation(
        {
          indicator_id: indId,
          confirmation_type: '수정 후 확정',
          confirmer_name: '평가자A',
          edited_text: '수정된 실현 내용',
          reason: '실제 검수 완료 확인',
          edited_verdict_status: '실현',
        },
        db
      );

      const targets = store.getReportTargets(PROJECT_ID, db);
      const target = targets.find((t) => t.indicator.id === indId);
      expect(target).toBeDefined();
      expect(target?.verdictStatus).toBe('실현');
      expect(target?.isUnverifiedVerdict).toBe(false);
      expect(target?.confirmedText).toBe('수정된 실현 내용');
    });

    it('확정 뒤 재제안으로 판정이 바뀌어도 S7·보고서·이력 판정이 연결된 제안의 판정으로 일치한다 (#23 검수)', () => {
      store.createDocument(
        {
          id: 'doc-pdm-sync',
          project_id: PROJECT_ID,
          file_name: 'PDM.pdf',
          file_type: 'pdf',
          status: '추출 완료',
          doc_type: '성과관리표',
          is_included: 1,
          excluded_reason: null,
          is_past_final_report: false,
          created_at: new Date().toISOString(),
        },
        db
      );

      const indId = 'ind-resuggest-sync-test';
      store.createIndicator(
        {
          id: indId,
          project_id: PROJECT_ID,
          level: '산출물',
          name: '동기화 검증 지표',
          ovi: 'OVI',
          mov: null,
          target_value: '1식',
          is_baseline: 0,
          created_at: new Date().toISOString(),
        },
        db
      );

      // 1. 초기 제안: '추진 중'
      store.saveSuggestion(
        {
          id: 'sugg-sync-init',
          indicator_id: indId,
          verdict_status: '추진 중',
          error_reason: null,
          proposal_text: '초기 제안 추진 중',
          created_at: new Date().toISOString(),
        },
        [],
        db
      );

      // 2. 확정 (edited_verdict_status 없음)
      store.createConfirmation(
        {
          indicator_id: indId,
          confirmation_type: '확정',
          confirmer_name: '검수자',
        },
        db
      );

      // 3. 확정 뒤 재제안 발생: '실현'으로 판정 변경
      store.saveSuggestion(
        {
          id: 'sugg-sync-resuggest',
          indicator_id: indId,
          verdict_status: '실현',
          error_reason: null,
          proposal_text: '재제안 실현',
          created_at: new Date().toISOString(),
        },
        [],
        db
      );

      // 4. 세 표면(S7 결과 ToC, 보고서 달성표, S5 이력) 조회
      const tocData = store.getResultTocData(PROJECT_ID, db);
      const tocItem = tocData?.items.find((item) => item.indicator.id === indId);

      const reportTargets = store.getReportTargets(PROJECT_ID, db);
      const reportTarget = reportTargets.find((t) => t.indicator.id === indId);

      const history = store.listConfirmations(indId, db);
      const latestHistoryConf = history[history.length - 1];

      // 세 표면의 판정이 모두 연결된 제안('추진 중')으로 같아야 함 (최신 제안 '실현' 사용 금지)
      expect(tocItem?.verdictStatus).toBe('추진 중');
      expect(reportTarget?.verdictStatus).toBe('추진 중');
      expect(latestHistoryConf.ai_verdict_status).toBe('추진 중');
      expect(reportTarget?.verdictStatus).toBe(tocItem?.verdictStatus);
      expect(reportTarget?.verdictStatus).toBe(latestHistoryConf.ai_verdict_status);
    });

    it('재확정 이력이 있는 경우 최신 확정 상태를 따른다 (보완 필요 전환 시 제외, 재확정 시 포함)', () => {
      const indId = 'ind-reconfirm-test';
      store.createIndicator(
        {
          id: indId,
          project_id: PROJECT_ID,
          level: '활동',
          name: '재확정 시험 지표',
          ovi: 'OVI',
          mov: null,
          target_value: '500명',
          is_baseline: 0,
          created_at: new Date().toISOString(),
        },
        db
      );

      store.saveSuggestion(
        {
          id: `sugg-${indId}`,
          indicator_id: indId,
          verdict_status: '실현',
          error_reason: null,
          proposal_text: '초기 제안 문장',
          created_at: new Date().toISOString(),
        },
        [],
        db
      );

      // 1차: 확정
      store.createConfirmation(
        {
          indicator_id: indId,
          confirmation_type: '확정',
          confirmer_name: '평가자A',
        },
        db
      );
      expect(store.getReportTargets(PROJECT_ID, db).length).toBe(1);

      // 2차: 보완 필요로 재확정 -> 제외되어야 함
      store.createConfirmation(
        {
          indicator_id: indId,
          confirmation_type: '보완 필요',
          confirmer_name: '평가자A',
        },
        db
      );
      expect(store.getReportTargets(PROJECT_ID, db).length).toBe(0);

      // 3차: 다시 확정으로 재확정 -> 포함되어야 함
      store.createConfirmation(
        {
          indicator_id: indId,
          confirmation_type: '확정',
          confirmer_name: '평가자B',
        },
        db
      );
      const targets = store.getReportTargets(PROJECT_ID, db);
      expect(targets.length).toBe(1);
      expect(targets[0].indicator.id).toBe(indId);
    });

    it('D33: AI 판정이 "미확인"인 지표를 확정하면 isUnverifiedVerdict 가 true 로 표시된다', () => {
      const indId = 'ind-unverified-confirmed';
      store.createIndicator(
        {
          id: indId,
          project_id: PROJECT_ID,
          level: '중기성과',
          name: '미확인 지표',
          ovi: 'OVI',
          mov: null,
          target_value: '30%',
          is_baseline: 0,
          created_at: new Date().toISOString(),
        },
        db
      );

      store.saveSuggestion(
        {
          id: `sugg-${indId}`,
          indicator_id: indId,
          verdict_status: '미확인',
          error_reason: '근거 부족',
          proposal_text: '근거가 없어 판정을 내릴 수 없음',
          created_at: new Date().toISOString(),
        },
        [],
        db
      );

      store.createConfirmation(
        {
          indicator_id: indId,
          confirmation_type: '확정',
          confirmer_name: '평가자A',
        },
        db
      );

      const targets = store.getReportTargets(PROJECT_ID, db);
      expect(targets.length).toBe(1);
      expect(targets[0].isUnverifiedVerdict).toBe(true);
      expect(targets[0].verdictStatus).toBe('미확인');
    });
  });

  describe('2. 인용 금지 공용 검사 연동 (hasForbiddenSentenceOverlap, isCitationBannedSentence, RQ-14, D01)', () => {
    it('금지 문장 목록과 8자 이상 일치하는 문장을 정확히 검출한다', () => {
      const bannedSentences = [
        '면담에 참여한 현지 실무관은 이름을 밝히지 말아 달라고 요청하며 초기 시스템 도입 과정에서 부서 간 이견이 상당했다고 진술함.',
      ];

      // 8자 일치: "부서 간 이견이 상당했다" (공백 제외 9자 -> 위반)
      const dirtySentence1 = '점검 결과 부서 간 이견이 상당했다고 기록되어 있음.';
      expect(store.hasForbiddenSentenceOverlap(dirtySentence1, bannedSentences, 8)).toBe(true);

      // 키워드 규칙 일치: "이름을 밝히지 말아"
      const dirtySentence2 = '실무관은 이름을 밝히지 말아 달라고 전언함.';
      expect(store.isCitationBannedSentence(dirtySentence2)).toBe(true);

      // 일반 무관 문장 (8자 일치 없음)
      const cleanSentence = '핵심 공무원 500명 이수 완료 달성을 현장에서 확인하였음.';
      expect(store.hasForbiddenSentenceOverlap(cleanSentence, bannedSentences, 8)).toBe(false);
      expect(store.isCitationBannedSentence(cleanSentence)).toBe(false);
    });
  });

  describe('3. 보고서 초안 생성 및 3중 검증 (createReportDraft, D35, D33, RQ-21, RQ-12, RQ-14)', () => {
    it('확정 판단이 없으면 7개 절 모두 "확정한 판단이 없습니다" 안내를 반환한다 (UC-17)', async () => {
      const draft = await createReportDraft(PROJECT_ID, { db });

      expect(draft.confirmed_count).toBe(0);
      expect(draft.sections.achievement_table.rows.length).toBe(0);
      expect(draft.sections.achievement_table.empty_message).toBe('확정한 판단이 없습니다');
      expect(draft.sections.performance_analysis.sentences.length).toBe(0);
      expect(draft.sections.performance_analysis.empty_message).toBe('확정한 판단이 없습니다');
      expect(draft.sections.contributing_factors.empty_message).toBe('확정한 판단이 없습니다');
      expect(draft.sections.constraints_and_responses.empty_message).toBe('확정한 판단이 없습니다');
      expect(draft.sections.lessons_learned.empty_message).toBe('확정한 판단이 없습니다');
      expect(draft.sections.monitoring_plan.empty_message).toBe('확정한 판단이 없습니다');
      expect(draft.sections.overall_evaluation.empty_message).toBe('확정한 판단이 없습니다');
    });

    it('성과지표 달성표(1절)는 규칙으로 조립되고, 미확인 확정은 "근거 미확인"으로만 표기된다 (D35, D33)', async () => {
      // 활동 지표: 실현 확정
      const ind1 = 'ind-act';
      store.createIndicator(
        {
          id: ind1,
          project_id: PROJECT_ID,
          level: '활동',
          name: '디지털 직무 교육',
          ovi: 'OVI',
          mov: null,
          target_value: '500명',
          is_baseline: 0,
          created_at: new Date().toISOString(),
        },
        db
      );
      store.saveSuggestion(
        {
          id: 'sugg-1',
          indicator_id: ind1,
          verdict_status: '실현',
          error_reason: null,
          proposal_text: '핵심 공무원 500명 이수 완료 달성을 현장에서 확인하였음.',
          created_at: new Date().toISOString(),
        },
        [],
        db
      );
      store.createConfirmation(
        {
          indicator_id: ind1,
          confirmation_type: '확정',
          confirmer_name: '평가자A',
        },
        db
      );

      // 중기성과 지표: 미확인 확정 (D33)
      const ind2 = 'ind-mid';
      store.createIndicator(
        {
          id: ind2,
          project_id: PROJECT_ID,
          level: '중기성과',
          name: '행정 효율성 증대',
          ovi: 'OVI',
          mov: null,
          target_value: '30%',
          is_baseline: 0,
          created_at: new Date().toISOString(),
        },
        db
      );
      store.saveSuggestion(
        {
          id: 'sugg-2',
          indicator_id: ind2,
          verdict_status: '미확인',
          error_reason: '근거 없음',
          proposal_text: '근거가 확인되지 않음',
          created_at: new Date().toISOString(),
        },
        [],
        db
      );
      store.createConfirmation(
        {
          indicator_id: ind2,
          confirmation_type: '확정',
          confirmer_name: '평가자A',
        },
        db
      );

      // 목 AI 클라이언트: 서술 문장 빈 배열 반환
      const mockAiClient = new AiClient({
        baseUrl: 'https://example.com/v1',
        // public-safety-allow: mock AI client dummy key
        apiKey: 'dummy',
        model: 'aieas-default',
        reasoningEffort: 'xhigh',
        fetchFn: async () =>
          new Response(
            JSON.stringify({
              choices: [{ message: { content: JSON.stringify({ sentences: [] }) } }],
            })
          ),
      });

      Object.defineProperty(mockAiClient, 'provider', { value: 'solar' });
      const draft = await createReportDraft(PROJECT_ID, { db, aiClient: mockAiClient });

      // 달성표 검증
      expect(draft.confirmed_count).toBe(2);
      const rows = draft.sections.achievement_table.rows;
      expect(rows.length).toBe(2);

      const row1 = rows.find((r) => r.indicator_id === ind1);
      expect(row1?.status_display).toBe('실현');

      const row2 = rows.find((r) => r.indicator_id === ind2);
      // D33 단언: 미확인을 확정한 지표는 달성표에 '근거 미확인'으로 표기
      expect(row2?.status_display).toBe('근거 미확인');

      // D33 단언: 미확인을 확정한 지표는 서술 절에 문장이 없음
      expect(draft.sections.performance_analysis.sentences.length).toBe(0);
    });

    it('근거 링크 없는 문장, 수치 불일치 문장, 인용 금지 문장은 서술(2절)에서 모두 버린다 (D35, RQ-21, RQ-12, RQ-14)', async () => {
      // 문서 및 문단 생성
      store.createDocument(
        {
          id: 'doc-1',
          project_id: PROJECT_ID,
          file_name: '01_plan.docx',
          file_type: 'docx',
          status: '추출 완료',
          doc_type: '사업계획서',
          is_included: 1,
          excluded_reason: null,
          masked: true,
          approved_ai: 'solar',
          is_past_final_report: false,
          created_at: new Date().toISOString(),
        },
        db
      );

      store.insertParagraphs(
        [
          {
            id: 'p-ban-1',
            document_id: 'doc-1',
            sequence_no: 1,
            location: '¶1',
            content:
              '면담에 참여한 현지 실무관은 이름을 밝히지 말아 달라고 요청하며 초기 시스템 도입 과정에서 부서 간 이견이 상당했다고 진술함.',
          },
        ],
        db
      );
      store.insertSentences(
        [
          {
            id: 's-ban-1',
            document_id: 'doc-1',
            paragraph_id: 'p-ban-1',
            sequence_no: 1,
            location: '¶1',
            content:
              '면담에 참여한 현지 실무관은 이름을 밝히지 말아 달라고 요청하며 초기 시스템 도입 과정에서 부서 간 이견이 상당했다고 진술함.',
            is_citation_banned: 1,
          },
        ],
        db
      );

      insertEvidenceParagraphs([{ id: 'p-valid-1', document_id: 'doc-1', sequence_no: 2, location: '¶2', content: '교육 훈련 실적: 핵심 공무원 500명 이수 완료 달성을 확인하였음.' }]);

      const indId = 'ind-multi-check';
      store.createIndicator(
        {
          id: indId,
          source_doc_id: 'doc-1',
          project_id: PROJECT_ID,
          level: '활동',
          name: '직무 교육',
          ovi: 'OVI',
          mov: null,
          target_value: '500명',
          is_baseline: 0,
          created_at: new Date().toISOString(),
        },
        db
      );

      const validEvidenceId = 'ev-valid-1';
      store.saveSuggestion(
        {
          id: 'sugg-check',
          indicator_id: indId,
          verdict_status: '실현',
          error_reason: null,
          proposal_text: '핵심 공무원 500명 이수 완료 달성을 확인하였음.',
          created_at: new Date().toISOString(),
        },
        [
          {
            id: validEvidenceId,
            suggestion_id: 'sugg-check',
            quote: '교육 훈련 실적: 핵심 공무원 500명 이수 완료 달성을 확인하였음.',
            document_id: 'doc-1',
            location: '¶2',
            speaker: '수행기관',
          },
        ],
        db
      );

      store.createConfirmation(
        {
          indicator_id: indId,
          confirmation_type: '확정',
          confirmer_name: '평가자A',
        },
        db
      );

      // AI 가 4개 문장을 반환하도록 목킹:
      // 1. 정상 문장 (유효 근거 ID, 수치 500명 일치, 인용 금지 없음) -> 통과
      // 2. 근거 링크 없는 문장 (evidence_ids 가 빈 배열) -> 버림 (D35)
      // 3. 수치 불일치 문장 (원문에 없는 '800명' 포함) -> 버림 (RQ-12, D03)
      // 4. 인용 금지 문장 (8자 일치 부분 문자열 포함) -> 버림 (RQ-14)
      const aiResponseSentences = [
        {
          indicator_id: indId,
          sentence: '핵심 공무원 500명 이수 완료 달성을 확인하였음.',
          evidence_ids: [validEvidenceId],
        },
        {
          indicator_id: indId,
          sentence: '추가적인 직무 역량 강화를 전반적으로 달성하였음.',
          evidence_ids: [], // 근거 링크 없음
        },
        {
          indicator_id: indId,
          sentence: '교육 참가자는 총 800명에 달하여 초과 달성함.',
          evidence_ids: [validEvidenceId], // 수치 불일치 (800명)
        },
        {
          indicator_id: indId,
          sentence: '사업 추진 과정에서 부서 간 이견이 상당했다고 현장 실무관이 진술함.',
          evidence_ids: [validEvidenceId], // 인용 금지 8자 일치 위반
        },
      ];

      const mockAiClient = new AiClient({
        baseUrl: 'https://example.com/v1',
        // public-safety-allow: mock AI client dummy key
        apiKey: 'dummy',
        model: 'aieas-default',
        reasoningEffort: 'xhigh',
        fetchFn: async () =>
          new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: JSON.stringify({ sentences: aiResponseSentences }),
                  },
                },
              ],
            })
          ),
      });

      Object.defineProperty(mockAiClient, 'provider', { value: 'solar' });
      const draft = await createReportDraft(PROJECT_ID, { db, aiClient: mockAiClient });

      // 단언: 4개 문장 중 정상 문장 1개만 살아남아야 함
      const survivingSentences = draft.sections.performance_analysis.sentences;
      expect(survivingSentences.length).toBe(1);
      expect(survivingSentences[0].sentence).toBe('핵심 공무원 500명 이수 완료 달성을 확인하였음.');
      expect(survivingSentences[0].evidence_id).toBe(validEvidenceId);
    });

    it('기여 귀속 입력이 있으면 3절 기여요인에 반영된다 (RQ-16, D08)', async () => {
      const indId = 'ind-attr';
      store.createIndicator(
        {
          id: indId,
          project_id: PROJECT_ID,
          level: '활동',
          name: '직무 교육',
          ovi: 'OVI',
          mov: null,
          target_value: '500명',
          is_baseline: 0,
          created_at: new Date().toISOString(),
        },
        db
      );
      // 0. 문서 및 근거 생성
      const docId = 'doc-attr-test';
      store.createDocument(
        {
          id: docId,
          project_id: PROJECT_ID,
          file_name: '01_plan.docx',
          file_type: 'docx',
          status: '추출 완료',
          doc_type: '사업계획서',
          is_included: 1,
          excluded_reason: null,
          is_past_final_report: false,
          created_at: new Date().toISOString(),
        },
        db
      );
      insertEvidenceParagraphs([{ id: 'p-attr-test', document_id: docId, location: '1쪽', content: '500명 이수 완료 확인' }]);
      store.saveSuggestion(
        {
          id: 'sugg-attr',
          indicator_id: indId,
          verdict_status: '실현',
          error_reason: null,
          proposal_text: '500명 이수 완료',
          created_at: new Date().toISOString(),
        },
        [
          {
            id: 'ev-attr-1',
            suggestion_id: 'sugg-attr',
            quote: '500명 이수 완료 확인',
            document_id: docId,
            location: '1쪽',
            speaker: '작성자',
          },
        ],
        db
      );
      store.createConfirmation(
        {
          indicator_id: indId,
          confirmation_type: '확정',
          confirmer_name: '평가자A',
        },
        db
      );

      // 기여 귀속 저장 (#20 연계 정본)
      const attributionContent = '본 성과는 전담 자문단의 밀착 교육 제공에 힘입은 바가 큼.';
      store.saveIndicatorAttribution(
        PROJECT_ID,
        indId,
        attributionContent,
        db
      );

      const mockAiClient = new AiClient({
        baseUrl: 'https://example.com/v1',
        // public-safety-allow: mock AI client dummy key
        apiKey: 'dummy',
        model: 'aieas-default',
        reasoningEffort: 'xhigh',
        fetchFn: async () =>
          new Response(
            JSON.stringify({
              choices: [{ message: { content: JSON.stringify({ sentences: [] }) } }],
            })
          ),
      });

      Object.defineProperty(mockAiClient, 'provider', { value: 'solar' });
      const draft = await createReportDraft(PROJECT_ID, { db, aiClient: mockAiClient });

      expect(draft.sections.contributing_factors.content).toBe(attributionContent);
      expect(draft.sections.contributing_factors.empty_message).toBeUndefined();
      expect(draft.sections.contributing_factors.sentences).toBeDefined();
      expect(draft.sections.contributing_factors.sentences![0].evidence_id).toBe('ev-attr-1');
      expect(draft.sections.contributing_factors.sentences![0].evidence_id).not.toBe('');
    });

    it('검증 통과 근거가 없는 지표의 기여 귀속은 3절에서 제외되고 안내 문구가 표시된다 (RQ-21, #22 마지막 검수 Item 2)', async () => {
      const indNoEv = 'ind-attr-no-ev';
      store.createIndicator(
        {
          id: indNoEv,
          project_id: PROJECT_ID,
          level: '산출물',
          name: '근거 없는 지표',
          ovi: 'OVI',
          mov: null,
          target_value: '10개',
          is_baseline: 0,
          created_at: new Date().toISOString(),
        },
        db
      );
      store.saveSuggestion(
        {
          id: 'sugg-attr-no-ev',
          indicator_id: indNoEv,
          verdict_status: '실현',
          error_reason: null,
          proposal_text: '10개 달성',
          created_at: new Date().toISOString(),
        },
        [], // 근거 없음
        db
      );
      store.createConfirmation(
        {
          indicator_id: indNoEv,
          confirmation_type: '확정',
          confirmer_name: '평가자A',
        },
        db
      );
      store.saveIndicatorAttribution(
        PROJECT_ID,
        indNoEv,
        '근거 없는 지표에 대한 기여 귀속 내용입니다.',
        db
      );

      const mockAiClient = new AiClient({
        baseUrl: 'https://example.com/v1',
        // public-safety-allow: mock AI client dummy key
        apiKey: 'dummy',
        model: 'aieas-default',
        reasoningEffort: 'xhigh',
        fetchFn: async () =>
          new Response(
            JSON.stringify({
              choices: [{ message: { content: JSON.stringify({ sentences: [] }) } }],
            })
          ),
      });

      Object.defineProperty(mockAiClient, 'provider', { value: 'solar' });
      const draft = await createReportDraft(PROJECT_ID, { db, aiClient: mockAiClient });

      // 검증 통과 근거가 없으므로 3절 기여요인에서 제외됨 (RQ-21)
      expect(draft.sections.contributing_factors.content).toBeUndefined();
      expect(draft.sections.contributing_factors.sentences ?? []).toHaveLength(0);
      expect(draft.sections.contributing_factors.empty_message).toBe('확정한 판단이 없습니다');
      // S6 안내 문구 및 제외 건수
      expect(draft.sections.contributing_factors.excluded_notice).toBe(
        '근거가 없어 기여요인 절에서 뺀 기여 귀속 1건'
      );
      expect(draft.sections.contributing_factors.excluded_count).toBe(1);
    });

    it('보완 필요 지표의 기여 귀속은 보고서에 없음 (#22, RQ-16, RQ-20, D04)', async () => {
      // 0. 문서 생성
      store.createDocument(
        {
          id: 'doc-1',
          project_id: PROJECT_ID,
          file_name: '01_plan.docx',
          file_type: 'docx',
          status: '추출 완료',
          doc_type: '사업계획서',
          is_included: 1,
          excluded_reason: null,
          is_past_final_report: false,
          created_at: new Date().toISOString(),
        },
        db
      );

      // 1. 확정 지표 ind-attr-confirmed
      insertEvidenceParagraphs([{ id: 'p-attr-confirmed', document_id: 'doc-1', location: '1쪽', content: '근거 원문 내용 100명' }]);
      const indConfirmed = 'ind-attr-confirmed';
      store.createIndicator(
        {
          id: indConfirmed,
          project_id: PROJECT_ID,
          level: '활동',
          name: '확정 지표',
          ovi: 'OVI',
          mov: null,
          target_value: '100명',
          is_baseline: 0,
          created_at: new Date().toISOString(),
        },
        db
      );
      store.saveSuggestion(
        {
          id: 'sugg-attr-conf',
          indicator_id: indConfirmed,
          verdict_status: '실현',
          error_reason: null,
          proposal_text: '100명 달성',
          created_at: new Date().toISOString(),
        },
        [
          {
            id: 'ev-attr-conf-1',
            suggestion_id: 'sugg-attr-conf',
            quote: '근거 원문 내용 100명',
            document_id: 'doc-1',
            location: '1쪽',
            speaker: '담당자',
          },
        ],
        db
      );
      store.createConfirmation(
        {
          indicator_id: indConfirmed,
          confirmation_type: '확정',
          confirmer_name: '평가자A',
        },
        db
      );
      store.saveIndicatorAttribution(
        PROJECT_ID,
        indConfirmed,
        '확정 지표에 대한 정상 기여 귀속 서술입니다.',
        db
      );

      // 2. 보완 필요 지표 ind-attr-revising
      const indRevising = 'ind-attr-revising';
      store.createIndicator(
        {
          id: indRevising,
          project_id: PROJECT_ID,
          level: '산출물',
          name: '보완 필요 지표',
          ovi: 'OVI',
          mov: null,
          target_value: '50개',
          is_baseline: 0,
          created_at: new Date().toISOString(),
        },
        db
      );
      store.saveSuggestion(
        {
          id: 'sugg-attr-rev',
          indicator_id: indRevising,
          verdict_status: '추진 중',
          error_reason: null,
          proposal_text: '50개 추진',
          created_at: new Date().toISOString(),
        },
        [],
        db
      );
      store.createConfirmation(
        {
          indicator_id: indRevising,
          confirmation_type: '보완 필요',
          confirmer_name: '평가자B',
        },
        db
      );
      const revisingAttributionText = '보완 필요 지표에 대한 기여 귀속 서술입니다.';
      store.saveIndicatorAttribution(
        PROJECT_ID,
        indRevising,
        revisingAttributionText,
        db
      );

      const mockAiClient = new AiClient({
        baseUrl: 'https://example.com/v1',
        // public-safety-allow: mock AI client dummy key
        apiKey: 'dummy',
        model: 'aieas-default',
        reasoningEffort: 'xhigh',
        fetchFn: async () =>
          new Response(
            JSON.stringify({
              choices: [{ message: { content: JSON.stringify({ sentences: [] }) } }],
            })
          ),
      });

      Object.defineProperty(mockAiClient, 'provider', { value: 'solar' });
      const draft = await createReportDraft(PROJECT_ID, { db, aiClient: mockAiClient });

      // 단언 1: 보완 필요 지표의 기여 귀속은 보고서에 없음
      expect(draft.sections.contributing_factors.content).not.toContain(revisingAttributionText);
      const contributingSentences = draft.sections.contributing_factors.sentences ?? [];
      expect(
        contributingSentences.some((s) => s.indicator_id === indRevising)
      ).toBe(false);

      // 단언 2: 확정 지표의 기여 귀속은 정상 반영되고 근거 링크가 달림
      expect(draft.sections.contributing_factors.content).toContain('확정 지표에 대한 정상 기여 귀속 서술입니다.');
      const confirmedSentence = contributingSentences.find(
        (s) => s.indicator_id === indConfirmed
      );
      expect(confirmedSentence).toBeDefined();
      expect(confirmedSentence?.evidence_ids).toEqual(['ev-attr-conf-1']);
    });

    it('금지 문장과 겹치는 기여 귀속은 빠짐 (#22, RQ-14, RQ-16, D01, D08)', async () => {
      // 1. 금지 문장을 포함하는 문서 생성
      const forbiddenSentence =
        '면담에 참여한 현지 실무관은 이름을 밝히지 말아 달라고 요청하며 초기 시스템 도입 과정에서 부서 간 이견이 상당했다고 진술함.';
      store.createDocument(
        {
          id: 'doc-ban-proj-test',
          project_id: PROJECT_ID,
          file_name: 'ban_test.docx',
          file_type: 'docx',
          status: '추출 완료',
          doc_type: '사업계획서',
          is_included: 1,
          excluded_reason: null,
          is_past_final_report: false,
          created_at: new Date().toISOString(),
        },
        db
      );
      store.insertParagraphs(
        [
          {
            id: 'p-ban-proj-t1',
            document_id: 'doc-ban-proj-test',
            sequence_no: 1,
            location: '1쪽',
            content: forbiddenSentence,
          },
        ],
        db
      );
      store.insertSentences(
        [
          {
            id: 's-ban-proj-t1',
            document_id: 'doc-ban-proj-test',
            paragraph_id: 'p-ban-proj-t1',
            sequence_no: 1,
            location: '1쪽',
            content: forbiddenSentence,
            is_citation_banned: 1,
          },
        ],
        db
      );

      insertEvidenceParagraphs([
        { id: 'p-ban-proj-clean', document_id: 'doc-ban-proj-test', sequence_no: 2, location: '2쪽', content: '참가자 200명 완료' },
        { id: 'p-ban-proj-overlap', document_id: 'doc-ban-proj-test', sequence_no: 3, location: '3쪽', content: '10건 실현 완료 근거 원문' },
      ]);

      // 2. 정상 확정 지표 1: 정상 기여 귀속
      const indClean = 'ind-attr-clean-test';
      store.createIndicator(
        {
          id: indClean,
          project_id: PROJECT_ID,
          level: '활동',
          name: '정상 확정 지표',
          ovi: 'OVI',
          mov: null,
          target_value: '200명',
          is_baseline: 0,
          created_at: new Date().toISOString(),
        },
        db
      );
      store.saveSuggestion(
        {
          id: 'sugg-attr-clean-t',
          indicator_id: indClean,
          verdict_status: '실현',
          error_reason: null,
          proposal_text: '200명 달성 완료',
          created_at: new Date().toISOString(),
        },
        [
          {
            id: 'ev-attr-clean-t1',
            suggestion_id: 'sugg-attr-clean-t',
            quote: '참가자 200명 완료',
            document_id: 'doc-ban-proj-test',
            location: '2쪽',
            speaker: '수행기관',
          },
        ],
        db
      );
      store.createConfirmation(
        {
          indicator_id: indClean,
          confirmation_type: '확정',
          confirmer_name: '평가자A',
        },
        db
      );
      const cleanAttribution = '현지 자문단의 성실한 지원으로 성공적으로 추진됨.';
      store.saveIndicatorAttribution(PROJECT_ID, indClean, cleanAttribution, db);

      // 3. 정상 확정 지표 2: 금지 문장과 8자 이상 겹치는 기여 귀속
      const indOverlap = 'ind-attr-overlap-test';
      store.createIndicator(
        {
          id: indOverlap,
          project_id: PROJECT_ID,
          level: '단기성과',
          name: '겹침 지표',
          ovi: 'OVI',
          mov: null,
          target_value: '10건',
          is_baseline: 0,
          created_at: new Date().toISOString(),
        },
        db
      );
      store.saveSuggestion(
        {
          id: 'sugg-attr-overlap-t',
          indicator_id: indOverlap,
          verdict_status: '실현',
          error_reason: null,
          proposal_text: '10건 실현 완료',
          created_at: new Date().toISOString(),
        },
        [
          {
            id: 'ev-attr-overlap-t1',
            suggestion_id: 'sugg-attr-overlap-t',
            quote: '10건 실현 완료 근거 원문',
            document_id: 'doc-ban-proj-test',
            location: '3쪽',
            speaker: '수행기관',
          },
        ],
        db
      );
      store.createConfirmation(
        {
          indicator_id: indOverlap,
          confirmation_type: '확정',
          confirmer_name: '평가자A',
        },
        db
      );
      // 8자 겹침: "부서 간 이견이 상당했다"
      const overlapAttribution = '초기 시스템 도입 과정에서 부서 간 이견이 상당했다고 평가됨.';
      store.saveIndicatorAttribution(PROJECT_ID, indOverlap, overlapAttribution, db);

      const mockAiClient = new AiClient({
        baseUrl: 'https://example.com/v1',
        // public-safety-allow: mock AI client dummy key
        apiKey: 'dummy',
        model: 'aieas-default',
        reasoningEffort: 'xhigh',
        fetchFn: async () =>
          new Response(
            JSON.stringify({
              choices: [{ message: { content: JSON.stringify({ sentences: [] }) } }],
            })
          ),
      });

      Object.defineProperty(mockAiClient, 'provider', { value: 'solar' });
      const draft = await createReportDraft(PROJECT_ID, { db, aiClient: mockAiClient });

      // 단언 1: 금지 문장과 겹치는 기여 귀속은 빠짐
      expect(draft.sections.contributing_factors.content).not.toContain(overlapAttribution);
      const contributingSentences = draft.sections.contributing_factors.sentences ?? [];
      expect(
        contributingSentences.some((s) => s.indicator_id === indOverlap)
      ).toBe(false);

      // 단언 2: 정상 기여 귀속은 포함됨
      expect(draft.sections.contributing_factors.content).toContain(cleanAttribution);
      expect(
        contributingSentences.some((s) => s.indicator_id === indClean)
      ).toBe(true);
    });
  });

  describe('4. Word DOCX 생성 및 다시 열어 검증 (generateReportDocx, extractDocx, RQ-22)', () => {
    it('DOCX 생성 후 다시 열었을 때 일곱 절이 존재하고, 미확정·보완 필요·채택 제외 및 인용 금지 글자가 0건이다', async () => {
      store.createDocument(
        {
          id: 'doc-1',
          project_id: PROJECT_ID,
          file_name: '01_plan.docx',
          file_type: 'docx',
          status: '추출 완료',
          doc_type: '사업계획서',
          is_included: 1,
          excluded_reason: null,
          masked: true,
          approved_ai: 'solar',
          is_past_final_report: false,
          created_at: new Date().toISOString(),
        },
        db
      );

      insertEvidenceParagraphs([{ id: 'p-docx-valid', document_id: 'doc-1', location: '¶2', content: '교육 훈련 실적: 핵심 공무원 500명 이수 완료 달성을 확인하였음.' }]);

      // 확정 1건, 보완 필요 1건, 채택 제외 1건, 미확정 1건 구성
      store.createIndicator(
        {
          id: 'ind-valid',
          source_doc_id: 'doc-1',
          project_id: PROJECT_ID,
          level: '활동',
          name: '정상 확정 지표',
          ovi: 'OVI',
          mov: null,
          target_value: '500명',
          is_baseline: 0,
          created_at: new Date().toISOString(),
        },
        db
      );
      store.saveSuggestion(
        {
          id: 'sugg-valid',
          indicator_id: 'ind-valid',
          verdict_status: '실현',
          error_reason: null,
          proposal_text: '핵심 공무원 500명 이수 완료 달성을 확인하였음.',
          created_at: new Date().toISOString(),
        },
        [
          {
            id: 'ev-1',
            suggestion_id: 'sugg-valid',
            quote: '교육 훈련 실적: 핵심 공무원 500명 이수 완료 달성을 확인하였음.',
            document_id: 'doc-1',
            location: '¶2',
            speaker: '수행기관',
          },
        ],
        db
      );
      store.createConfirmation(
        {
          indicator_id: 'ind-valid',
          confirmation_type: '확정',
          confirmer_name: '평가자A',
        },
        db
      );

      // 보완 필요 지표 (보고서에 절대 포함되지 않아야 함)
      store.createIndicator(
        {
          id: 'ind-revising-trap',
          project_id: PROJECT_ID,
          level: '산출물',
          name: '보완 필요 금지 지표',
          ovi: 'OVI',
          mov: null,
          target_value: '100개',
          is_baseline: 0,
          created_at: new Date().toISOString(),
        },
        db
      );
      store.saveSuggestion(
        {
          id: 'sugg-revising',
          indicator_id: 'ind-revising-trap',
          verdict_status: '실현',
          error_reason: null,
          proposal_text: '보완 필요 금지 문장 내용 100개',
          created_at: new Date().toISOString(),
        },
        [],
        db
      );
      store.createConfirmation(
        {
          indicator_id: 'ind-revising-trap',
          confirmation_type: '보완 필요',
          confirmer_name: '평가자A',
        },
        db
      );

      // 채택 제외 지표 (보고서에 절대 포함되지 않아야 함)
      store.createIndicator(
        {
          id: 'ind-excluded-trap',
          project_id: PROJECT_ID,
          level: '영향',
          name: '채택 제외 금지 지표',
          ovi: 'OVI',
          mov: null,
          target_value: '10점',
          is_baseline: 0,
          created_at: new Date().toISOString(),
        },
        db
      );
      store.saveSuggestion(
        {
          id: 'sugg-excluded',
          indicator_id: 'ind-excluded-trap',
          verdict_status: '기대',
          error_reason: null,
          proposal_text: '채택 제외 금지 문장 내용 10점',
          created_at: new Date().toISOString(),
        },
        [],
        db
      );
      store.createConfirmation(
        {
          indicator_id: 'ind-excluded-trap',
          confirmation_type: '채택 제외',
          confirmer_name: '평가자A',
        },
        db
      );

      const mockAiClient = new AiClient({
        baseUrl: 'https://example.com/v1',
        // public-safety-allow: mock AI client dummy key
        apiKey: 'dummy',
        model: 'aieas-default',
        reasoningEffort: 'xhigh',
        fetchFn: async () =>
          new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      sentences: [
                        {
                          indicator_id: 'ind-valid',
                          sentence: '핵심 공무원 500명 이수 완료 달성을 확인하였음.',
                          evidence_ids: ['ev-1'],
                        },
                      ],
                    }),
                  },
                },
              ],
            })
          ),
      });

      // 초안 생성
      Object.defineProperty(mockAiClient, 'provider', { value: 'solar' });
      const draft = await createReportDraft(PROJECT_ID, { db, aiClient: mockAiClient });

      // 버전이 없는 옛 초안도 기존 일곱 절을 보존한다.
      const legacyDraft = { ...draft };
      delete legacyDraft.version;
      delete legacyDraft.template;
      delete legacyDraft.report_sections;
      delete legacyDraft.footnotes;
      // DOCX 생성 (인메모리 Buffer)
      const docxBuffer = await generateReportDocx(legacyDraft);
      expect(docxBuffer).toBeDefined();
      expect(docxBuffer.length).toBeGreaterThan(0);

      // DOCX 를 extractDocx 로 다시 열어 파싱 검증
      const extraction = await extractDocx(docxBuffer);
      expect(extraction.status).toBe('추출 완료');

      const allText = extraction.paragraphs.map((p) => p.content).join('\n');

      // 1. 일곱 절 제목이 모두 존재하는지 단언 (RQ-20, RQ-22)
      expect(allText).toContain('1. 성과지표 달성표');
      expect(allText).toContain('2. 성과 분석');
      expect(allText).toContain('3. 기여요인');
      expect(allText).toContain('4. 제약요인과 대응');
      expect(allText).toContain('5. 교훈');
      expect(allText).toContain('6. 모니터링 계획');
      expect(allText).toContain('7. 종합평가');

      // 2. 정상 확정 지표 내용 확인
      expect(allText).toContain('정상 확정 지표');
      expect(allText).toContain('핵심 공무원 500명 이수 완료 달성을 확인하였음.');

      // 3. 미확정·보완 필요·채택 제외 판단 문장이 0건인지 단언 (RQ-22, D04)
      expect(allText).not.toContain('보완 필요 금지 지표');
      expect(allText).not.toContain('보완 필요 금지 문장');
      expect(allText).not.toContain('채택 제외 금지 지표');
      expect(allText).not.toContain('채택 제외 금지 문장');

      // 4. 인용 금지 문장 글자가 0건인지 단언 (RQ-14)
      expect(allText).not.toContain('면담에 참여한 현지 실무관은 이름을 밝히지 말아');
      expect(allText).not.toContain('이름을 밝히지 말아');
      expect(allText).not.toContain('[인용 금지 문장]');
    });
  });

  describe('5. 대상 판단 지문 및 초안 무효화 (#22 검수 반영 1차, Item 1)', () => {
    it('버전이 없는 기존 지문 초안은 새 지문 규칙으로 유효하다고 판정하지 않는다', async () => {
      const draft = await createReportDraft(PROJECT_ID, { db });
      const legacyDraft = { ...draft };
      delete legacyDraft.fingerprint_version;
      expect(isDraftValid(legacyDraft, PROJECT_ID, db)).toBe(false);
    });

    it('판 2 지문 초안은 판 3에서 무효다', async () => {
      const draft = await createReportDraft(PROJECT_ID, { db });
      expect(isDraftValid({ ...draft, fingerprint_version: 2 }, PROJECT_ID, db)).toBe(false);
    });

    it('지문은 인용 근거의 원문 문단 ID와 문단 내용 해시를 모두 반영한다', () => {
      const targets = (paragraphId: string, content: string) => [{
        indicator: { id: 'ind-source-fingerprint' },
        latestConfirmation: { id: 'confirmation-source-fingerprint' },
        evidences: [{ id: 'evidence-source-fingerprint', paragraph_context: { target: { id: paragraphId, content } } }],
      }] as any;
      const original = computeReportFingerprint(targets('paragraph-a', '가상 원문 문단 내용'));
      expect(computeReportFingerprint(targets('paragraph-b', '가상 원문 문단 내용'))).not.toBe(original);
      expect(computeReportFingerprint(targets('paragraph-a', '변경된 가상 원문 문단 내용'))).not.toBe(original);
    });

    it('초안에 생성 시점의 대상 판단 지문이 저장되고, 판단 변경 시 지문이 불일치하여 초안이 무효화된다', async () => {
      const indId = 'ind-fp-test';
      store.createIndicator(
        {
          id: indId,
          project_id: PROJECT_ID,
          level: '활동',
          name: '지문 시험 지표',
          ovi: 'OVI',
          mov: null,
          target_value: '100건',
          is_baseline: 0,
          created_at: new Date().toISOString(),
        },
        db
      );
      store.saveSuggestion(
        {
          id: 'sugg-fp',
          indicator_id: indId,
          verdict_status: '실현',
          error_reason: null,
          proposal_text: '100건 달성 제안',
          created_at: new Date().toISOString(),
        },
        [],
        db
      );
      store.createConfirmation(
        {
          indicator_id: indId,
          confirmation_type: '확정',
          confirmer_name: '평가자A',
        },
        db
      );

      const fpBefore = computeJudgmentFingerprint(PROJECT_ID, db);
      expect(fpBefore).toBeDefined();
      expect(typeof fpBefore).toBe('string');
      expect(fpBefore.length).toBe(64); // sha256 hex length

      const mockAi = new AiClient({
        baseUrl: 'https://example.com/v1',
        // public-safety-allow: mock AI client dummy key
        apiKey: 'dummy',
        model: 'aieas-default',
        reasoningEffort: 'xhigh',
        fetchFn: async () =>
          new Response(
            JSON.stringify({ choices: [{ message: { content: JSON.stringify({ sentences: [] }) } }] })
          ),
      });

      Object.defineProperty(mockAi, 'provider', { value: 'solar' });
      const draft = await createReportDraft(PROJECT_ID, { db, aiClient: mockAi });
      expect(draft.fingerprint).toBe(fpBefore);
      expect(isDraftValid(draft, PROJECT_ID, db)).toBe(true);

      // 한 판단을 보완 필요로 재확정
      store.createConfirmation(
        {
          indicator_id: indId,
          confirmation_type: '보완 필요',
          confirmer_name: '평가자A',
          reason: '실적 추가 확인 필요',
        },
        db
      );

      const fpAfter = computeJudgmentFingerprint(PROJECT_ID, db);
      expect(fpAfter).not.toBe(fpBefore);
      // 저장된 초안과 현재 지문이 다르므로 무효화 판정
      expect(isDraftValid(draft, PROJECT_ID, db)).toBe(false);
    });

    it('초안 생성 후 대상 지표의 기여 귀속을 수정하면 초안이 무효화된다 (#22 마지막 검수 Item 1)', async () => {
      const indId = 'ind-fp-attr-test';
      const docId = 'doc-fp-attr';
      store.createDocument(
        {
          id: docId,
          project_id: PROJECT_ID,
          file_name: 'doc-fp.docx',
          file_type: 'docx',
          status: '추출 완료',
          doc_type: '사업계획서',
          is_included: 1,
          excluded_reason: null,
          is_past_final_report: false,
          created_at: new Date().toISOString(),
        },
        db
      );
      store.createIndicator(
        {
          id: indId,
          project_id: PROJECT_ID,
          level: '활동',
          name: '지문 시험 지표',
          ovi: 'OVI',
          mov: null,
          target_value: '100%',
          is_baseline: 0,
          created_at: new Date().toISOString(),
        },
        db
      );
      store.saveSuggestion(
        {
          id: 'sugg-fp-attr',
          indicator_id: indId,
          verdict_status: '실현',
          error_reason: null,
          proposal_text: '100% 달성',
          created_at: new Date().toISOString(),
        },
        [
          {
            id: 'ev-fp-1',
            suggestion_id: 'sugg-fp-attr',
            quote: '100% 달성 원문',
            document_id: docId,
            location: '1쪽',
            speaker: '작성자',
          },
        ],
        db
      );
      store.createConfirmation(
        {
          indicator_id: indId,
          confirmation_type: '확정',
          confirmer_name: '평가자A',
        },
        db
      );
      store.saveIndicatorAttribution(
        PROJECT_ID,
        indId,
        '초기 기여 귀속 서술 내용',
        db
      );

      const fpBefore = computeJudgmentFingerprint(PROJECT_ID, db);
      const mockAi = new AiClient({
        baseUrl: 'https://example.com/v1',
        // public-safety-allow: mock AI client dummy key
        apiKey: 'dummy',
        model: 'aieas-default',
        reasoningEffort: 'xhigh',
        fetchFn: async () =>
          new Response(
            JSON.stringify({ choices: [{ message: { content: JSON.stringify({ sentences: [] }) } }] })
          ),
      });

      Object.defineProperty(mockAi, 'provider', { value: 'solar' });
      const draft = await createReportDraft(PROJECT_ID, { db, aiClient: mockAi });
      expect(draft.fingerprint).toBe(fpBefore);
      expect(isDraftValid(draft, PROJECT_ID, db)).toBe(true);

      // 대상 지표의 기여 귀속 수정
      store.saveIndicatorAttribution(
        PROJECT_ID,
        indId,
        '수정된 기여 귀속 서술 내용 (평가자 재검토 반영)',
        db
      );

      const fpAfter = computeJudgmentFingerprint(PROJECT_ID, db);
      expect(fpAfter).not.toBe(fpBefore);
      // 저장된 초안과 현재 지문이 다르므로 무효화 판정
      expect(isDraftValid(draft, PROJECT_ID, db)).toBe(false);
    });
  });

  describe('6. DOCX 내 [근거] 하이퍼링크 검증 (#22 검수 반영 1차, Item 2)', () => {
    it('DOCX 문서 내 [근거]는 S4 해당 근거 주소 하이퍼링크로 포함된다', async () => {
      const indId = 'ind-link-test';
      const evId = 'ev-link-test-1';
      const docId = 'doc-link-pdf';
      store.createDocument(
        {
          id: docId,
          project_id: PROJECT_ID,
          file_name: 'doc-link.pdf',
          file_type: 'pdf',
          status: '추출 완료',
          doc_type: '사업계획서',
          is_included: 1,
          excluded_reason: null,
          is_past_final_report: false,
          created_at: new Date().toISOString(),
        },
        db
      );
      insertEvidenceParagraphs([{ id: 'p-link-test', document_id: docId, location: 'p.12', content: '교육 50명 수료 완료함.' }]);
      store.createIndicator(
        {
          id: indId,
          project_id: PROJECT_ID,
          level: '산출물',
          name: '하이퍼링크 검증 지표',
          ovi: 'OVI',
          mov: null,
          target_value: '50명',
          is_baseline: 0,
          created_at: new Date().toISOString(),
        },
        db
      );
      store.saveSuggestion(
        {
          id: 'sugg-link',
          indicator_id: indId,
          verdict_status: '실현',
          error_reason: null,
          proposal_text: '50명 수료 완료',
          created_at: new Date().toISOString(),
        },
        [
          {
            id: evId,
            suggestion_id: 'sugg-link',
            quote: '교육 50명 수료 완료함.',
            document_id: docId,
            location: 'p.12',
            speaker: '담당관',
          },
        ],
        db
      );
      store.createConfirmation(
        {
          indicator_id: indId,
          confirmation_type: '확정',
          confirmer_name: '평가자A',
        },
        db
      );

      const mockAi = new AiClient({
        baseUrl: 'https://example.com/v1',
        // public-safety-allow: mock AI client dummy key
        apiKey: 'dummy',
        model: 'aieas-default',
        reasoningEffort: 'xhigh',
        fetchFn: async () =>
          new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      sentences: [
                        {
                          indicator_id: indId,
                          sentence: '교육 50명 수료 완료함.',
                          evidence_ids: [evId],
                        },
                      ],
                    }),
                  },
                },
              ],
            })
          ),
      });

      Object.defineProperty(mockAi, 'provider', { value: 'solar' });
      const draft = await createReportDraft(PROJECT_ID, { db, aiClient: mockAi });

      // 환경변수 없을 때: 상대 경로 텍스트 하이퍼링크
      delete process.env.AIEAS_PUBLIC_BASE_URL;
      const docxRelative = await generateReportDocx(draft);
      const zipRel = await JSZip.loadAsync(docxRelative);
      const relsXmlRel = await zipRel.file('word/_rels/document.xml.rels')?.async('text');
      expect(relsXmlRel).toBeDefined();
      expect(relsXmlRel).toContain(
        `/projects/${PROJECT_ID}/review?indicatorId=${indId}#evidence-${evId}`
      );

      // 환경변수 있을 때: 절대 주소 하이퍼링크
      process.env.AIEAS_PUBLIC_BASE_URL = 'https://evaluation.example.org';
      const docxAbsolute = await generateReportDocx(draft);
      const zipAbs = await JSZip.loadAsync(docxAbsolute);
      const relsXmlAbs = await zipAbs.file('word/_rels/document.xml.rels')?.async('text');
      expect(relsXmlAbs).toBeDefined();
      expect(relsXmlAbs).toContain(
        `https://evaluation.example.org/projects/${PROJECT_ID}/review?indicatorId=${indId}#evidence-${evId}`
      );
      delete process.env.AIEAS_PUBLIC_BASE_URL;
    });
  });

  describe('7. 문장별 복수 검증 근거 ID 보관 및 표시 (#22 검수 반영 1차, Item 3)', () => {
    it('문장마다 검증 통과한 모든 근거 ID가 보관되고 DOCX에 하이퍼링크로 포함된다', async () => {
      const indId = 'ind-multi-ev';
      const ev1 = 'ev-multi-1';
      const ev2 = 'ev-multi-2';
      const doc1 = 'doc-multi-1';
      const doc2 = 'doc-multi-2';
      store.createDocument(
        {
          id: doc1,
          project_id: PROJECT_ID,
          file_name: 'doc-1.docx',
          file_type: 'docx',
          status: '추출 완료',
          doc_type: '사업계획서',
          is_included: 1,
          excluded_reason: null,
          masked: true,
          approved_ai: 'solar',
          is_past_final_report: false,
          created_at: new Date().toISOString(),
        },
        db
      );
      store.createDocument(
        {
          id: doc2,
          project_id: PROJECT_ID,
          file_name: 'doc-2.docx',
          file_type: 'docx',
          status: '추출 완료',
          doc_type: '성과관리표',
          is_included: 1,
          excluded_reason: null,
          masked: true,
          approved_ai: 'solar',
          is_past_final_report: false,
          created_at: new Date().toISOString(),
        },
        db
      );
      insertEvidenceParagraphs([
        { id: 'p-multi-1', document_id: doc1, location: '¶1', content: '1차 실적 50건 달성.' },
        { id: 'p-multi-2', document_id: doc2, location: '¶2', content: '2차 실적 50건 달성하여 총 100건 완료.' },
      ]);
      store.createIndicator(
        {
          id: indId,
          source_doc_id: doc1,
          project_id: PROJECT_ID,
          level: '활동',
          name: '다중 근거 검증 지표',
          ovi: 'OVI',
          mov: null,
          target_value: '100건',
          is_baseline: 0,
          created_at: new Date().toISOString(),
        },
        db
      );
      store.saveSuggestion(
        {
          id: 'sugg-multi',
          indicator_id: indId,
          verdict_status: '실현',
          error_reason: null,
          proposal_text: '100건 달성',
          created_at: new Date().toISOString(),
        },
        [
          {
            id: ev1,
            suggestion_id: 'sugg-multi',
            quote: '1차 실적 50건 달성.',
            document_id: doc1,
            location: '¶1',
            speaker: '기관A',
          },
          {
            id: ev2,
            suggestion_id: 'sugg-multi',
            quote: '2차 실적 50건 달성하여 총 100건 완료.',
            document_id: doc2,
            location: '¶2',
            speaker: '기관B',
          },
        ],
        db
      );
      store.createConfirmation(
        {
          indicator_id: indId,
          confirmation_type: '확정',
          confirmer_name: '평가자A',
        },
        db
      );

      const mockAi = new AiClient({
        baseUrl: 'https://example.com/v1',
        // public-safety-allow: mock AI client dummy key
        apiKey: 'dummy',
        model: 'aieas-default',
        reasoningEffort: 'xhigh',
        fetchFn: async () =>
          new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      sentences: [
                        {
                          indicator_id: indId,
                          sentence: '2차 실적 50건 달성하여 총 100건 완료.',
                          evidence_ids: [ev1, ev2],
                        },
                      ],
                    }),
                  },
                },
              ],
            })
          ),
      });

      Object.defineProperty(mockAi, 'provider', { value: 'solar' });
      const draft = await createReportDraft(PROJECT_ID, { db, aiClient: mockAi });
      const sentences = draft.sections.performance_analysis.sentences;
      expect(sentences.length).toBe(1);
      // 첫 번째뿐만 아니라 검증 통과한 모든 근거 ID 보관
      expect(sentences[0].evidence_ids).toEqual([ev1, ev2]);

      // DOCX 에 두 근거 모두 하이퍼링크로 포함되는지 확인
      const docxBuf = await generateReportDocx(draft);
      const zip = await JSZip.loadAsync(docxBuf);
      const rels = await zip.file('word/_rels/document.xml.rels')?.async('text');
      expect(rels).toContain(`#evidence-${ev1}`);
      expect(rels).toContain(`#evidence-${ev2}`);
    });
  });

  describe('8. 수정 후 확정: 평가자 수정본 그대로 서술 문장 반영 및 근거 링크 (#22 검수 2회차 반영)', () => {
    it('가짜 AI가 수정본과 무관한 문장을 돌려줘도 보고서의 해당 판단 문장은 수정본과 같고, 검증 통과 근거 id들이 모두 링크된다', async () => {
      const indEditId = 'ind-edit-test-1';
      const indConfId = 'ind-conf-test-1';
      const evEdit1 = 'ev-edit-1';
      const evEdit2 = 'ev-edit-2';
      const evConf1 = 'ev-conf-1';
      const docId = 'doc-test-docx';

      store.createDocument(
        {
          id: docId,
          project_id: PROJECT_ID,
          file_name: 'doc-edit.docx',
          file_type: 'docx',
          status: '추출 완료',
          doc_type: '사업계획서',
          is_included: 1,
          excluded_reason: null,
          masked: true,
          approved_ai: 'solar',
          is_past_final_report: false,
          created_at: new Date().toISOString(),
        },
        db
      );
      insertEvidenceParagraphs([
        { id: 'p-edit-3', document_id: docId, location: '¶3', content: '목표 인원은 500명으로 설정됨.' },
        { id: 'p-edit-4', document_id: docId, location: '¶4', content: '현장 실사 결과 교육 이수자가 집계됨.' },
        { id: 'p-edit-5', document_id: docId, location: '¶5', content: '교육 10회를 성공적으로 실시함.' },
      ]);

      store.createIndicator(
        {
          id: indEditId,
          project_id: PROJECT_ID,
          level: '단기성과',
          name: '수정 후 확정 지표',
          ovi: 'OVI-1',
          mov: null,
          target_value: '500명',
          is_baseline: 0,
          created_at: new Date().toISOString(),
        },
        db
      );

      store.createIndicator(
        {
          id: indConfId,
          source_doc_id: docId,
          project_id: PROJECT_ID,
          level: '활동',
          name: '일반 확정 지표',
          ovi: 'OVI-2',
          mov: null,
          target_value: '10회',
          is_baseline: 0,
          created_at: new Date().toISOString(),
        },
        db
      );

      // 수정 후 확정 지표의 제안 및 복수 근거
      store.saveSuggestion(
        {
          id: 'sugg-edit-1',
          indicator_id: indEditId,
          verdict_status: '추진 중',
          error_reason: null,
          proposal_text: '500명 제안',
          created_at: new Date().toISOString(),
        },
        [
          {
            id: evEdit1,
            suggestion_id: 'sugg-edit-1',
            quote: '목표 인원은 500명으로 설정됨.',
            document_id: docId,
            location: '¶3',
            speaker: '기획관',
          },
          {
            id: evEdit2,
            suggestion_id: 'sugg-edit-1',
            quote: '현장 실사 결과 교육 이수자가 집계됨.',
            document_id: docId,
            location: '¶4',
            speaker: '담당관',
          },
        ],
        db
      );

      // 일반 확정 지표의 제안 및 근거
      store.saveSuggestion(
        {
          id: 'sugg-conf-1',
          indicator_id: indConfId,
          verdict_status: '실현',
          error_reason: null,
          proposal_text: '10회 교육 완료',
          created_at: new Date().toISOString(),
        },
        [
          {
            id: evConf1,
            suggestion_id: 'sugg-conf-1',
            quote: '교육 10회를 성공적으로 실시함.',
            document_id: docId,
            location: '¶5',
            speaker: '교육팀',
          },
        ],
        db
      );

      // 1. 일반 확정 지표 등록
      store.createConfirmation(
        {
          indicator_id: indConfId,
          confirmation_type: '확정',
          confirmer_name: '평가자A',
        },
        db
      );

      // 2. 수정 후 확정 지표 등록: 2개의 문장으로 구성된 수정본
      const editedSentence1 = '실제 이수 완료 인원은 450명으로 집계됨.';
      const editedSentence2 = '현장 조사 만족도는 98%를 기록함.';
      const fullEditedText = `${editedSentence1} ${editedSentence2}`;
      store.createConfirmation(
        {
          indicator_id: indEditId,
          confirmation_type: '수정 후 확정',
          confirmer_name: '평가자B',
          edited_text: fullEditedText,
          reason: '최신 현장 조사 데이터 반영',
        },
        db
      );

      // 3. 가짜 AI: AI는 확정 판단에만 사용되어야 함.
      // 만약 가짜 AI가 수정본과 완전히 무관한 환각 문장을 응답에 끼워넣더라도,
      // 보고서 초안의 해당 판단 서술 문장은 반드시 평가자 수정본이어야 함.
      let capturedPayload: any = null;
      const mockAi = new AiClient({
        baseUrl: 'https://example.com/v1',
        // public-safety-allow: mock AI client dummy key
        apiKey: 'dummy',
        model: 'aieas-default',
        reasoningEffort: 'xhigh',
        fetchFn: async (_url, opts) => {
          const body = JSON.parse(opts?.body as string);
          const userMsg = body.messages.find((m: any) => m.role === 'user');
          capturedPayload = JSON.parse(userMsg.content);

          return new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      sentences: [
                        // 확정 지표에 대한 정상 AI 문장
                        {
                          indicator_id: indConfId,
                          sentence: '교육 10회를 성공적으로 실시함.',
                          evidence_ids: [evConf1],
                        },
                        // 가짜 AI가 수정 후 확정 지표에 대해 수정본과 무관하게 지어낸 환각 문장
                        {
                          indicator_id: indEditId,
                          sentence: '가짜 AI가 임의로 생성한 수정본과 무관한 환각 문장입니다.',
                          evidence_ids: [evEdit1],
                        },
                      ],
                    }),
                  },
                },
              ],
            })
          );
        },
      });

      Object.defineProperty(mockAi, 'provider', { value: 'solar' });
      const draft = await createReportDraft(PROJECT_ID, { db, aiClient: mockAi });

      // 단언 1: AI 프롬프트에는 '확정' 판단만 전달되고 '수정 후 확정' 판단은 전달되지 않음
      expect(capturedPayload).toBeDefined();
      const payloadIndicators = capturedPayload.indicators.map((i: any) => i.id);
      expect(payloadIndicators).toContain(indConfId);
      expect(payloadIndicators).not.toContain(indEditId);

      // 단언 2: 달성표에 '수정 후 확정' 및 수정본 텍스트 정상 표기
      const row = draft.sections.achievement_table.rows.find((r) => r.indicator_id === indEditId);
      expect(row).toBeDefined();
      expect(row?.confirmation_type).toBe('수정 후 확정');
      expect(row?.edited_text).toBe(fullEditedText);

      // 단언 3: 서술 문장에 가짜 AI의 환각 문장은 절대 포함되지 않음
      const sentences = draft.sections.performance_analysis.sentences;
      const hallucinated = sentences.find((s) =>
        s.sentence.includes('가짜 AI가 임의로 생성한')
      );
      expect(hallucinated).toBeUndefined();

      // 단언 4: '수정 후 확정' 지표의 서술 문장은 문장으로 나누지 않고 수정본 전체가 한 서술 항목으로 들어감 (#22 검수 3회차)
      const editSentences = sentences.filter((s) => s.indicator_id === indEditId);
      expect(editSentences.length).toBe(1);
      expect(editSentences[0].sentence).toBe(fullEditedText);

      // 단언 5: 해당 서술 항목에 검증 통과 근거 id 들([evEdit1, evEdit2])이 모두 링크됨
      expect(editSentences[0].evidence_ids).toEqual([evEdit1, evEdit2]);
      expect(editSentences[0].evidences?.map((e) => e.id)).toEqual([evEdit1, evEdit2]);
      expect(editSentences[0].evidence_id).toBe(evEdit1);

      // 단언 6: '확정' 지표의 AI 문장도 정상 포함됨
      const confSentence = sentences.find((s) => s.indicator_id === indConfId);
      expect(confSentence).toBeDefined();
      expect(confSentence?.sentence).toBe('교육 10회를 성공적으로 실시함.');
      expect(confSentence?.evidence_ids).toEqual([evConf1]);

      // 단언 7: DOCX 생성 시 수정본 문장들과 근거 하이퍼링크가 모두 포함됨
      const docxBuf = await generateReportDocx(draft);
      const extracted = await extractDocx(docxBuf);
      const fullDocx = extracted.paragraphs.map((p) => p.content).join('\n');
      expect(fullDocx).toContain(`[수정본] ${fullEditedText}`);
      expect(fullDocx).toContain(editedSentence1);
      expect(fullDocx).toContain(editedSentence2);
    });

    it('확정 판단 없이 수정 후 확정 판단만 있는 경우 AI 호출 없이 수정본으로만 초안이 작성된다', async () => {
      const indOnlyEdit = 'ind-only-edit';
      const evOnly1 = 'ev-only-1';
      const docId = 'doc-only-edit';

      store.createDocument(
        {
          id: docId,
          project_id: PROJECT_ID,
          file_name: 'doc-only.docx',
          file_type: 'docx',
          status: '추출 완료',
          doc_type: '사업계획서',
          is_included: 1,
          excluded_reason: null,
          is_past_final_report: false,
          created_at: new Date().toISOString(),
        },
        db
      );
      insertEvidenceParagraphs([{ id: 'p-only-edit', document_id: docId, location: '¶1', content: '목표 인원은 100명으로 설정됨.' }]);

      store.createIndicator(
        {
          id: indOnlyEdit,
          project_id: PROJECT_ID,
          level: '단기성과',
          name: '단독 수정 후 확정 지표',
          ovi: 'OVI',
          mov: null,
          target_value: '100명',
          is_baseline: 0,
          created_at: new Date().toISOString(),
        },
        db
      );

      store.saveSuggestion(
        {
          id: 'sugg-only-1',
          indicator_id: indOnlyEdit,
          verdict_status: '추진 중',
          error_reason: null,
          proposal_text: '100명 제안',
          created_at: new Date().toISOString(),
        },
        [
          {
            id: evOnly1,
            suggestion_id: 'sugg-only-1',
            quote: '목표 인원은 100명으로 설정됨.',
            document_id: docId,
            location: '¶1',
            speaker: '기획관',
          },
        ],
        db
      );

      const editedText = '현장 확인 결과 120명 참여가 확정됨.';
      store.createConfirmation(
        {
          indicator_id: indOnlyEdit,
          confirmation_type: '수정 후 확정',
          confirmer_name: '평가자A',
          edited_text: editedText,
          reason: '인원 변경',
        },
        db
      );

      let aiCalled = false;
      const mockAi = new AiClient({
        baseUrl: 'https://example.com/v1',
        apiKey: 'dummy',
        model: 'aieas-default',
        reasoningEffort: 'xhigh',
        fetchFn: async () => {
          aiCalled = true;
          throw new Error('AI가 호출되면 안 됩니다.');
        },
      });

      Object.defineProperty(mockAi, 'provider', { value: 'solar' });
      const draft = await createReportDraft(PROJECT_ID, { db, aiClient: mockAi });

      // AI가 호출되지 않았음을 단언
      expect(aiCalled).toBe(false);

      // 서술 문장에 수정본이 정상 포함됨
      const sentences = draft.sections.performance_analysis.sentences;
      expect(sentences.length).toBe(1);
      expect(sentences[0].sentence).toBe(editedText);
      expect(sentences[0].evidence_ids).toEqual([evOnly1]);
    });

    it("'수정 후 확정' 수정본을 문장으로 나누지 않고 '2025. 3. 8.' 날짜와 '1. 첫째 2. 둘째' 번호가 든 수정본이 그대로 한 항목으로 들어간다 (#22 검수 3회차)", async () => {
      const indDateNumberEdit = 'ind-date-number-edit';
      const ev1 = 'ev-date-num-1';
      const ev2 = 'ev-date-num-2';
      const docId = 'doc-date-num';

      store.createDocument(
        {
          id: docId,
          project_id: PROJECT_ID,
          file_name: 'doc-date-num.docx',
          file_type: 'docx',
          status: '추출 완료',
          doc_type: '사업계획서',
          is_included: 1,
          excluded_reason: null,
          is_past_final_report: false,
          created_at: new Date().toISOString(),
        },
        db
      );
      insertEvidenceParagraphs([
        { id: 'p-date-num-1', document_id: docId, location: '¶1', content: '2025. 3. 8. 평가 위원회 개최 결과' },
        { id: 'p-date-num-2', document_id: docId, location: '¶2', content: '1. 첫째 목표 달성 및 2. 둘째 목표 추진' },
      ]);

      store.createIndicator(
        {
          id: indDateNumberEdit,
          project_id: PROJECT_ID,
          level: '단기성과',
          name: '날짜 및 번호 포함 수정 지표',
          ovi: 'OVI',
          mov: null,
          target_value: '100명',
          is_baseline: 0,
          created_at: new Date().toISOString(),
        },
        db
      );

      store.saveSuggestion(
        {
          id: 'sugg-date-num',
          indicator_id: indDateNumberEdit,
          verdict_status: '실현',
          error_reason: null,
          proposal_text: '추진 완료 제안',
          created_at: new Date().toISOString(),
        },
        [
          {
            id: ev1,
            suggestion_id: 'sugg-date-num',
            quote: '2025. 3. 8. 평가 위원회 개최 결과',
            document_id: docId,
            location: '¶1',
            speaker: '위원장',
          },
          {
            id: ev2,
            suggestion_id: 'sugg-date-num',
            quote: '1. 첫째 목표 달성 및 2. 둘째 목표 추진',
            document_id: docId,
            location: '¶2',
            speaker: '간사',
          },
        ],
        db
      );

      const complexEditedText =
        '2025. 3. 8. 최종 점검 결과: 1. 첫째 시스템 연동 완료 2. 둘째 사용자 교육 이수.';
      store.createConfirmation(
        {
          indicator_id: indDateNumberEdit,
          confirmation_type: '수정 후 확정',
          confirmer_name: '평가위원',
          edited_text: complexEditedText,
          reason: '위원회 심의 의견 반영',
        },
        db
      );

      const draft = await createReportDraft(PROJECT_ID, { db });
      const editSentences = draft.sections.performance_analysis.sentences.filter(
        (s) => s.indicator_id === indDateNumberEdit
      );

      // 수정본 전체를 한 서술 항목으로 넣고 그 판단의 검증 통과 근거 id 들을 링크
      expect(editSentences.length).toBe(1);
      expect(editSentences[0].sentence).toBe(complexEditedText);
      expect(editSentences[0].evidence_ids).toEqual([ev1, ev2]);
      expect(editSentences[0].evidences?.map((e) => e.id)).toEqual([ev1, ev2]);
      expect(editSentences[0].evidence_id).toBe(ev1);

      // DOCX 검증: 수정본 전체가 한 서술 항목으로 들어가고 근거 하이퍼링크가 유지됨
      const docxBuf = await generateReportDocx(draft);
      const extracted = await extractDocx(docxBuf);
      const fullDocx = extracted.paragraphs.map((p) => p.content).join('\n');
      expect(fullDocx).toContain(complexEditedText);
    });
  });

  describe('9. 가짜 AI(E2E 전용) 보고서 경로 오류 처리 (#22 검수 반영 1차, Item 5)', () => {
    it('파싱 실패나 문장 부재 시 고정 문장으로 대체하지 않고 오류를 던진다', async () => {
      const fakeAi = createE2EFakeAiClient();

      // 1) 잘못된 본문 전달 시 JSON 파싱 오류를 던져야 함
      await expect(
        fakeAi.generateReportDraft([
          { role: 'system', content: 'system' },
          { role: 'user', content: 'INVALID_JSON_CONTENT' },
        ])
      ).rejects.toThrow();

      // 2) indicators 가 비어있거나 대상 문장이 없을 시 고정 문장 대체 대신 오류를 던져야 함
      await expect(
        fakeAi.generateReportDraft([
          { role: 'system', content: 'system' },
          { role: 'user', content: JSON.stringify({ indicators: [] }) },
        ])
      ).rejects.toThrow();
    });
  });

  describe('10. 문서에서 사라진 지표(is_orphaned=1) 보고서 포함 및 달성표 표시 (#19, #22 통합)', () => {
    it('사라진 지표의 최신 확정이 확정이면 보고서 대상 및 달성표에 포함되고 (문서에서 사라진 지표)가 표기된다', async () => {
      const indOrphaned = 'ind-orph-1';
      store.createIndicator(
        {
          id: indOrphaned,
          project_id: PROJECT_ID,
          level: '산출물',
          name: '사라진 성과 지표',
          ovi: 'OVI-ORPH-1',
          mov: null,
          target_value: '10개소',
          is_baseline: 0,
          created_at: new Date().toISOString(),
        },
        db
      );
      db.prepare('UPDATE indicators SET is_orphaned = 1 WHERE id = ?').run(indOrphaned);

      store.saveSuggestion(
        {
          id: `sugg-${indOrphaned}`,
          indicator_id: indOrphaned,
          verdict_status: '실현',
          error_reason: null,
          proposal_text: '사라진 지표의 제안 문장입니다.',
          created_at: new Date().toISOString(),
        },
        [],
        db
      );

      store.createConfirmation(
        {
          indicator_id: indOrphaned,
          confirmation_type: '확정',
          confirmer_name: '평가자A',
        },
        db
      );

      const targets = store.getReportTargets(PROJECT_ID, db);
      const target = targets.find((t) => t.indicator.id === indOrphaned);
      expect(target).toBeDefined();
      expect(target?.indicator.is_orphaned).toBe(1);

      const draft = await createReportDraft(PROJECT_ID, { db });
      const row = draft.sections.achievement_table.rows.find(
        (r) => r.indicator_id === indOrphaned
      );
      expect(row).toBeDefined();
      expect(row?.is_orphaned).toBe(true);
      expect(row?.indicator_name).toBe('사라진 성과 지표');

      const docxBuf = await generateReportDocx(draft);
      const extracted = await extractDocx(docxBuf);
      const fullDocx = extracted.paragraphs.map((p) => p.content).join('\n');
      expect(fullDocx).toContain('(문서에서 사라진 지표)');
    });

    it('사라진 지표의 최신 확정이 수정 후 확정이면 수정본과 함께 달성표에 표시된다', async () => {
      const indOrphaned2 = 'ind-orph-2';
      store.createIndicator(
        {
          id: indOrphaned2,
          project_id: PROJECT_ID,
          level: '단기성과',
          name: '사라진 수정 대상 지표',
          ovi: 'OVI-ORPH-2',
          mov: null,
          target_value: '100명',
          is_baseline: 0,
          created_at: new Date().toISOString(),
        },
        db
      );
      db.prepare('UPDATE indicators SET is_orphaned = 1 WHERE id = ?').run(indOrphaned2);

      store.saveSuggestion(
        {
          id: `sugg-${indOrphaned2}`,
          indicator_id: indOrphaned2,
          verdict_status: '추진 중',
          error_reason: null,
          proposal_text: '원래 제안 문장입니다.',
          created_at: new Date().toISOString(),
        },
        [],
        db
      );

      const editedText = '평가자가 수정한 내용입니다.';
      store.createConfirmation(
        {
          indicator_id: indOrphaned2,
          confirmation_type: '수정 후 확정',
          confirmer_name: '평가자B',
          edited_text: editedText,
          reason: '실적 검증',
        },
        db
      );

      const draft = await createReportDraft(PROJECT_ID, { db });
      const row = draft.sections.achievement_table.rows.find(
        (r) => r.indicator_id === indOrphaned2
      );
      expect(row).toBeDefined();
      expect(row?.is_orphaned).toBe(true);
      expect(row?.confirmation_type).toBe('수정 후 확정');
      expect(row?.edited_text).toBe(editedText);
    });

    it('사라진 지표의 최신 확정이 채택 제외이면 보고서에 포함되지 않는다', async () => {
      const indOrphanedRej = 'ind-orph-rej';
      store.createIndicator(
        {
          id: indOrphanedRej,
          project_id: PROJECT_ID,
          level: '활동',
          name: '제외된 사라진 지표',
          ovi: 'OVI-ORPH-REJ',
          mov: null,
          target_value: '3회',
          is_baseline: 0,
          created_at: new Date().toISOString(),
        },
        db
      );
      db.prepare('UPDATE indicators SET is_orphaned = 1 WHERE id = ?').run(indOrphanedRej);

      store.saveSuggestion(
        {
          id: `sugg-${indOrphanedRej}`,
          indicator_id: indOrphanedRej,
          verdict_status: '미확인',
          error_reason: null,
          proposal_text: '미확인 제안',
          created_at: new Date().toISOString(),
        },
        [],
        db
      );

      store.createConfirmation(
        {
          indicator_id: indOrphanedRej,
          confirmation_type: '채택 제외',
          confirmer_name: '평가자C',
        },
        db
      );

      const targets = store.getReportTargets(PROJECT_ID, db);
      expect(targets.some((t) => t.indicator.id === indOrphanedRej)).toBe(false);
    });
  });
});

