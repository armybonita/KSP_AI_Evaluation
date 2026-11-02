import { DocType } from '../store';

export interface ClassifyInput {
  fileName?: string; // 파일 이름은 분류·제외 판정에 쓰지 않음 (내용만 사용)
  paragraphs: Array<{ sequence_no: number; location: string; content: string }>;
  status: '추출 완료' | '읽지 못함';
  projectName?: string | null;
  projectPeriod?: { start: string; end: string; raw?: string } | string | null;
}

export interface ClassifyResult {
  docType: DocType;
  readStatus: '추출 완료' | '읽지 못함';
  isIncluded: boolean;
  excludedReason: string | null;
}

export interface ProjectPlanInfo {
  projectName: string | null;
  projectPeriod: {
    start: string;
    end: string;
    raw: string;
  } | null;
}

/**
 * 사업계획서 본문으로부터 사업명과 사업 기간 추출
 * - 제목 줄·'사업명'·'사업 기간' 표기 규칙
 */
export function extractProjectPlanInfo(
  paragraphs: Array<{ content: string }>
): ProjectPlanInfo {
  let projectName: string | null = null;
  let projectPeriod: ProjectPlanInfo['projectPeriod'] = null;

  // 1. 사업명 추출 (제목 줄·'사업명' 표기 규칙)
  // (a) 명시적 '사업명: ' 표기 검색
  for (const p of paragraphs.slice(0, 10)) {
    const text = p.content.trim();
    const match = text.match(/(?:^|\n)\s*사업명\s*[:：]\s*([^\n\r]+)/);
    if (match) {
      const rawName = match[1].trim();
      const cleaned = rawName.replace(/\s*\([^)]*\)$/, '').trim();
      if (cleaned.length > 0) {
        projectName = cleaned;
        break;
      }
    }
  }

  // (b) 제목 줄 규칙 (첫 번째 유효 문단에서 '사업계획서' / '추진계획서' 등 접미사 제거)
  if (!projectName && paragraphs.length > 0) {
    const firstNonEmpty = paragraphs.find((p) => p.content.trim().length > 0)?.content.trim() || '';
    const titleMatch = firstNonEmpty.match(/^(.*?)(?:\s*사업\s*계획서|\s*추진\s*계획서|\s*계획서)$/);
    if (titleMatch && titleMatch[1].trim().length > 0) {
      projectName = titleMatch[1].trim();
    } else if (firstNonEmpty.endsWith('사업')) {
      projectName = firstNonEmpty;
    }
  }

  // 2. 사업 기간 추출 ('사업 기간' 표기 규칙)
  for (const p of paragraphs.slice(0, 10)) {
    const text = p.content.trim();
    const match = text.match(/(?:^|\n)\s*사업\s*기간\s*[:：]\s*([^\n\r]+)/);
    if (match) {
      const raw = match[1].trim();
      const dateMatches = Array.from(raw.matchAll(/(20\d{2}|19\d{2})[.\-/년\s]*(\d{1,2})?/g));
      if (dateMatches.length >= 2) {
        const startYear = dateMatches[0][1];
        const startMonth = dateMatches[0][2] ? dateMatches[0][2].padStart(2, '0') : '01';
        const endYear = dateMatches[1][1];
        const endMonth = dateMatches[1][2] ? dateMatches[1][2].padStart(2, '0') : '12';
        projectPeriod = {
          start: `${startYear}.${startMonth}`,
          end: `${endYear}.${endMonth}`,
          raw,
        };
        break;
      } else if (dateMatches.length === 1) {
        const year = dateMatches[0][1];
        const month = dateMatches[0][2] ? dateMatches[0][2].padStart(2, '0') : '01';
        projectPeriod = {
          start: `${year}.${month}`,
          end: `${year}.12`,
          raw,
        };
        break;
      }
    }
  }

  return { projectName, projectPeriod };
}

/**
 * 텍스트 내에 추출된 사업 기간과 겹치는 날짜가 있는지 검사
 */
export function hasOverlappingDateWithPeriod(
  text: string,
  period: { start: string; end: string } | string | null | undefined
): boolean {
  if (!period) return false;

  let startYear = 0;
  let startMonth = 1;
  let endYear = 9999;
  let endMonth = 12;

  if (typeof period === 'string') {
    const dateMatches = Array.from(period.matchAll(/(20\d{2}|19\d{2})[.\-/년\s]*(\d{1,2})?/g));
    if (dateMatches.length >= 2) {
      startYear = parseInt(dateMatches[0][1], 10);
      startMonth = dateMatches[0][2] ? parseInt(dateMatches[0][2], 10) : 1;
      endYear = parseInt(dateMatches[1][1], 10);
      endMonth = dateMatches[1][2] ? parseInt(dateMatches[1][2], 10) : 12;
    } else if (dateMatches.length === 1) {
      startYear = parseInt(dateMatches[0][1], 10);
      startMonth = dateMatches[0][2] ? parseInt(dateMatches[0][2], 10) : 1;
      endYear = startYear;
      endMonth = 12;
    } else {
      return false;
    }
  } else {
    const [sY, sM] = period.start.split('.').map((v) => parseInt(v, 10));
    const [eY, eM] = period.end.split('.').map((v) => parseInt(v, 10));
    startYear = sY;
    startMonth = sM || 1;
    endYear = eY;
    endMonth = eM || 12;
  }

  const startVal = startYear * 100 + startMonth;
  const endVal = endYear * 100 + endMonth;

  // 본문에서 날짜 추출 (YYYY.MM.DD, YYYY.MM, YYYY년 MM월, YYYY 등)
  const matches = Array.from(text.matchAll(/(?:^|[^\d])(20\d{2}|19\d{2})(?:[.\-/년\s]+([0-1]?\d))?/g));
  for (const m of matches) {
    const y = parseInt(m[1], 10);
    const mo = m[2] ? parseInt(m[2], 10) : undefined;
    if (mo !== undefined && mo >= 1 && mo <= 12) {
      const val = y * 100 + mo;
      if (val >= startVal && val <= endVal) {
        return true;
      }
    } else {
      // 월이 없는 연도 언급
      if (y >= startYear && y <= endYear) {
        return true;
      }
    }
  }

  return false;
}

/**
 * PoC 규칙 기반 문서 분류 및 기본 제외 판단 (RQ-04, RQ-05, D02, D14, D29, #18 검수 반영)
 * - 파일 이름은 분류·제외 판정에 쓰지 않음 (내용만 사용)
 * - 가상국·가상사업·디지털 특례 및 고정 기간 하드코딩 제거
 * - 사업계획서가 없으면 다른 사업·무관 판정 유보
 * - 다른 사업 자료 = 다른 사업명이 나오고 이 사업명이 안 나옴
 * - 무관 문서 = 이 사업명도 이 사업 기간(뽑은 기간과 겹치는 날짜)도 없음
 */
export function classifyDocument(input: ClassifyInput): ClassifyResult {
  const { paragraphs, status, projectName, projectPeriod } = input;
  const readStatus = status === '읽지 못함' || paragraphs.length === 0 ? '읽지 못함' : '추출 완료';

  // 1. 읽기 상태는 기본 제외 분류와 분리한다(RQ-06).
  if (readStatus === '읽지 못함') {
    return {
      docType: '기타',
      readStatus,
      isIncluded: true,
      excludedReason: null,
    };
  }

  const fullText = paragraphs.map((p) => p.content).join(' ');
  const firstParagraph = paragraphs[0]?.content || '';

  // 2. 개인 서류 판단 (RQ-05)
  // 내용(fullText)만 기반으로 검사 (파일명 미사용)
  const personalRegex = /(여비\s*정산|출장\s*여비|실비\s*영수증|이력서|개인\s*서류|자기소개서|주민등록번호|\b\d{6}-[1-4]\d{6}\b)/;
  if (personalRegex.test(fullText)) {
    let detail = '';
    if (/출장\s*여비\s*정산|여비\s*정산/.test(fullText)) {
      detail = '(출장 여비 정산 신청서)';
    } else if (/이력서/.test(fullText)) {
      detail = '(이력서)';
    }
    return {
      docType: '기타',
      readStatus,
      isIncluded: false,
      excludedReason: `개인 서류${detail}`,
    };
  }

  // 3 & 4. 다른 사업 자료 및 무관 문서 판단
  // 사업계획서가 등록되어 사업명이 있을 때만 판정 수행 (사업계획서가 없으면 판정하지 않음)
  if (projectName && projectName.trim().length > 0) {
    const cleanProjectName = projectName.trim();
    const normalizedProjectName = cleanProjectName.replace(/\s+/g, '');
    const normalizedFull = fullText.replace(/\s+/g, '');

    const mentionsThisProject = normalizedFull.includes(normalizedProjectName);

    // 이 사업명이 본문에 나오지 않는 경우
    if (!mentionsThisProject) {
      // 3. 다른 사업 자료 판단: 다른 사업명이 나오고 이 사업명이 안 나옴
      let detectedOtherProject: string | null = null;

      // (a) 본문 내 명시적 '사업명: ...' 검색
      for (const para of paragraphs.slice(0, 5)) {
        const m = para.content.trim().match(/(?:^|\n)\s*사업명\s*[:：]\s*([^\n\r]+)/);
        if (m) {
          const cand = m[1].trim().replace(/\s*\([^)]*\)$/, '').trim();
          const normCand = cand.replace(/\s+/g, '');
          if (
            normCand !== normalizedProjectName &&
            !normalizedProjectName.includes(normCand) &&
            !/^(?:본|당해|해당|타|다른)\s*사업/.test(cand)
          ) {
            detectedOtherProject = cand;
            break;
          }
        }
      }

      // (b) 문서 앞부분(제목 줄 등)에서 사업명 패턴 탐색
      if (!detectedOtherProject) {
        for (const para of paragraphs.slice(0, 3)) {
          const text = para.content.trim();
          if (/^(?:본|당해|해당|타|다른)\s*사업/.test(text)) continue;

          const match = text.match(
            /^([가-힣A-Za-z0-9\s]+?(?:구축사업|정보시스템\s*구축사업|지원사업|역량강화사업|개발사업|혁신사업|사업))(?:\s+(?:완료보고서|결과보고서|보고서|계획서|사업계획서|안내서))?/
          );
          if (match) {
            const candidateName = match[1].trim();
            const normalizedCandidate = candidateName.replace(/\s+/g, '');
            if (
              !/^(?:본|당해|해당|타|다른)\s*사업/.test(candidateName) &&
              normalizedCandidate !== normalizedProjectName &&
              !normalizedProjectName.includes(normalizedCandidate)
            ) {
              detectedOtherProject = candidateName;
              break;
            }
          }
        }
      }

      if (!detectedOtherProject && /타\s*사업\s*자료|다른\s*사업\s*자료/.test(fullText)) {
        detectedOtherProject = '타 사업 자료';
      }

      if (detectedOtherProject) {
        return {
          docType: '기타',
          readStatus,
          isIncluded: false,
          excludedReason:
            detectedOtherProject === '타 사업 자료'
              ? '다른 사업 자료'
              : `다른 사업 자료(${detectedOtherProject})`,
        };
      }

      // 4. 무관 문서 판단: 이 사업명도 이 사업 기간(뽑은 기간과 겹치는 날짜)도 없음
      const hasOverlappingDate = hasOverlappingDateWithPeriod(fullText, projectPeriod);
      if (!hasOverlappingDate) {
        return {
          docType: '기타',
          readStatus,
          isIncluded: false,
          excludedReason: '무관 문서(사업명과 사업 기간 모두 미언급)',
        };
      }
    }
  }

  // 5. 포함 문서 종류 분류 (내용만 검색)
  // 사업계획서 / 성과관리표 / 출장결과보고서 / 심사 의견 / 반영비교표 / 기타
  const searchCorpus = `${firstParagraph} ${fullText}`;

  if (/성과관리표|PDM|성과관리/.test(searchCorpus)) {
    return {
      docType: '성과관리표',
      readStatus,
      isIncluded: true,
      excludedReason: null,
    };
  }

  if (/사업계획서|사업\s*계획서|추진계획서/.test(searchCorpus)) {
    return {
      docType: '사업계획서',
      readStatus,
      isIncluded: true,
      excludedReason: null,
    };
  }

  if (/출장결과보고서|출장결과|출장보고서|현지실사/.test(searchCorpus)) {
    return {
      docType: '출장결과보고서',
      readStatus,
      isIncluded: true,
      excludedReason: null,
    };
  }

  if (/심사\s*의견|심사의견|검토의견/.test(searchCorpus)) {
    return {
      docType: '심사 의견',
      readStatus,
      isIncluded: true,
      excludedReason: null,
    };
  }

  if (/반영비교표|조치계획/.test(searchCorpus)) {
    return {
      docType: '반영비교표',
      readStatus,
      isIncluded: true,
      excludedReason: null,
    };
  }

  return {
    docType: '기타',
    readStatus,
    isIncluded: true,
    excludedReason: null,
  };
}

export { maskForbiddenSentenceInContent } from '../store/citation-ban';
