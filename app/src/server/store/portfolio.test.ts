import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { CREATE_TABLES_SQL } from './schema';
import { getPortfolioPageData, savePortfolioLevel, summarizePortfolioProject } from './portfolio';

const confirmed = (
  outcomeFamily: string,
  teamLevel: string | null,
  outcomeState = '관측됨',
  reviewStatus = '확정',
) => ({ type: 'outcome-mid', outcomeFamily, teamLevel, outcomeState, reviewStatus, evidenceEligible: true, evidenceObserved: true });

describe('사업 포트폴리오 집계', () => {
  it('두 축에서 사업별 최댓값을 계산한다', () => {
    const result = summarizePortfolioProject('fiction-a', '가상 사업 하나', [
      confirmed('협력국 정책 반영', 'K3'),
      confirmed('협력국 정책 반영', 'K6'),
      confirmed('개발협력 촉진', 'Lv2'),
      confirmed('지식 네트워킹', 'Lv4'),
    ]);

    expect(result.knowledge).toEqual({ level: 'K6', emptyReason: null });
    expect(result.cooperation).toEqual({ level: 'Lv4', emptyReason: null });
    expect(result.quadrant).toBe('확장 및 선도형 (1사분면)');
  });

  it('K4와 Lv3 경계로 네 사분면을 구분한다', () => {
    const quadrants = [
      ['K4', 'Lv3', '확장 및 선도형 (1사분면)'],
      ['K4', 'Lv2', '지식활용 및 정책수용형 (2사분면)'],
      ['K3', 'Lv2', '지식 축적 및 초기 탐색형 (3사분면)'],
      ['K3', 'Lv3', '플랫폼형 (4사분면)'],
    ] as const;

    for (const [knowledge, cooperation, quadrant] of quadrants) {
      const result = summarizePortfolioProject('fiction-b', '가상 경계 사업', [
        confirmed('협력국 정책 반영', knowledge),
        confirmed('경제협력 촉진', cooperation),
      ]);
      expect(result.quadrant).toBe(quadrant);
    }
  });

  it('미검토·보완 필요·채택 제외와 기대/추정 레벨은 최댓값에 포함하지 않는다', () => {
    const result = summarizePortfolioProject('fiction-c', '가상 제외 사업', [
      confirmed('협력국 정책 반영', 'K6', '관측됨', '수정 중'),
      confirmed('협력국 정책 반영', 'K5', '관측됨', '보완 필요'),
      confirmed('협력국 정책 반영', 'K4', '관측됨', '채택 제외'),
      confirmed('협력국 정책 반영', 'K6', '기대/추정', '수정 후 확정'),
      confirmed('협력국 정책 반영', 'K2', '관측됨', '수정 후 확정'),
      confirmed('개발협력 촉진', 'Lv4', '기대/추정', '확정'),
    ]);

    expect(result.knowledge).toEqual({ level: 'K2', emptyReason: null });
    expect(result.cooperation).toEqual({ level: null, emptyReason: 'expected_only' });
    expect(result.quadrant).toBeNull();
  });

  it('다른 축의 상태가 현재 축의 빈 이유를 바꾸지 않는다', () => {
    const expectedPolicy = summarizePortfolioProject('fiction-x', '가상 교차 축 사업', [
      confirmed('협력국 정책 반영', 'K6', '기대/추정'),
      confirmed('개발협력 촉진', 'Lv3', '관측됨'),
    ]);
    expect(expectedPolicy.knowledge.emptyReason).toBe('expected_only');
    expect(expectedPolicy.cooperation.level).toBe('Lv3');

    const unreviewedPolicy = summarizePortfolioProject('fiction-y', '가상 미검토 축 사업', [
      confirmed('협력국 정책 반영', 'K6', '관측됨', '미검토'),
      confirmed('경제협력 촉진', 'Lv2', '관측됨'),
    ]);
    expect(unreviewedPolicy.knowledge.emptyReason).toBe('no_confirmed_outcomes');
    expect(unreviewedPolicy.cooperation.level).toBe('Lv2');
  });

  it('관측·입증 상태만 허용하고 알 수 없는 상태와 근거 자격 없는 성과를 제외한다', () => {
    for (const state of ['미확인', '기대/추정', '추진 중', '', '알 수 없음']) {
      const result = summarizePortfolioProject('fiction-state', '가상 상태 사업', [confirmed('협력국 정책 반영', 'K6', state)]);
      expect(result.knowledge.level).toBeNull();
      expect(result.knowledge.emptyReason).not.toBeNull();
    }
    for (const state of ['관측됨', '관측', '입증']) {
      expect(summarizePortfolioProject('fiction-state', '가상 상태 사업', [confirmed('협력국 정책 반영', 'K3', state)]).knowledge.level).toBe('K3');
    }
    const noEvidence = { ...confirmed('협력국 정책 반영', 'K6'), evidenceEligible: false };
    expect(summarizePortfolioProject('fiction-state', '가상 상태 사업', [noEvidence]).knowledge)
      .toEqual({ level: null, emptyReason: 'ineligible_evidence' });
    expect(summarizePortfolioProject('fiction-state', '가상 상태 사업', [confirmed('개발협력 촉진', 'Lv5')]).cooperation.level).toBe('Lv5');
  });

  it('축이 비는 이유를 각각 구분한다', () => {
    const none = summarizePortfolioProject('fiction-d', '성과 없음 사업', []);
    expect(none.knowledge.emptyReason).toBe('no_outcomes');
    expect(none.cooperation.emptyReason).toBe('no_outcomes');

    const notReviewed = summarizePortfolioProject('fiction-e', '미검토 사업', [
      confirmed('협력국 정책 반영', 'K6', '관측됨', '미검토'),
    ]);
    expect(notReviewed.knowledge.emptyReason).toBe('no_confirmed_outcomes');

    const policyOnly = summarizePortfolioProject('fiction-f', '한 축 사업', [confirmed('협력국 정책 반영', 'K2')]);
    expect(policyOnly.cooperation.emptyReason).toBe('no_family_outcomes');

    const missingLevel = summarizePortfolioProject('fiction-g', '레벨 미입력 사업', [
      confirmed('협력국 정책 반영', null),
    ]);
    expect(missingLevel.knowledge.emptyReason).toBe('team_level_missing');

    const unclassified = summarizePortfolioProject('fiction-h', '성과군 미분류 사업', [
      confirmed('', null),
    ]);
    expect(unclassified.knowledge.emptyReason).toBe('unclassified_family');
    expect(unclassified.cooperation.emptyReason).toBe('unclassified_family');

    const mixed = summarizePortfolioProject('fiction-i', '분류 확인 사업', [
      confirmed('협력국 정책 반영', 'K2'),
      confirmed('', null),
    ]);
    expect(mixed.cooperation.emptyReason).toBe('unclassified_family');
  });
});
describe('포트폴리오 레벨 추가 이력', () => {
  it('기존 노트 검토 행을 유지하고 레벨 저장 때마다 새 이력을 추가한다', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(CREATE_TABLES_SQL);
    db.prepare('INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)').run('fiction-save', '가상 보존 사업', '2026-01-01');
    db.prepare(`INSERT INTO ontology_imports (id, project_id, vault_code, imported_at, node_count, edge_count, source_count, snippet_count, error_count, warning_count, executor)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run('import-save', 'fiction-save', 'fiction', '2026-01-02', 1, 0, 0, 0, 0, 0, 'fixture');
    db.prepare(`INSERT INTO ontology_nodes (id, project_id, import_id, node_type, title, data_json)
      VALUES (?, ?, ?, ?, ?, ?)`).run('outcome-save', 'fiction-save', 'import-save', 'outcome-mid', '가상 정책 성과', JSON.stringify({
        description: '가상 성과 설명',
        outcome_family: '협력국 정책 반영',
        level_ai: 'K2',
        level: 'K6',
        outcome_state_ai: '관측됨',
        evidence: ['fiction-snippet'],
      }));
    db.prepare(`INSERT INTO documents (id, project_id, file_name, file_type, status, is_included, masked, approved_ai, is_past_final_report, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run('fiction-doc', 'fiction-save', '가상 문서', 'txt', 'ready', 1, 1, 'solar', 0, '2026-01-01');
    db.prepare('INSERT INTO paragraphs (id, document_id, sequence_no, location, content) VALUES (?, ?, ?, ?, ?)')
      .run('fiction-paragraph', 'fiction-doc', 1, '쪽 하나', '가상 문서의 검증된 인용 문장입니다.');
    db.prepare('INSERT INTO ontology_sources (id, project_id, import_id, data_json) VALUES (?, ?, ?, ?)')
      .run('fiction-source', 'fiction-save', 'import-save', JSON.stringify({ document_id: 'fiction-doc' }));
    db.prepare('INSERT INTO ontology_snippets (id, project_id, import_id, data_json) VALUES (?, ?, ?, ?)')
      .run('fiction-snippet', 'fiction-save', 'import-save', JSON.stringify({ source: 'fiction-source', locator: '쪽 하나', quote: '가상 문서의 검증된 인용 문장입니다.', evidence_level: '관측' }));
    db.prepare('INSERT INTO ontology_review_node_keys (project_id, import_id, node_id, node_type) VALUES (?, ?, ?, ?)')
      .run('fiction-save', 'import-save', 'outcome-save', '종류 불명');
    db.prepare('INSERT INTO ontology_review_evidence_keys VALUES (?, ?, ?, ?, ?, ?)')
      .run('fiction-save', 'import-save', 'outcome-save', 'fiction-source', 'fixture-location', '가상 근거 문장');
    db.prepare(`INSERT INTO ontology_note_reviews (id, project_id, import_id, node_id, status, text, original_text, outcome_state, reason, error_type, reviewer, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      'note-review-original', 'fiction-save', 'import-save', 'outcome-save', '수정 후 확정', '기존 검토 문안', 'AI 최초 문안', '관측됨', '가상 수정 사유', '기타', '가상 평가자', '2026-01-03',
    );
    const priorRows = db.prepare('SELECT * FROM ontology_note_reviews WHERE project_id=? ORDER BY rowid').all('fiction-save');
    const importedBaseline = getPortfolioPageData('fiction-save', db)!;
    expect(importedBaseline.outcomes[0]).toMatchObject({
      reviewStatus: '수정 후 확정',
      teamLevel: 'K6',
      teamLevelSource: 'imported',
      aiLevel: 'K2',
    });
    expect(importedBaseline.summary.knowledge.level).toBe('K6');

    for (const level of ['추정', '예견', '기대', '']) {
      db.prepare('UPDATE ontology_snippets SET data_json=? WHERE id=?').run(JSON.stringify({ source: 'fiction-source', locator: '쪽 하나', quote: '가상 문서의 검증된 인용 문장입니다.', evidence_level: level }), 'fiction-snippet');
      const noObserved = getPortfolioPageData('fiction-save', db)!;
      expect(noObserved.outcomes[0]).toMatchObject({ evidenceEligible: true, evidenceObserved: false });
      expect(noObserved.summary.knowledge.emptyReason).toBe('no_observed_evidence');
    }
    for (const level of ['관측', '입증']) {
      db.prepare('UPDATE ontology_snippets SET data_json=? WHERE id=?').run(JSON.stringify({ source: 'fiction-source', locator: '쪽 하나', quote: '가상 문서의 검증된 인용 문장입니다.', evidence_level: level }), 'fiction-snippet');
      expect(getPortfolioPageData('fiction-save', db)!.summary.knowledge.level).toBe('K6');
    }

    for (const [column, badValue, goodValue] of [
      ['is_past_final_report', 1, 0], ['is_past_final_report', null, 0],
      ['is_included', 0, 1], ['masked', 0, 1], ['approved_ai', 'none', 'solar'],
    ] as const) {
      db.prepare(`UPDATE documents SET ${column}=? WHERE id=?`).run(badValue, 'fiction-doc');
      expect(getPortfolioPageData('fiction-save', db)!.summary.knowledge.emptyReason).toBe('ineligible_evidence');
      db.prepare(`UPDATE documents SET ${column}=? WHERE id=?`).run(goodValue, 'fiction-doc');
      expect(getPortfolioPageData('fiction-save', db)!.summary.knowledge.level).toBe('K6');
    }
    db.prepare('UPDATE paragraphs SET content=? WHERE id=?').run('가상으로 바뀐 다른 문장입니다.', 'fiction-paragraph');
    expect(getPortfolioPageData('fiction-save', db)!.summary.knowledge.emptyReason).toBe('ineligible_evidence');
    db.prepare('UPDATE paragraphs SET content=? WHERE id=?').run('가상 문서의 검증된 인용 문장입니다.', 'fiction-paragraph');
    expect(getPortfolioPageData('fiction-save', db)!.summary.knowledge.level).toBe('K6');

    savePortfolioLevel('fiction-save', 'import-save', 'outcome-save', 'K3', '가상 평가자', db, '2026-01-04');
    savePortfolioLevel('fiction-save', 'import-save', 'outcome-save', 'K4', '가상 평가자', db, '2026-01-05');

    const pageData = getPortfolioPageData('fiction-save', db)!;
    expect(pageData.outcomes[0]).toMatchObject({
      reviewStatus: '수정 후 확정',
      teamLevel: 'K4',
      teamLevelSource: 'review_history',
      aiLevel: 'K2',
      history: [
        { teamLevel: 'K3', reviewer: '가상 평가자' },
        { teamLevel: 'K4', reviewer: '가상 평가자' },
      ],
    });
    expect(pageData.summary.knowledge.level).toBe('K4');
    expect(db.prepare('SELECT * FROM ontology_note_reviews WHERE project_id=? ORDER BY rowid').all('fiction-save')).toEqual(priorRows);
    expect(() => db.prepare('UPDATE ontology_portfolio_level_reviews SET team_level=?').run('K5')).toThrow();
    expect(() => db.prepare('DELETE FROM ontology_portfolio_level_reviews').run()).toThrow();
    expect(() => savePortfolioLevel('fiction-save', 'import-save', 'outcome-save', 'Lv3', '가상 평가자', db)).toThrow('성과군에 맞지 않는 레벨입니다.');
    savePortfolioLevel('fiction-save', 'import-save', 'outcome-save', null, '가상 평가자', db, '2026-01-06');
    const explicitlyCleared = getPortfolioPageData('fiction-save', db)!;
    expect(explicitlyCleared.outcomes[0]).toMatchObject({
      teamLevel: null,
      teamLevelSource: 'review_history',
    });
    expect(explicitlyCleared.summary.knowledge.emptyReason).toBe('team_level_missing');
    db.close();
  });
});
