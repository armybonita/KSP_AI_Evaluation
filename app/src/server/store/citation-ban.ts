import type Database from 'better-sqlite3';

/**
 * 인용 금지 감지 규칙 목록 (RQ-14, D01, NOTES)
 * 한 곳(설정 배열)에 두고 모든 감지 및 마스킹에서 공유
 */
export const CITATION_BAN_RULES: readonly RegExp[] = [
  /이름을\s*밝히지\s*말아/,
  /익명(?:을)?\s*요청/,
  /익명(?:을)?\s*요구/,
  /익명으로\s*요구/,
  /신원\s*비공개/,
  /비보도/,
];

/**
 * "이름을 밝히지 말아 달라" 취지 문장 여부 확인 (RQ-14, D01)
 */
export function isCitationBannedSentence(sentence: string): boolean {
  if (!sentence) return false;
  return CITATION_BAN_RULES.some((pattern) => pattern.test(sentence));
}

/**
 * 인용 금지 문장 마스킹 (RQ-14, D01, D06, #20 검수 3회차 2번)
 * "이름을 밝히지 말아 달라"는 취지의 문장 및 해당 사업 금지 문장(8자 이상 겹침)은
 * 화면 S2 미리보기 및 S4 [원문 위치 열기]에서 "[인용 금지 문장]"으로 가린다.
 */
export function maskForbiddenSentenceInContent(
  content: string,
  bannedSentences: string[] = [],
  overlaps: (text: string) => boolean = (text) => hasForbiddenSentenceOverlap(text, bannedSentences, 8)
): string {
  if (!content) return '';

  const sentenceRegex = /[^.!?\n]+(?:[.!?\n]+|$)/g;
  return content.replace(sentenceRegex, (sentence) => {
    const trimmed = sentence.trim();
    if (!trimmed) return sentence;

    const isBanned =
      isCitationBannedSentence(trimmed) ||
      (bannedSentences.length > 0 && overlaps(trimmed));

    if (isBanned) {
      const leading = sentence.match(/^\s*/)?.[0] ?? '';
      return leading + '[인용 금지 문장]';
    }
    return sentence;
  });
}

export interface SplitSentenceItem {
  sequence_no: number;
  location: string;
  content: string;
  is_citation_banned: number;
}

/**
 * 문단을 문장 단위로 분할하고 인용 금지 여부 플래그 부여 (추출 단계)
 */
export function splitParagraphIntoSentences(
  paragraphContent: string,
  location: string,
  startSequenceNo: number = 1
): SplitSentenceItem[] {
  if (!paragraphContent || paragraphContent.trim().length === 0) {
    return [];
  }

  // 문장 분할 정규식 (마침표, 물음표, 느낌표, 줄바꿈 기준)
  const matches = paragraphContent.match(/[^.!?\n]+(?:[.!?\n]+|$)/g);
  if (!matches || matches.length === 0) {
    const isBanned = isCitationBannedSentence(paragraphContent) ? 1 : 0;
    return [
      {
        sequence_no: startSequenceNo,
        location,
        content: paragraphContent.trim(),
        is_citation_banned: isBanned,
      },
    ];
  }

  const result: SplitSentenceItem[] = [];
  let seq = startSequenceNo;

  for (const raw of matches) {
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;

    const isBanned = isCitationBannedSentence(trimmed) ? 1 : 0;
    result.push({
      sequence_no: seq++,
      location,
      content: trimmed,
      is_citation_banned: isBanned,
    });
  }

  return result;
}

/** Request-scoped index of exactly the windows used by the original overlap rule. */
export function createForbiddenSentenceIndex(bannedSentences: string[], minLength = 8) {
  const raw = new Set<string>();
  const lower = new Map<number, Set<string>>();
  const normalized = new Set<string>();
  const normalizedLower = new Map<number, Set<string>>();
  // This index is request-scoped and its windows never change. A screen may
  // check the same quote in several views, so reuse its exact boolean result.
  const results = new Map<string, boolean>();
  const add = (value: string, exact: Set<string>, folded: Map<number, Set<string>>) => {
    for (let i = 0; i <= value.length - minLength; i++) {
      const part = value.slice(i, i + minLength);
      exact.add(part);
      const lowercase = part.toLowerCase();
      let bucket = folded.get(lowercase.length);
      if (!bucket) folded.set(lowercase.length, bucket = new Set());
      bucket.add(lowercase);
    }
  };
  for (const banned of bannedSentences) {
    const trimmed = banned.trim();
    if (trimmed.length < minLength) continue;
    add(trimmed, raw, lower);
    add(trimmed.replace(/\s+/g, ''), normalized, normalizedLower);
  }
  const contains = (value: string, exact: Set<string>, folded: Map<number, Set<string>>) => {
    for (let i = 0; i <= value.length - minLength; i++) {
      if (exact.has(value.slice(i, i + minLength))) return true;
    }
    const lowercase = value.toLowerCase();
    for (const [length, bucket] of folded) {
      for (let i = 0; i <= lowercase.length - length; i++) {
        if (bucket.has(lowercase.slice(i, i + length))) return true;
      }
    }
    return false;
  };
  return (text: string | null | undefined): boolean => {
    if (raw.size === 0 || !text || !text.trim()) return false;
    const cached = results.get(text);
    if (cached !== undefined) return cached;
    const result = contains(text, raw, lower) || contains(text.replace(/\s+/g, ''), normalized, normalizedLower);
    // Bound retained strings; skipping a cache entry never skips a check.
    if (results.size < 50000 && text.length <= 4096) results.set(text, result);
    return result;
  };
}

export type ForbiddenSentenceIndex = ReturnType<typeof createForbiddenSentenceIndex>;

/**
 * 8자 이상 겹치는 부분이 있는지 검사 (RQ-14, D01)
 */
export function hasForbiddenSentenceOverlap(
  text: string | null | undefined,
  bannedSentences: string[],
  minLength: number = 8
): boolean {
  if (!text || text.trim().length === 0) return false;
  if (!bannedSentences || bannedSentences.length === 0) return false;
  const lowerText = text.toLowerCase();
  let normText: string | undefined;
  let lowerNormText: string | undefined;

  for (const banned of bannedSentences) {
    const trimmedBanned = banned.trim();
    if (trimmedBanned.length < minLength) continue;

    // 1. 원문 부분 문자열 8자 이상 윈도우 검사
    for (let i = 0; i <= trimmedBanned.length - minLength; i++) {
      const sub = trimmedBanned.slice(i, i + minLength);
      if (text.includes(sub)) {
        return true;
      }
      if (lowerText.includes(sub.toLowerCase())) {
        return true;
      }
    }

    // 2. 공백 제거 정규화 검사 (띄어쓰기 변형 차단)
    normText ??= text.replace(/\s+/g, '');
    const normBanned = trimmedBanned.replace(/\s+/g, '');
    if (normBanned.length >= minLength) {
      for (let i = 0; i <= normBanned.length - minLength; i++) {
        const sub = normBanned.slice(i, i + minLength);
        if (normText.includes(sub)) {
          return true;
        }
        lowerNormText ??= normText.toLowerCase();
        if (lowerNormText.includes(sub.toLowerCase())) {
          return true;
        }
      }
    }
  }

  return false;
}

/** Precompute the same case-insensitive eight-character windows for repeated checks. */
export function createForbiddenSentenceMatcher(bannedSentences: string[], minLength = 8): (text: string) => boolean {
  const raw = new Set<string>();
  const compact = new Set<string>();
  for (const banned of bannedSentences) {
    const trimmed = banned.trim();
    if (trimmed.length < minLength) continue;
    const normalized = trimmed.replace(/\s+/g, '');
    for (let i = 0; i <= trimmed.length - minLength; i++) raw.add(trimmed.slice(i, i + minLength));
    for (let i = 0; i <= normalized.length - minLength; i++) compact.add(normalized.slice(i, i + minLength));
  }
  const pattern = (windows: Set<string>) => windows.size
    ? new RegExp([...windows].map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'))
    : null;
  const rawPattern = pattern(raw);
  const compactPattern = pattern(compact);
  const lowerRawPattern = pattern(new Set([...raw].map((window) => window.toLowerCase())));
  const lowerCompactPattern = pattern(new Set([...compact].map((window) => window.toLowerCase())));
  return (text) => {
    if (!text || text.trim().length === 0) return false;
    const normalized = text.replace(/\s+/g, '');
    return Boolean(rawPattern?.test(text) || lowerRawPattern?.test(text.toLowerCase()) ||
      compactPattern?.test(normalized) || lowerCompactPattern?.test(normalized.toLowerCase()));
  };
}

/** Replace any value overlapping a project-banned sentence with one fixed marker. */
export function maskTextIfForbiddenSentenceOverlap(
  text: string,
  bannedSentences: string[],
  minLength: number = 8
): string {
  return hasForbiddenSentenceOverlap(text, bannedSentences, minLength)
    ? '[인용 금지 문장]'
    : text;
}

/**
 * 근거 표시 가림 여부 판정 (RQ-14, D01, #20 검수 2회차 1번):
 * 플래그·대체 문구·정규식에 더해, 그 사업의 금지 문장과 8자 이상 겹치는지 대조해 가린다.
 */
export function isEvidenceCitationBanned(
  evidence: { quote?: string | null; speaker?: string | null; is_citation_banned?: number },
  bannedSentences: string[] = [],
  index?: ForbiddenSentenceIndex
): boolean {
  if (evidence.is_citation_banned === 1) return true;
  if (evidence.quote === '인용 금지 문장 있음') return true;
  if (isCitationBannedSentence(evidence.quote ?? '')) return true;
  if (isCitationBannedSentence(evidence.speaker ?? '')) return true;
  if (bannedSentences.length > 0) {
    if (index ? index(evidence.quote) : hasForbiddenSentenceOverlap(evidence.quote, bannedSentences, 8)) return true;
    if (index ? index(evidence.speaker) : hasForbiddenSentenceOverlap(evidence.speaker, bannedSentences, 8)) return true;
  }
  return false;
}

/**
 * 근거 표시 가림 처리 (RQ-14, D01, #20 검수 2회차 1번):
 * 가림 대상이면 quote를 '인용 금지 문장 있음', speaker를 '—', is_citation_banned를 1로 치환.
 */
export function maskEvidenceIfCitationBanned<
  T extends { quote: string; speaker: string; is_citation_banned?: number }
>(evidence: T, bannedSentences: string[] = [], index?: ForbiddenSentenceIndex): T {
  if (!isEvidenceCitationBanned(evidence, bannedSentences, index)) {
    return evidence;
  }
  return {
    ...evidence,
    quote: '인용 금지 문장 있음',
    speaker: '—',
    is_citation_banned: 1,
  };
}

/**
 * 기존 DB 근거 이관 (한 번):
 * 사업별로(근거의 사업 = 그 근거가 속한 지표의 사업, 금지 문장의 사업 = 그 문단 문서의 사업) 대조.
 * 오류를 삼키지 않고 던진다 (#20 검수 2회차 2번)
 */
export function migrateExistingEvidencesForCitationBan(db: Database.Database): number {
  // 금지 문장의 사업 = 그 문단 문서의 사업 (sentences.paragraph_id → paragraphs.document_id → documents.project_id) (#20 검수 3회차 1번)
  const bannedStmt = db.prepare(`
    SELECT s.content, d.project_id
    FROM sentences s
    JOIN paragraphs p ON s.paragraph_id = p.id
    JOIN documents d ON p.document_id = d.id
    WHERE s.is_citation_banned = 1
  `);
  const bannedRows = bannedStmt.all() as Array<{ content: string; project_id: string }>;

  const bannedByProject = new Map<string, string[]>();
  for (const row of bannedRows) {
    let list = bannedByProject.get(row.project_id);
    if (!list) {
      list = [];
      bannedByProject.set(row.project_id, list);
    }
    list.push(row.content);
  }

  const indexesByProject = new Map([...bannedByProject].map(([project, sentences]) =>
    [project, createForbiddenSentenceIndex(sentences)]));

  // 근거의 사업 = 그 근거가 속한 지표의 사업
  const evStmt = db.prepare(`
    SELECT e.id, e.quote, e.speaker, e.is_citation_banned, i.project_id
    FROM evidences e
    LEFT JOIN suggestions s ON e.suggestion_id = s.id
    LEFT JOIN indicators i ON s.indicator_id = i.id
  `);
  const evidences = evStmt.all() as Array<{
    id: string;
    quote: string;
    speaker: string;
    is_citation_banned?: number;
    project_id: string | null;
  }>;

  let count = 0;
  const updateStmt = db.prepare(`
    UPDATE evidences
    SET is_citation_banned = 1,
        quote = '인용 금지 문장 있음',
        speaker = '—'
    WHERE id = ?
  `);

  for (const ev of evidences) {
    const projectBanned = ev.project_id ? (bannedByProject.get(ev.project_id) ?? []) : [];
    const index = ev.project_id ? indexesByProject.get(ev.project_id) : undefined;
    const isBanned = isEvidenceCitationBanned(ev, projectBanned, index);

    if (isBanned) {
      if (ev.is_citation_banned !== 1 || ev.quote !== '인용 금지 문장 있음' || ev.speaker !== '—') {
        updateStmt.run(ev.id);
        count++;
      }
    }
  }

  return count;
}

/**
 * 보고서 검사 함수: projectId로 거른다 (#20 검수 6번)
 */
export function findForbiddenTextViolationsInReports(
  db: Database.Database,
  projectId?: string
): string[] {
  const violations: string[] = [];

  let bannedSentences: string[] = [];
  if (projectId) {
    const stmt = db.prepare(`
      SELECT s.content
      FROM sentences s
      JOIN paragraphs p ON s.paragraph_id = p.id
      JOIN documents d ON p.document_id = d.id
      WHERE d.project_id = ? AND s.is_citation_banned = 1
    `);
    bannedSentences = (stmt.all(projectId) as { content: string }[]).map((r) => r.content);
  } else {
    const stmt = db.prepare(`SELECT content FROM sentences WHERE is_citation_banned = 1`);
    bannedSentences = (stmt.all() as { content: string }[]).map((r) => r.content);
  }

  if (bannedSentences.length === 0) {
    return [];
  }

  const reportTableCheck = db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='reports'`
  ).get();
  if (reportTableCheck) {
    const repQuery = projectId
      ? `SELECT * FROM reports WHERE project_id = ?`
      : `SELECT * FROM reports`;
    const repRows = (projectId
      ? db.prepare(repQuery).all(projectId)
      : db.prepare(repQuery).all()) as any[];

    for (const r of repRows) {
      for (const [k, v] of Object.entries(r)) {
        if (typeof v === 'string' && hasForbiddenSentenceOverlap(v, bannedSentences)) {
          violations.push(
            `[reports.${r.id}] ${k} 열에 인용 금지 문장 겹침: "${v}"`
          );
        }
      }
    }
  }

  return violations;
}

/**
 * 저장 영역(suggestions, evidences, confirmations, reports) 내 금지 문장 포함 여부 전수 검사
 * - 고정 문장 대체 삭제, 금지 문장 0개면 검사 대상 없음으로 정상(0건) (#20 검수 4번)
 * - quote 뿐 아니라 근거의 모든 텍스트 필드(quote, speaker, location)와 제안 문장을 본다 (#20 검수 2번)
 * - 조회 오류를 삼키지 않고 던진다 (#20 검수 4번)
 */
export function findForbiddenTextViolationsInStore(
  db: Database.Database,
  projectId?: string
): string[] {
  const violations: string[] = [];

  let bannedSentences: string[] = [];
  if (projectId) {
    const stmt = db.prepare(`
      SELECT s.content
      FROM sentences s
      JOIN paragraphs p ON s.paragraph_id = p.id
      JOIN documents d ON p.document_id = d.id
      WHERE d.project_id = ? AND s.is_citation_banned = 1
    `);
    bannedSentences = (stmt.all(projectId) as { content: string }[]).map((r) => r.content);
  } else {
    const stmt = db.prepare(`SELECT content FROM sentences WHERE is_citation_banned = 1`);
    bannedSentences = (stmt.all() as { content: string }[]).map((r) => r.content);
  }

  // 금지 문장이 0개면 검사 대상 없음으로 정상(0건) 반환 (고정 문장 대체 삭제)
  if (bannedSentences.length === 0) {
    return [];
  }

  // 1. suggestions (proposal_text, error_reason)
  const suggQuery = projectId
    ? `SELECT s.id, s.proposal_text, s.error_reason, i.name as ind_name FROM suggestions s JOIN indicators i ON s.indicator_id = i.id WHERE i.project_id = ?`
    : `SELECT s.id, s.proposal_text, s.error_reason, i.name as ind_name FROM suggestions s JOIN indicators i ON s.indicator_id = i.id`;
  const suggs = (projectId
    ? db.prepare(suggQuery).all(projectId)
    : db.prepare(suggQuery).all()) as Array<{
    id: string;
    proposal_text: string | null;
    error_reason: string | null;
    ind_name: string;
  }>;

  for (const s of suggs) {
    if (s.proposal_text && hasForbiddenSentenceOverlap(s.proposal_text, bannedSentences)) {
      violations.push(
        `[suggestions.${s.id}] proposal_text에 인용 금지 문장 겹침 (지표: ${s.ind_name}): "${s.proposal_text}"`
      );
    }
    if (s.error_reason && hasForbiddenSentenceOverlap(s.error_reason, bannedSentences)) {
      violations.push(
        `[suggestions.${s.id}] error_reason에 인용 금지 문장 겹침 (지표: ${s.ind_name}): "${s.error_reason}"`
      );
    }
  }

  // 2. evidences (quote, speaker, location - 공용 검사는 근거의 모든 텍스트 필드를 본다)
  const evQuery = projectId
    ? `SELECT e.id, e.quote, e.speaker, e.location, e.is_citation_banned, i.name as ind_name FROM evidences e JOIN suggestions s ON e.suggestion_id = s.id JOIN indicators i ON s.indicator_id = i.id WHERE i.project_id = ?`
    : `SELECT e.id, e.quote, e.speaker, e.location, e.is_citation_banned, i.name as ind_name FROM evidences e JOIN suggestions s ON e.suggestion_id = s.id JOIN indicators i ON s.indicator_id = i.id`;
  const evs = (projectId
    ? db.prepare(evQuery).all(projectId)
    : db.prepare(evQuery).all()) as Array<{
    id: string;
    quote: string;
    speaker: string;
    location: string;
    is_citation_banned?: number;
    ind_name: string;
  }>;

  for (const e of evs) {
    if (hasForbiddenSentenceOverlap(e.quote, bannedSentences)) {
      violations.push(
        `[evidences.${e.id}] quote에 인용 금지 문장 겹침 (지표: ${e.ind_name}): "${e.quote}"`
      );
    }
    if (hasForbiddenSentenceOverlap(e.speaker, bannedSentences)) {
      violations.push(
        `[evidences.${e.id}] speaker에 인용 금지 문장 겹침 (지표: ${e.ind_name}): "${e.speaker}"`
      );
    }
    if (hasForbiddenSentenceOverlap(e.location, bannedSentences)) {
      violations.push(
        `[evidences.${e.id}] location에 인용 금지 문장 겹침 (지표: ${e.ind_name}): "${e.location}"`
      );
    }
  }

  // 3. confirmations (initial_proposal, edited_text, reason, confirmer_name)
  const confQuery = projectId
    ? `SELECT c.id, c.initial_proposal, c.edited_text, c.reason, c.confirmer_name, i.name as ind_name FROM confirmations c JOIN indicators i ON c.indicator_id = i.id WHERE i.project_id = ?`
    : `SELECT c.id, c.initial_proposal, c.edited_text, c.reason, c.confirmer_name, i.name as ind_name FROM confirmations c JOIN indicators i ON c.indicator_id = i.id`;
  const confs = (projectId
    ? db.prepare(confQuery).all(projectId)
    : db.prepare(confQuery).all()) as Array<{
    id: string;
    initial_proposal: string | null;
    edited_text: string | null;
    reason: string | null;
    confirmer_name: string;
    ind_name: string;
  }>;

  for (const c of confs) {
    if (c.initial_proposal && hasForbiddenSentenceOverlap(c.initial_proposal, bannedSentences)) {
      violations.push(
        `[confirmations.${c.id}] initial_proposal에 인용 금지 문장 겹침: "${c.initial_proposal}"`
      );
    }
    if (c.edited_text && hasForbiddenSentenceOverlap(c.edited_text, bannedSentences)) {
      violations.push(
        `[confirmations.${c.id}] edited_text에 인용 금지 문장 겹침: "${c.edited_text}"`
      );
    }
    if (c.reason && hasForbiddenSentenceOverlap(c.reason, bannedSentences)) {
      violations.push(
        `[confirmations.${c.id}] reason에 인용 금지 문장 겹침: "${c.reason}"`
      );
    }
    if (c.confirmer_name && hasForbiddenSentenceOverlap(c.confirmer_name, bannedSentences)) {
      violations.push(
        `[confirmations.${c.id}] confirmer_name에 인용 금지 문장 겹침: "${c.confirmer_name}"`
      );
    }
  }

  // 4. reports (projectId 로 거른 보고서 검사)
  const reportViolations = findForbiddenTextViolationsInReports(db, projectId);
  violations.push(...reportViolations);

  return violations;
}

/**
 * 저장 영역 0건 단언 함수 (공용 검사 함수)
 */
export function assertZeroForbiddenTextInStore(
  db: Database.Database,
  projectId?: string
): void {
  const violations = findForbiddenTextViolationsInStore(db, projectId);
  if (violations.length > 0) {
    throw new Error(
      `인용 금지 문장이 저장 영역에서 0건이어야 하나 ${violations.length}건 검출되었습니다:\n` +
        violations.map((v) => `  - ${v}`).join('\n')
    );
  }
}
