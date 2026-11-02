import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { CREATE_TABLES_SQL } from './schema';
import { EvidenceQuoteCacheNotReady, getOutcomeFinalResults, getReportTargets, getResultTocData } from './db';
import { prepareEvidenceQuoteCache } from './evidence-quote-cache';
import { createReportDraft } from '../report/service';
import { generateReportDocx } from '../report/docx';
import JSZip from 'jszip';

describe('성과관리 최종결과 및 PDM 성과표 통합 서버 함수', () => {
  it('초기 ToC의 확정·수정 후 확정·미확정 값을 실제 보고서 대상과 결과 ToC에 대조한다', async () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(CREATE_TABLES_SQL);

    // 사업 등록
    db.exec(`
      INSERT INTO projects (id, name, created_at) VALUES ('p-test', '가상 사업', '2026-01-01');
      INSERT INTO documents (id, project_id, file_name, file_type, status, doc_type, is_included, is_past_final_report, created_at)
      VALUES
        ('d-pdm', 'p-test', 'pdm.docx', 'docx', '추출 완료', '성과관리표', 1, 0, '2026-01-01'),
        ('d-doc', 'p-test', 'report.pdf', 'pdf', '추출 완료', '종료평가보고서', 1, 0, '2026-01-01');
      INSERT INTO paragraphs (id, document_id, sequence_no, location, content)
      VALUES ('para-1', 'd-doc', 1, '¶1', '500명 교육 완수. 현장 참석자 서명. 가입자 60만명.');

      -- 5개 단계별 지표 등록 (활동, 산출물, 단기성과, 중기성과, 영향)
      INSERT INTO indicators (id, project_id, level, name, ovi, target_value, created_at)
      VALUES
        ('ind-act', 'p-test', '활동', '활동 지표 A', '공무원 교육', '500명 이수', '2026-01-01'),
        ('ind-out', 'p-test', '산출물', '산출 지표 B', '플랫폼 구축', '1식 개발 완료', '2026-01-01'),
        ('ind-sho', 'p-test', '단기성과', '단기 지표 C', '포털 가입자', '100만명 확보', '2026-01-01'),
        ('ind-mid', 'p-test', '중기성과', '중기 지표 D', '시간 단축', '30% 단축', '2026-01-01'),
        ('ind-imp', 'p-test', '영향', '영향 지표 E', '만족도', '80% 달성', '2026-01-01');

      -- 기준값 등록 (ind-act에만 기준값 등록, 나머지는 미등록)
      INSERT INTO indicator_baselines (id, project_id, indicator_id, document_id, document_name, target_value, selected_at)
      VALUES ('b-act', 'p-test', 'ind-act', 'd-pdm', 'pdm.docx', '0명', '2026-01-01');

      -- 제안 및 근거 등록
      INSERT INTO suggestions (id, indicator_id, verdict_status, proposal_text, created_at)
      VALUES
        ('s-act', 'ind-act', '실현', '500명 교육을 완수함', '2026-01-01'),
        ('s-out', 'ind-out', '미확인', '시스템 구축 미확인', '2026-01-01'),
        ('s-sho', 'ind-sho', '추진 중', '포털 가입자 60만명 확보', '2026-01-01'),
        ('s-sho-new', 'ind-sho', '기대', '나중에 생성한 다른 제안', '2026-01-03'),
        ('s-mid', 'ind-mid', '기대', '검토 전 제안', '2026-01-01');
      INSERT INTO evidences (id, suggestion_id, quote, document_id, location, speaker)
      VALUES
        ('ev-1', 's-act', '500명 교육 완수', 'd-doc', '¶1', '수행기관'),
        ('ev-2', 's-act', '현장 참석자 서명', 'd-doc', '¶1', '수행기관'),
        ('ev-3', 's-sho', '가입자 60만명', 'd-doc', '¶1', '수행기관'),
        ('ev-4', 's-mid', '가입자 60만명', 'd-doc', '¶1', '수행기관');

      -- 평가팀 확정 등록:
      -- ind-act: '확정' (실현, 근거 2건)
      -- ind-out: '확정' (미확인 -> '근거 미확인')
      -- ind-sho: '수정 후 확정' (수정 문안 및 실현으로 변경)
      -- ind-mid: 확정 없음 (검토 중)
      -- ind-imp: 확정 없음 (검토 중)
      INSERT INTO confirmations (id, indicator_id, suggestion_id, confirmation_type, initial_proposal, edited_text, edited_verdict_status, reason, confirmer_name, created_at)
      VALUES
        ('c-act', 'ind-act', 's-act', '확정', '500명 교육을 완수함', NULL, NULL, NULL, '평가자 1', '2026-01-02'),
        ('c-out', 'ind-out', 's-out', '확정', '시스템 구축 미확인', NULL, NULL, NULL, '평가자 1', '2026-01-02'),
        ('c-sho', 'ind-sho', 's-sho', '수정 후 확정', '포털 가입자 60만명 확보', '최종 100만명 조기 달성 확인', '실현', '실적 증빙 확인', '평가자 2', '2026-01-02');
    `);

    // 1. getOutcomeFinalResults 실행
    prepareEvidenceQuoteCache('p-test', db);
    const finalResults = getOutcomeFinalResults('p-test', db);
    expect(finalResults.totalIndicators).toBe(5);
    expect(finalResults.confirmedCount).toBe(3);
    expect(finalResults.hasConfirmedResults).toBe(true);

    // 2. getReportTargets 실행
    const reportTargets = getReportTargets('p-test', db);
    expect(reportTargets).toHaveLength(3);

    // 실제 보고서 초안의 달성표와 결과 ToC를 각자의 서버 함수에서 얻는다.
    const report = await createReportDraft('p-test', { db });
    const resultToc = getResultTocData('p-test', db)!;
    const reportRows = report.sections.achievement_table.rows;

    // 3. 지표별 상세 값 대조
    const allIndicators = finalResults.stages.flatMap((s) => s.indicators);
    const act = allIndicators.find((i) => i.indicator_id === 'ind-act')!;
    const out = allIndicators.find((i) => i.indicator_id === 'ind-out')!;
    const sho = allIndicators.find((i) => i.indicator_id === 'ind-sho')!;
    const mid = allIndicators.find((i) => i.indicator_id === 'ind-mid')!;
    const imp = allIndicators.find((i) => i.indicator_id === 'ind-imp')!;

    for (const id of ['ind-act', 'ind-out', 'ind-sho']) {
      const initial = allIndicators.find((item) => item.indicator_id === id)!;
      const target = reportTargets.find((item) => item.indicator.id === id)!;
      const reportRow = reportRows.find((item) => item.indicator_id === id)!;
      const result = resultToc.items.find((item) => item.indicator.id === id)!;

      expect(initial.actual_value).toBe(target.confirmedText);
      expect(initial.verdict_status).toBe(target.verdictStatus);
      expect(initial.status_display).toBe(reportRow.status_display);
      expect(initial.target_value).toBe(reportRow.target_value);
      expect(initial.evidence_count).toBe(target.evidences.length);
      expect(initial.verdict_status).toBe(result.verdictStatus);
      expect(initial.confirmation_type).toBe(result.latestConfirmation?.confirmation_type);
      expect(initial.actual_value).toBe(
        result.latestConfirmation?.confirmation_type === '수정 후 확정'
          ? result.latestConfirmation.edited_text
          : result.latestConfirmation?.initial_proposal
      );
      expect(result.latestSuggestion?.id).toBe(target.latestConfirmation.suggestion_id);
      expect((result.latestSuggestion as typeof result.latestSuggestion & { evidences: unknown[] }).evidences.length).toBe(initial.evidence_count);
    }

    // 미확정은 보고서에 없으며 결과 ToC에도 미확정으로 남는다.
    for (const id of ['ind-mid', 'ind-imp']) {
      const initial = allIndicators.find((item) => item.indicator_id === id)!;
      const result = resultToc.items.find((item) => item.indicator.id === id)!;
      expect(reportTargets.some((item) => item.indicator.id === id)).toBe(false);
      expect(reportRows.some((item) => item.indicator_id === id)).toBe(false);
      expect(result.displayKind).toBe('미확정');
      expect(result.verdictStatus).toBe(initial.verdict_status);
      expect(result.latestConfirmation).toBeNull();
      expect(initial.actual_value).toBe('검토 중');
    }
    expect(reportRows.find((item) => item.indicator_id === 'ind-sho')?.edited_text).toBe(sho.actual_value);
    expect(resultToc.items.find((item) => item.indicator.id === 'ind-sho')?.latestSuggestion?.id).toBe('s-sho');

    // ind-act: 확정 (실현, 근거 2건, 기준값 0명, 단위 명)
    expect(act.is_confirmed).toBe(true);
    expect(act.status_display).toBe('실현');
    expect(act.verdict_status).toBe('실현');
    expect(act.actual_value).toBe('500명 교육을 완수함');
    expect(act.evidence_count).toBe(2);
    expect(act.baseline_value).toBe('0명');
    expect(act.unit).toBe('명');
    expect(act.stage_label).toBe('활동');

    // 보고서 대상과의 일치 검증
    const repAct = reportTargets.find((t) => t.indicator.id === 'ind-act')!;
    expect(act.verdict_status).toBe(repAct.verdictStatus);
    expect(act.actual_value).toBe(repAct.confirmedText);

    // ind-out: 확정 (미확인 -> 근거 미확인)
    expect(out.is_confirmed).toBe(true);
    expect(out.status_display).toBe('근거 미확인');
    expect(out.verdict_status).toBe('미확인');
    expect(out.evidence_count).toBe(0);
    expect(out.stage_label).toBe('산출물');
    expect(out.baseline_value).toBe('PDM에 없음');
    expect(out.unit).toBe('식');

    const repOut = reportTargets.find((t) => t.indicator.id === 'ind-out')!;
    expect(repOut.isUnverifiedVerdict).toBe(true);
    expect(out.status_display).toBe('근거 미확인');

    // ind-sho: 수정 후 확정
    expect(sho.is_confirmed).toBe(true);
    expect(sho.status_display).toBe('실현');
    expect(sho.verdict_status).toBe('실현');
    expect(sho.actual_value).toBe('최종 100만명 조기 달성 확인');
    expect(sho.evidence_count).toBe(1);
    expect(sho.stage_label).toBe('단기');
    expect(sho.unit).toBe('만명');

    const repSho = reportTargets.find((t) => t.indicator.id === 'ind-sho')!;
    expect(sho.verdict_status).toBe(repSho.verdictStatus);
    expect(sho.actual_value).toBe(repSho.confirmedText);

    // ind-mid & ind-imp: 확정 전 -> 검토 중
    expect(mid.is_confirmed).toBe(false);
    expect(mid.status_display).toBe('검토 중');
    expect(mid.actual_value).toBe('검토 중');
    expect(mid.stage_label).toBe('중장기');
    expect(mid.unit).toBe('%');

    expect(imp.is_confirmed).toBe(false);
    expect(imp.status_display).toBe('검토 중');
    expect(imp.actual_value).toBe('검토 중');
    expect(imp.stage_label).toBe('영향');
    expect(imp.unit).toBe('%');

    // 링크 형식 검증
    expect(act.review_href).toBe('/projects/p-test/review?indicatorId=ind-act');
    expect(act.report_href).toBe('/projects/p-test/report#achievement-row-ind-act');

    db.close();
  });

  it('지표가 없는 단계는 PDM에 없음으로 표시된다', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(CREATE_TABLES_SQL);

    db.exec(`
      INSERT INTO projects (id, name, created_at) VALUES ('p-sparse', '가상 희소 사업', '2026-01-01');
      -- 산출물 지표만 등록
      INSERT INTO indicators (id, project_id, level, name, ovi, created_at)
      VALUES ('ind-1', 'p-sparse', '산출물', '단일 산출물', '내용', '2026-01-01');
    `);

    const result = getOutcomeFinalResults('p-sparse', db);
    expect(result.stages).toHaveLength(5);

    const actStage = result.stages.find((s) => s.stage_key === 'activity')!;
    expect(actStage.indicators).toHaveLength(0);

    const outStage = result.stages.find((s) => s.stage_key === 'output')!;
    expect(outStage.indicators).toHaveLength(1);
    expect(outStage.indicators[0].target_value).toBe('내용');
    expect(outStage.indicators[0].baseline_value).toBe('PDM에 없음');
    expect(outStage.indicators[0].unit).toBe('PDM에 없음');

    db.close();
  });
});

it('금지 문장과 여덟 글자가 겹치는 지표명과 확정 정보를 출력에서 가린다', async () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(CREATE_TABLES_SQL);
  db.exec(`
    INSERT INTO projects (id, name, created_at) VALUES ('p-mask', '가상 사업', '2026-01-01');
    INSERT INTO documents (id, project_id, file_name, file_type, status, doc_type, is_included, is_past_final_report, created_at)
      VALUES ('doc-mask', 'p-mask', 'virtual.pdf', 'pdf', '추출 완료', '기타', 1, 0, '2026-01-01');
    INSERT INTO paragraphs (id, document_id, sequence_no, location, content)
      VALUES ('para-mask', 'doc-mask', 1, '한곳', '교육 완료. ABCDEFGHIJKL');
    INSERT INTO sentences (id, document_id, paragraph_id, sequence_no, location, content, is_citation_banned)
      VALUES ('sent-mask', 'doc-mask', 'para-mask', 1, '한곳', 'ABCDEFGHIJKL', 1);
    INSERT INTO indicators (id, project_id, level, name, ovi, source_doc_id, created_at)
      VALUES ('ind-mask', 'p-mask', '활동', '지표 ABCDEFGH', '목표', 'doc-mask', '2026-01-01');
    INSERT INTO suggestions (id, indicator_id, verdict_status, proposal_text, created_at)
      VALUES ('suggest-mask', 'ind-mask', '실현', '교육 완료', '2026-01-01');
    INSERT INTO evidences (id, suggestion_id, quote, document_id, location, speaker)
      VALUES ('ev-mask', 'suggest-mask', '교육 완료', 'doc-mask', '한곳', '담당');
    INSERT INTO confirmations (id, indicator_id, suggestion_id, confirmation_type, initial_proposal, edited_text, edited_verdict_status, reason, confirmer_name, created_at)
      VALUES ('conf-mask', 'ind-mask', 'suggest-mask', '수정 후 확정', '교육 완료', '교육 완료', '실현', '사유 ABCDEFGH', '평가자 ABCDEFGH', '2026-01-02');
  `);

  const report = await createReportDraft('p-mask', { db });
  const row = report.sections.achievement_table.rows.find((item) => item.indicator_id === 'ind-mask')!;
  const narrative = report.sections.performance_analysis.sentences.find((item) => item.indicator_id === 'ind-mask')!;
  const result = getResultTocData('p-mask', db)!.items.find((item) => item.indicator.id === 'ind-mask')!;
  expect(row.indicator_name).toBe('[인용 금지 문장]');
  expect(narrative.indicator_name).toBe(row.indicator_name);
  expect(narrative.sentence).toBe('교육 완료');
  expect(result.indicator.name).toBe(row.indicator_name);
  expect(result.latestConfirmation?.reason).toBe('[인용 금지 문장]');
  expect(result.latestConfirmation?.confirmer_name).toBe('[인용 금지 문장]');

  const word = await JSZip.loadAsync(await generateReportDocx(report));
  const wordXml = await word.file('word/document.xml')!.async('string');
  expect(wordXml).toContain('[인용 금지 문장]');
  expect(wordXml).toContain('교육 완료');
  expect(wordXml).not.toContain('ABCDEFGH');
  expect(db.prepare('SELECT name FROM indicators WHERE id = ?').get('ind-mask')).toEqual({ name: '지표 ABCDEFGH' });
  expect(db.prepare('SELECT reason, confirmer_name FROM confirmations WHERE id = ?').get('conf-mask'))
    .toEqual({ reason: '사유 ABCDEFGH', confirmer_name: '평가자 ABCDEFGH' });
  db.close();
});


it('보완·제외 판정, 인용 자격과 금지 문장을 세 화면에 대조한다', async () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(CREATE_TABLES_SQL);
  db.exec(`
    INSERT INTO projects (id, name, created_at) VALUES ('p-extra', '가상 사업', '2026-01-01');
    INSERT INTO documents (id, project_id, file_name, file_type, status, doc_type, is_included, is_past_final_report, created_at) VALUES
      ('doc-ok', 'p-extra', 'ok.pdf', 'pdf', '추출 완료', '기타', 1, 0, '2026-01-01'),
      ('doc-excluded', 'p-extra', 'excluded.pdf', 'pdf', '추출 완료', '기타', 0, 0, '2026-01-01');
    INSERT INTO paragraphs (id, document_id, sequence_no, location, content) VALUES
      ('para-ok', 'doc-ok', 1, '한곳', '정상 인용입니다. 이 문장은 외부 인용이 금지됩니다.'),
      ('para-excluded', 'doc-excluded', 1, '한곳', '제외 문서의 근거입니다.');
    INSERT INTO sentences (id, document_id, paragraph_id, sequence_no, location, content, is_citation_banned)
      VALUES ('sent-ban', 'doc-ok', 'para-ok', 1, '한곳', '이 문장은 외부 인용이 금지됩니다.', 1);
    INSERT INTO indicators (id, project_id, level, name, ovi, target_value, created_at) VALUES
      ('a', 'p-extra', '활동', '가상 첫째', '목표', '이 문장은 외부 인용이 금지됩니다.', '2026-01-01'),
      ('b', 'p-extra', '활동', '가상 둘째', '목표', NULL, '2026-01-01'),
      ('c', 'p-extra', '활동', '가상 셋째', '목표', NULL, '2026-01-01'),
      ('d', 'p-extra', '활동', '가상 넷째', '목표', NULL, '2026-01-01'),
      ('e', 'p-extra', '활동', '가상 다섯째', '가입자 100만명 확보', NULL, '2026-01-01'),
      ('f', 'p-extra', '활동', '가상 여섯째', '목표', NULL, '2026-01-01'),
      ('g', 'p-extra', '활동', '가상 일곱째', '목표', NULL, '2026-01-01'),
      ('h', 'p-extra', '활동', '가상 여덟째', '목표', NULL, '2026-01-01');
    UPDATE indicators SET source_doc_id = 'doc-excluded' WHERE id = 'g';
    INSERT INTO indicator_baselines (id, project_id, indicator_id, document_id, document_name, target_value, selected_at)
      VALUES ('base', 'p-extra', 'a', 'doc-ok', 'ok.pdf', '이 문장은 외부 인용이 금지됩니다.', '2026-01-01');
    INSERT INTO suggestions (id, indicator_id, verdict_status, proposal_text, created_at) VALUES
      ('sa', 'a', '실현', '가상 제안', '2026-01-01'), ('sb', 'b', '실현', '가상 제안', '2026-01-01'),
      ('sc', 'c', '실현', '가상 제안', '2026-01-01'), ('sd', 'd', '실현', '가상 제안', '2026-01-01'),
      ('se', 'e', '실현', '가상 제안', '2026-01-01'), ('sg', 'g', '실현', '가상 제안', '2026-01-01'),
      ('sh', 'h', '실현', '가상 제안', '2026-01-01');
    INSERT INTO evidences (id, suggestion_id, quote, document_id, location, speaker, is_citation_banned) VALUES
      ('ev-ok', 'sa', '정상 인용입니다.', 'doc-ok', '한곳', '담당', 0),
      ('ev-ban', 'sa', '정상 인용입니다.', 'doc-ok', '한곳', '담당', 1),
      ('ev-mismatch', 'sa', '일치하지 않는 인용', 'doc-ok', '한곳', '담당', 0),
      ('ev-excluded', 'se', '제외 문서의 근거입니다.', 'doc-excluded', '한곳', '담당', 0),
      ('ev-only-ban', 'sd', '정상 인용입니다.', 'doc-ok', '한곳', '담당', 1),
      ('ev-g', 'sg', '정상 인용입니다.', 'doc-ok', '한곳', '담당', 0),
      ('ev-h1', 'sh', '정상 인용입니다.', 'doc-ok', '한곳', '담당', 0),
      ('ev-h2', 'sh', '제외 문서의 근거입니다.', 'doc-excluded', '한곳', '담당', 0);
    INSERT INTO confirmations (id, indicator_id, suggestion_id, confirmation_type, initial_proposal, edited_text, edited_verdict_status, reason, confirmer_name, created_at) VALUES
      ('ca', 'a', 'sa', '수정 후 확정', '가상 제안', '이 문장은 외부 인용이 금지됩니다.', '실현', '사유', '평가자', '2026-01-02'),
      ('cb', 'b', 'sb', '보완 필요', '가상 제안', NULL, NULL, '사유', '평가자', '2026-01-02'),
      ('cc', 'c', 'sc', '채택 제외', '가상 제안', NULL, NULL, '사유', '평가자', '2026-01-02'),
      ('cd', 'd', 'sd', '확정', '가상 제안', NULL, NULL, NULL, '평가자', '2026-01-02'),
      ('ce', 'e', 'se', '확정', '가상 제안', NULL, NULL, NULL, '평가자', '2026-01-02'),
      ('cg', 'g', 'sg', '확정', '가상 제안', NULL, NULL, NULL, '평가자', '2026-01-02'),
      ('ch', 'h', 'sh', '확정', '가상 제안', NULL, NULL, NULL, '평가자', '2026-01-02');
  `);
  prepareEvidenceQuoteCache('p-extra', db);
  const initial = getOutcomeFinalResults('p-extra', db).stages.flatMap((stage) => stage.indicators);
  const result = getResultTocData('p-extra', db)!;
  const report = await createReportDraft('p-extra', { db });
  const reportRows = report.sections.achievement_table.rows;
  expect(initial.map((item) => item.indicator_id)).toEqual(result.items.map((item) => item.indicator.id));
  for (const [id, state] of [['b', '보완 필요'], ['c', '채택 제외']] as const) {
    expect(initial.find((item) => item.indicator_id === id)?.status_display).toBe(state);
    expect(result.items.find((item) => item.indicator.id === id)?.displayKind).toBe(state);
    expect(reportRows.some((row) => row.indicator_id === id)).toBe(false);
    expect(initial.find((item) => item.indicator_id === id)?.actual_value).toBe('—');
  }
  expect(result.items.find((item) => item.indicator.id === 'f')?.displayKind).toBe('미확정');
  expect(reportRows.some((row) => row.indicator_id === 'f')).toBe(false);
  expect(initial.find((item) => item.indicator_id === 'f')?.status_display).toBe('검토 중');
  expect(initial.find((item) => item.indicator_id === 'f')?.actual_value).toBe('검토 중');
  const a = initial.find((item) => item.indicator_id === 'a')!;
  expect(a.evidence_count).toBe(1);
  expect(reportRows.find((row) => row.indicator_id === 'a')?.evidence_id).toBe('ev-ok');
  expect(a.actual_value).toBe('[인용 금지 문장]');
  expect(a.target_value).toBe('[인용 금지 문장]');
  expect(a.baseline_value).toBe('[인용 금지 문장]');
  const reportA = reportRows.find((row) => row.indicator_id === 'a')!;
  const resultA = result.items.find((item) => item.indicator.id === 'a')!;
  expect(reportA.target_value).toBe(a.target_value);
  expect(reportA.edited_text).toBe(a.actual_value);
  expect(resultA.indicator.target_value).toBe(a.target_value);
  expect(resultA.latestConfirmation?.edited_text).toBe(a.actual_value);
  const word = await JSZip.loadAsync(await generateReportDocx(report));
  const wordXml = await word.file('word/document.xml')!.async('string');
  expect(wordXml).toContain('[인용 금지 문장]');
  expect(wordXml).not.toContain('이 문장은 외부 인용이 금지됩니다.');
  expect(initial.find((item) => item.indicator_id === 'd')?.evidence_count).toBe(0);
  expect(reportRows.find((row) => row.indicator_id === 'd')?.evidence_id).toBeUndefined();
  const e = initial.find((item) => item.indicator_id === 'e')!;
  expect(e.evidence_count).toBe(0);
  expect(e.status_display).toBe('근거 미확인');
  expect(e.actual_value).toBe('—');
  expect(e.target_value).toBe('가입자 100만명 확보');
  expect(e.unit).toBe('만명');
  expect(reportRows.some((row) => row.indicator_id === 'e')).toBe(false);
  // 제외된 지표 출처 또는 포함·제외 근거가 혼합된 경우도 보고서와 같은 판정이다.
  for (const id of ['g', 'h']) {
    expect(reportRows.some((row) => row.indicator_id === id)).toBe(false);
    expect(initial.find((item) => item.indicator_id === id)?.status_display).toBe('근거 미확인');
    expect(initial.find((item) => item.indicator_id === id)?.actual_value).toBe('—');
  }
  db.close();
});

it('성과표는 저장된 인용 판정을 읽고 근거·원문·금지 문장 변경 때 이전 판정을 사용하지 않는다', () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(CREATE_TABLES_SQL);
  db.exec(`
    INSERT INTO projects (id, name, created_at) VALUES ('p-cache', '가상 사업', '2026-01-01'), ('p-other', '다른 가상 사업', '2026-01-01');
    INSERT INTO documents (id, project_id, file_name, file_type, status, doc_type, is_included, is_past_final_report, created_at)
      VALUES ('doc-cache', 'p-cache', 'virtual.pdf', 'pdf', '추출 완료', '기타', 1, 0, '2026-01-01'),
        ('doc-other', 'p-other', 'virtual.pdf', 'pdf', '추출 완료', '기타', 1, 0, '2026-01-01');
    INSERT INTO paragraphs (id, document_id, sequence_no, location, content)
      VALUES ('para-cache', 'doc-cache', 1, '한곳', '가상 교육을 완료했습니다. 다른 가상 문장입니다.'),
        ('para-other', 'doc-other', 1, '한곳', '가상 교육을 완료했습니다.');
    INSERT INTO indicators (id, project_id, level, name, ovi, created_at)
      VALUES ('ind-cache', 'p-cache', '활동', '교육', '목표', '2026-01-01'),
        ('ind-other', 'p-other', '활동', '교육', '목표', '2026-01-01');
    INSERT INTO suggestions (id, indicator_id, verdict_status, proposal_text, created_at)
      VALUES ('suggest-cache', 'ind-cache', '실현', '교육 완료', '2026-01-01'),
        ('suggest-other', 'ind-other', '실현', '교육 완료', '2026-01-01');
    INSERT INTO evidences (id, suggestion_id, quote, document_id, location, speaker)
      VALUES ('ev-cache', 'suggest-cache', '가상 교육을 완료했습니다.', 'doc-cache', '한곳', '담당'),
        ('ev-other', 'suggest-other', '가상 교육을 완료했습니다.', 'doc-other', '한곳', '담당');
    INSERT INTO confirmations (id, indicator_id, suggestion_id, confirmation_type, initial_proposal, confirmer_name, created_at)
      VALUES ('conf-cache', 'ind-cache', 'suggest-cache', '확정', '교육 완료', '평가자', '2026-01-02'),
        ('conf-other', 'ind-other', 'suggest-other', '확정', '교육 완료', '평가자', '2026-01-02');
  `);
  const evidenceCount = () => getOutcomeFinalResults('p-cache', db).stages
    .flatMap((stage) => stage.indicators).find((item) => item.indicator_id === 'ind-cache')!.evidence_count;

  // 캐시가 없을 때 화면은 이전 판정이나 임의의 숫자를 표시하지 않는다.
  expect(evidenceCount).toThrow(EvidenceQuoteCacheNotReady);
  prepareEvidenceQuoteCache('p-cache', db);
  prepareEvidenceQuoteCache('p-other', db);
  const otherEvidenceCount = () => getOutcomeFinalResults('p-other', db).stages
    .flatMap((stage) => stage.indicators).find((item) => item.indicator_id === 'ind-other')!.evidence_count;
  db.pragma('query_only = ON');
  expect(evidenceCount()).toBe(1);
  expect(evidenceCount()).toBe(1);
  db.pragma('query_only = OFF');

  // 금지 문장의 추가와 해제 모두 이전 캐시를 무효화한다.
  db.exec(`INSERT INTO sentences (id, document_id, paragraph_id, sequence_no, location, content, is_citation_banned)
    VALUES ('sentence-cache', 'doc-cache', 'para-cache', 1, '한곳', '가상 교육을 완료했습니다.', 1)`);
  expect(evidenceCount).toThrow(EvidenceQuoteCacheNotReady);
  expect(otherEvidenceCount()).toBe(1);
  prepareEvidenceQuoteCache('p-cache', db);
  expect(evidenceCount()).toBe(0);
  db.exec("UPDATE sentences SET is_citation_banned = 0 WHERE id = 'sentence-cache'");
  expect(evidenceCount).toThrow(EvidenceQuoteCacheNotReady);
  prepareEvidenceQuoteCache('p-cache', db);
  expect(evidenceCount()).toBe(1);

  // 원문이 바뀌면 이전 인용 일치가 남지 않고, 복원 후에도 재준비가 필요하다.
  db.exec("UPDATE paragraphs SET content = '다른 가상 문장입니다.' WHERE id = 'para-cache'");
  expect(evidenceCount).toThrow(EvidenceQuoteCacheNotReady);
  prepareEvidenceQuoteCache('p-cache', db);
  expect(evidenceCount()).toBe(0);
  db.exec("UPDATE paragraphs SET content = '가상 교육을 완료했습니다. 다른 가상 문장입니다.' WHERE id = 'para-cache'");
  expect(evidenceCount).toThrow(EvidenceQuoteCacheNotReady);
  prepareEvidenceQuoteCache('p-cache', db);
  expect(evidenceCount()).toBe(1);

  // 근거의 인용문이 바뀐 뒤에는 새로운 원문 대조를 저장해야 한다.
  db.exec("UPDATE evidences SET quote = '일치하지 않는 문장입니다.' WHERE id = 'ev-cache'");
  expect(evidenceCount).toThrow(EvidenceQuoteCacheNotReady);
  prepareEvidenceQuoteCache('p-cache', db);
  expect(evidenceCount()).toBe(0);
  db.exec("UPDATE evidences SET quote = '가상 교육을 완료했습니다.' WHERE id = 'ev-cache'");
  expect(evidenceCount).toThrow(EvidenceQuoteCacheNotReady);
  prepareEvidenceQuoteCache('p-cache', db);
  expect(evidenceCount()).toBe(1);
  db.close();
});
