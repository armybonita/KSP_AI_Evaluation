import { isConfirmedNonPastReport } from '../documents/holdout';
import { withTocSourceFingerprint } from '../store/toc-fingerprint';
import {
  DocumentRecord,
  getDatabase,
  getIndicatorHistoryScores,
  getParagraphsByDocument,
  getTocData,
  IndicatorBaselineRecord,
  IndicatorConflictRecord,
  IndicatorRecord,
  listDocuments,
  listIndicatorBaselines,
  listIndicatorConflicts,
  listIndicators,
  ParagraphRecord,
  replaceProjectToc,
  TocPageData,
} from '../store';
import {
  getBaselineKey,
  getIndicatorNaturalKey,
  hasDuplicateIndicatorNaturalKey,
  normalizeIndicatorName,
  normalizeLevel,
  normalizeOvi,
  ParsedPathwayItem,
  parsePdmParagraphs,
  STANDARD_LEVEL_ORDER,
  STANDARD_LEVELS,
} from '../../lib/baseline-key';

export {
  STANDARD_LEVELS,
  STANDARD_LEVEL_ORDER,
  type ParsedPathwayItem,
  normalizeLevel,
  normalizeIndicatorName,
  normalizeOvi,
  getBaselineKey,
  getIndicatorNaturalKey,
  parsePdmParagraphs,
  hasDuplicateIndicatorNaturalKey,
};


/**
 * 텍스트에서 목표값(수치, 단위, 백분율, 척도 등)을 동적으로 추출
 * 숫자+단위 일반형(%, 점, 명, 건, 개, 회, 일 이내, 개월, 년 등) 지원
 */
export function extractTargetValueFromText(text: string | null | undefined): string | null {
  if (!text) return null;

  // 1. "5점 척도 3.5점" 형식 척도 지표
  const scaleMatch = text.match(/\d+점\s*척도\s*[\d.]+점/);
  if (scaleMatch) return scaleMatch[0].trim();

  // 2. 백분율 지표 (예: "80%", "30%")
  const pctMatch = text.match(/[\d.]+\s*%/);
  if (pctMatch) return pctMatch[0].trim();

  // 3. 숫자 + 단위 일반형: %, 점, 명, 건, 개, 회, 일 이내, 개월, 년, 식, 원 등
  const unitMatch = text.match(
    /\b\d+[\d.,]*(?:\s*만)?\s*(?:일\s*이내|개월|년|명|건|개|회|점|식|원)(?:\s*(?:이수|확보|개발\s*완료|납품|구축|달성|단축))?/
  );
  if (unitMatch) return unitMatch[0].trim();

  return null;
}

/**
 * 목표값 비교를 위한 정규화 (공백 및 서술형 어미 제거)
 */
export function normalizeTargetValue(val: string | null | undefined): string {
  if (!val) return '';
  return val
    .replace(/\s+/g, '')
    .replace(/(?:이수|확보|개발완료|납품|구축|달성|단축)$/, '')
    .trim();
}

/** First matching paragraph for each normalized name/OVI pair, in one scan. */
export function prepareIndicatorParagraphSearch(patterns: Array<[string, string]>): (paragraphs: ParagraphRecord[]) => Array<ParagraphRecord | undefined> {
  type State = { next: Map<string, number>; fail: number; outputs: number[] };
  const states: State[] = [{ next: new Map(), fail: 0, outputs: [] }];
  patterns.forEach(([name, ovi], index) => {
    if (!name) return;
    for (const pattern of new Set([name, ovi].filter(Boolean))) {
      let state = 0;
      for (const char of pattern) {
        let next = states[state].next.get(char);
        if (next === undefined) { next = states.length; states[state].next.set(char, next); states.push({ next: new Map(), fail: 0, outputs: [] }); }
        state = next;
      }
      states[state].outputs.push(index);
    }
  });
  const queue = [...states[0].next.values()];
  for (let i = 0; i < queue.length; i++) {
    const current = queue[i];
    for (const [char, child] of states[current].next) {
      queue.push(child);
      let fail = states[current].fail;
      while (fail && !states[fail].next.has(char)) fail = states[fail].fail;
      states[child].fail = states[fail].next.get(char) ?? 0;
      states[child].outputs.push(...states[states[child].fail].outputs);
    }
  }
  return (paragraphs) => {
    const result: Array<ParagraphRecord | undefined> = Array(patterns.length).fill(undefined);
    for (const paragraph of paragraphs) {
      let state = 0;
      for (const char of normalizeIndicatorName(paragraph.content)) {
        while (state && !states[state].next.has(char)) state = states[state].fail;
        state = states[state].next.get(char) ?? 0;
        for (const index of states[state].outputs) if (!result[index]) result[index] = paragraph;
      }
    }
    return result;
  };
}

export function firstIndicatorParagraphs(paragraphs: ParagraphRecord[], patterns: Array<[string, string]>): Array<ParagraphRecord | undefined> {
  return prepareIndicatorParagraphSearch(patterns)(paragraphs);
}

/**
 * 지표 충돌 탐지 함수 (FE-06, RQ-08)
 * - 포함된 모든 계획 문서(사업계획서·성과관리표 전부, 첫 번째만이 아님) 대상
 * - 지표 이름 정규화 완전 일치인 경우만 같은 지표로 짝지음 (일반 단어 부분 일치 금지)
 * - 숫자+단위 일반형(%, 점, 명, 건, 개, 회, 일 이내, 개월, 년 등) 목표값 비교
 */
export function detectConflicts(
  projectId: string,
  indicators: IndicatorRecord[],
  documents: DocumentRecord[],
  pdmItems?: ParsedPathwayItem[],
  db: Parameters<typeof replaceProjectToc>[4] = getDatabase()
): IndicatorConflictRecord[] {
  const conflicts: IndicatorConflictRecord[] = [];

  // 포함된 모든 계획 문서 (사업계획서, 성과관리표)
  const planDocs = documents.filter(
    (d) => (d.doc_type === '사업계획서' || d.doc_type === '성과관리표') && d.is_included === 1 && isConfirmedNonPastReport(d)
  );

  if (planDocs.length < 2 || indicators.length === 0) {
    return conflicts;
  }

  const pdmDoc = planDocs.find((d) => d.doc_type === '성과관리표');

  // 각 계획 문서의 문단 캐시
  const docParasMap = new Map<string, ParagraphRecord[]>();
  for (const doc of planDocs) {
    docParasMap.set(doc.id, getParagraphsByDocument(doc.id, db));
  }

  const patterns: Array<[string, string]> = indicators.map(ind => [normalizeIndicatorName(ind.name), normalizeIndicatorName(ind.ovi)]);
  const findMatches = prepareIndicatorParagraphSearch(patterns);
  const matchesByDocument = new Map([...docParasMap].map(([id, paras]) => [id, findMatches(paras)]));
  for (const [indicatorIndex, ind] of indicators.entries()) {
    const indNormName = normalizeIndicatorName(ind.name);
    if (!indNormName) continue;

    // 성과관리표 원본 목표값: 정규화 이름 일치하는 항목이 없으면(pdmItems 가 없거나 비어 있어도) 짝 없음·충돌 없음
    const pdmItem = pdmItems?.find(
      (p) => Boolean(indNormName && normalizeIndicatorName(p.name) === indNormName)
    );
    if (!pdmItem) {
      // 일치 항목이 없으면 ind.target_value 로 비교를 이어가지 않고 짝 없음·충돌 없음
      continue;
    }
    const rawPdmVal = pdmItem.target_value;
    const pdmVal = extractTargetValueFromText(rawPdmVal) ?? rawPdmVal;
    const pdmValNorm = normalizeTargetValue(pdmVal);

    // 다른 계획 문서들(사업계획서 등)에서 지표 이름 완전 일치 문단 탐색
    for (const otherDoc of planDocs) {
      if (otherDoc.doc_type === '성과관리표' && otherDoc.id === ind.source_doc_id) {
        continue;
      }

      const matchingPara = matchesByDocument.get(otherDoc.id)?.[indicatorIndex];

      if (matchingPara) {
        const planVal = extractTargetValueFromText(matchingPara.content);
        if (planVal) {
          const planValNorm = normalizeTargetValue(planVal);
          if (pdmValNorm && planValNorm && pdmValNorm !== planValNorm) {
            const conflictId = `conflict-${ind.id}-${otherDoc.id}`;
            const docAName = otherDoc.doc_type ?? otherDoc.file_name;
            const docBName = pdmDoc?.doc_type ?? pdmDoc?.file_name ?? '성과관리표';

            conflicts.push({
              id: conflictId,
              project_id: projectId,
              indicator_id: ind.id,
              doc_a_id: otherDoc.id,
              doc_a_name: docAName,
              doc_a_value: planVal,
              doc_a_location: matchingPara.location,
              doc_b_id: pdmDoc?.id ?? ind.source_doc_id ?? otherDoc.id,
              doc_b_name: docBName,
              doc_b_value: pdmVal,
              doc_b_location: ind.source_location ?? null,
              created_at: new Date().toISOString(),
            });
          }
        }
      }
    }
  }

  return conflicts;
}

/**
 * 프로젝트 ToC 성과 경로 및 충돌 동기화 함수
 * - 매번 사업의 성과 경로·충돌을 통째로 다시 생성 (삭제 후 재생성, 단일 트랜잭션)
 * - 기준 선택은 (지표 정규화 이름, 기준 문서 id, 상대 문서 id) 로 식별해, 재계산 뒤 같은 충돌에만 다시 붙이고 없으면 버림
 * - 지표 목표값을 기준값으로 덮어쓰지 않고 기준 선택은 별도로 보관
 * - 포함된 성과관리표가 없거나 표를 찾지 못하면 경로·충돌·기준 모두 비움
 */
export function syncTocForProject(
  projectId: string,
  db: Parameters<typeof replaceProjectToc>[4] = getDatabase()
): TocPageData | null {
  const documents = listDocuments(projectId, db);
  const includedDocumentIds = new Set(documents.filter((document) => document.is_included === 1).map((document) => document.id));
  const pdmDoc = documents.find((d) => d.doc_type === '성과관리표' && d.is_included === 1 && isConfirmedNonPastReport(d));

  if (!pdmDoc) {
    // 포함된 성과관리표 부재 시 경로·충돌·기준 모두 비운다
    replaceProjectToc(projectId, [], [], [], db);
    return getTocData(projectId, db);
  }

  const pdmParas = getParagraphsByDocument(pdmDoc.id, db);
  const rawParsedItems = parsePdmParagraphs(pdmParas, pdmDoc.id);

  if (rawParsedItems.length === 0) {
    // 성과관리표에서 표(행·열 메타)를 찾지 못한 경우 경로·충돌·기준 모두 비운다
    replaceProjectToc(projectId, [], [], [], db);
    return getTocData(projectId, db);
  }

  // 성과관리표 내 자연 키 = (단계, 정규화 지표 이름, 정규화 OVI) 중복 정책:
  // 같은 키가 성과관리표 안에 둘 이상이면 첫 번째만 지표로 만든다 (#19 2회차)
  const seenPdmKeys = new Set<string>();
  const parsedItems: ParsedPathwayItem[] = [];
  for (const item of rawParsedItems) {
    const key = getIndicatorNaturalKey(item.level, item.name, item.ovi);
    if (!seenPdmKeys.has(key)) {
      seenPdmKeys.add(key);
      parsedItems.push(item);
    }
  }

  // 기존 지표, 충돌, 기준 로드하여 재부착 준비
  const oldIndicators = listIndicators(projectId, db);
  const oldConflicts = listIndicatorConflicts(projectId, db);
  const oldBaselines = listIndicatorBaselines(projectId, db);
  const oldIndicatorsById = new Map(oldIndicators.map((indicator) => [indicator.id, indicator]));
  const oldConflictsById = new Map(oldConflicts.map((conflict) => [conflict.id, conflict]));

  // 기준 선택 식별 맵 구성: (지표 정규화 이름, 기준 문서 id, 상대 문서 id)
  const baselineMap = new Map<string, IndicatorBaselineRecord>();
  for (const b of oldBaselines) {
    const ind = oldIndicatorsById.get(b.indicator_id);
    if (!ind) continue;
    const normName = normalizeIndicatorName(ind.name);

    let otherDocId = b.other_doc_id;
    if (!otherDocId && b.conflict_id) {
      const conf = oldConflictsById.get(b.conflict_id);
      if (conf) {
        otherDocId = b.document_id === conf.doc_a_id ? conf.doc_b_id : conf.doc_a_id;
      }
    }
    if (!otherDocId) {
      const conf = oldConflicts.find(
        (c) =>
          c.indicator_id === b.indicator_id &&
          (c.doc_a_id === b.document_id || c.doc_b_id === b.document_id)
      );
      if (conf) {
        otherDocId = b.document_id === conf.doc_a_id ? conf.doc_b_id : conf.doc_a_id;
      }
    }

    if (otherDocId) {
      // Natural indicator names may change during a PDM refresh. Bind a saved
      // selection to its old indicator id and document pair until rematching.
      baselineMap.set(`${b.indicator_id}\u0000${b.document_id}\u0000${otherDocId}`, b);
    }
  }

  // 신규 지표 레코드 구성:
  // 자연 키 = (단계, 정규화 지표 이름, 정규화 OVI) 로 기존 행 매칭
  // 기존 DB 에 같은 키 행이 여럿이면 이력(확정, 제안 등) 있는 행을 우선 매칭 (#19 2회차)
  const usedOldIds = new Set<string>();
  const oldByKey = new Map<string, IndicatorRecord[]>();
  for (const indicator of oldIndicators) {
    const key = getIndicatorNaturalKey(indicator.level, indicator.name, indicator.ovi);
    const group = oldByKey.get(key) ?? [];
    group.push(indicator);
    oldByKey.set(key, group);
  }
  const ambiguousIds = [...oldByKey.values()].filter((group) => group.length > 1).flatMap((group) => group.map((item) => item.id));
  const historyScores = getIndicatorHistoryScores(ambiguousIds, db);
  const sourceParagraphs = getParagraphsByDocument(pdmDoc.id, db);
  const rowForIndicator = (indicator: IndicatorRecord | ParsedPathwayItem): string | null => {
    const location = indicator.source_location;
    const candidates = sourceParagraphs.filter((paragraph) => {
      if (paragraph.table_row == null) return false;
      if (location && paragraph.location === location) return true;
      const content = normalizeIndicatorName(paragraph.content);
      return content === normalizeIndicatorName(indicator.name) || content === normalizeIndicatorName(indicator.ovi);
    });
    const rows = [...new Set(candidates.map((paragraph) => `${paragraph.table_index ?? 0}:${paragraph.table_row}`))];
    return rows.length === 1 ? rows[0] : null;
  };
  const nameSimilarity = (left: string, right: string): number => {
    const a = normalizeIndicatorName(left);
    const b = normalizeIndicatorName(right);
    if (!a || !b) return 0;
    if (a === b) return 1;
    const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
    for (let i = 1; i <= a.length; i++) {
      let diagonal = previous[0];
      previous[0] = i;
      for (let j = 1; j <= b.length; j++) {
        const above = previous[j];
        previous[j] = Math.min(previous[j] + 1, previous[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
        diagonal = above;
      }
    }
    return 1 - previous[b.length] / Math.max(a.length, b.length);
  };
  const newRecords: IndicatorRecord[] = [];
  const keyChangedMatchedIds = new Set<string>();
  let parentId: string | null = null;
  for (const item of parsedItems) {
    const itemKey = getIndicatorNaturalKey(item.level, item.name, item.ovi);

    const candidates = (oldByKey.get(itemKey) ?? []).filter((i) => !usedOldIds.has(i.id) && (!i.source_doc_id || i.source_doc_id === pdmDoc.id));

    let matchedOld: IndicatorRecord | undefined;
    if (candidates.length === 1) {
      matchedOld = candidates[0];
    } else if (candidates.length > 1) {
      // 기존 DB 에 같은 키 행이 여럿이면 이력 있는 행을 우선 매칭
      matchedOld = [...candidates].sort((a, b) => {
        const scoreA = historyScores.get(a.id) ?? 0;
        const scoreB = historyScores.get(b.id) ?? 0;
        if (scoreB !== scoreA) {
          return scoreB - scoreA;
        }
        return (a.sort_order ?? 0) - (b.sort_order ?? 0);
      })[0];
    }

    // When the natural key changed, preserve history only for a unique row and
    // a sufficiently similar name in the same PDM document. Ambiguous matches
    // intentionally remain orphaned for human review.
    if (!matchedOld) {
      const newRow = rowForIndicator(item);
      if (newRow != null) {
        const ranked = oldIndicators
          .filter((old) => !usedOldIds.has(old.id) && old.source_doc_id === pdmDoc.id && rowForIndicator(old) === newRow)
          .map((old) => ({ old, score: Math.max(
            nameSimilarity(old.name, item.name),
            nameSimilarity(old.name, item.ovi),
            nameSimilarity(old.ovi, item.name),
            nameSimilarity(old.ovi, item.ovi)
          ) }))
          .filter(({ score }) => score >= 0.72)
          .sort((a, b) => b.score - a.score);
        if (ranked.length && (ranked.length === 1 || ranked[0].score - ranked[1].score >= 0.12)) {
          matchedOld = ranked[0].old;
          keyChangedMatchedIds.add(matchedOld.id);
        }
      }
    }

    const indId = matchedOld?.id ?? `ind-${crypto.randomUUID().slice(0, 8)}`;
    if (matchedOld) {
      usedOldIds.add(matchedOld.id);
    }

    const indRecord: IndicatorRecord = {
      id: indId,
      project_id: projectId,
      level: item.level,
      name: item.name,
      ovi: item.ovi,
      mov: item.mov,
      target_value: item.target_value,
      parent_id: parentId,
      source_doc_id: item.source_doc_id,
      source_location: item.source_location,
      sort_order: item.sort_order,
      is_baseline: 0,
      is_unknown_level: item.is_unknown_level,
      is_orphaned: 0,
      created_at: matchedOld?.created_at ?? new Date().toISOString(),
    };
    newRecords.push(indRecord);
    parentId = indId;
  }

  // 충돌 재탐지 (모든 포함된 계획 문서 대상, 지표 이름 정규화 완전 일치)
  const newConflicts = detectConflicts(projectId, newRecords, documents, parsedItems, db);

  // 기준 재부착: 기준을 (지표 정규화 이름, 기준 문서 id, 상대 문서 id) 로 식별해 정확히 같은 충돌에만 다시 붙인다
  const baselinesToKeep: IndicatorBaselineRecord[] = [];
  for (const nc of newConflicts) {
    const ind = newRecords.find((i) => i.id === nc.indicator_id);
    if (!ind) continue;

    const keyA = `${ind.id}\u0000${nc.doc_a_id}\u0000${nc.doc_b_id}`;
    const keyB = `${ind.id}\u0000${nc.doc_b_id}\u0000${nc.doc_a_id}`;
    const oldBaseline = baselineMap.get(keyA) ?? baselineMap.get(keyB);
    if (oldBaseline) {
      const isDocA = oldBaseline.document_id === nc.doc_a_id;
      const targetVal = isDocA ? nc.doc_a_value : nc.doc_b_value;
      const docName = isDocA ? nc.doc_a_name : nc.doc_b_name;
      const otherDocId = isDocA ? nc.doc_b_id : nc.doc_a_id;

      baselinesToKeep.push({
        id: oldBaseline.id,
        project_id: projectId,
        indicator_id: ind.id,
        document_id: oldBaseline.document_id,
        document_name: docName,
        target_value: targetVal,
        selected_at: oldBaseline.selected_at,
        conflict_id: nc.id,
        other_doc_id: otherDocId,
      });
    }
  }

  // Keep selections whose former conflict disappeared. The UI marks these as
  // requiring review; retaining them avoids silently discarding a human choice.
  const keptBaselineIds = new Set(baselinesToKeep.map((baseline) => baseline.id));
  for (const oldBaseline of oldBaselines) {
    if (keptBaselineIds.has(oldBaseline.id)) continue;
    const oldIndicator = oldIndicatorsById.get(oldBaseline.indicator_id);
    const rematched = oldIndicator && newRecords.find((indicator) => indicator.id === oldIndicator.id);
    const remainsUnmatched = oldIndicator && !newRecords.some((indicator) => indicator.id === oldIndicator.id);
    const alreadyNeedsReview = !oldBaseline.conflict_id && includedDocumentIds.has(oldBaseline.document_id);
    const priorPairStillIncluded = Boolean(oldBaseline.other_doc_id && includedDocumentIds.has(oldBaseline.document_id) && includedDocumentIds.has(oldBaseline.other_doc_id));
    const priorConflictGone = priorPairStillIncluded && !newConflicts.some((conflict) =>
      conflict.indicator_id === (rematched?.id ?? oldBaseline.indicator_id) &&
      ((conflict.doc_a_id === oldBaseline.document_id && conflict.doc_b_id === oldBaseline.other_doc_id) ||
        (conflict.doc_b_id === oldBaseline.document_id && conflict.doc_a_id === oldBaseline.other_doc_id))
    );
    if (oldIndicator && ((rematched && keyChangedMatchedIds.has(oldIndicator.id)) || remainsUnmatched || alreadyNeedsReview || priorConflictGone)) {
      baselinesToKeep.push({ ...oldBaseline, project_id: projectId, conflict_id: null });
    }
  }

  // 통째로 다시 생성 (트랜잭션)
  replaceProjectToc(projectId, newRecords, newConflicts, baselinesToKeep, db);

  return getTocData(projectId, db);
}


/** Read an existing ToC until one of its source documents actually changes. */
export function getOrSyncTocForProject(
  projectId: string,
  db: Parameters<typeof replaceProjectToc>[4] = getDatabase()
): TocPageData | null {
  return withTocSourceFingerprint(projectId, db, () => syncTocForProject(projectId, db), () => getTocData(projectId, db));
}
