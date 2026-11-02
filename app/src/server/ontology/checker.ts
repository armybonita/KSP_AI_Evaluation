import fs from 'node:fs';
import path from 'node:path';
import { extractLinks, parseMarkdownNote } from './markdown';
import type { OntologyIssue, OntologyNote } from './types';

export const VOCAB: Record<string, Set<string>> = {
  evidence_level: new Set(['입증', '관측', '추정', '예견']),
  category: new Set(['협력부처', '정책의제', '산출물', '성과경로', '리스크', '후속연계', '벤치마크']),
  speaker: new Set(['협력국', '수행기관', 'KDI', '참여기관', '제3자']),
  evidence_kind: new Set(['활동결과보고서', '점검회의록', '발표자료', '자문보고서', '설문', '인터뷰', '종료보고서', '후속연계계획서', '실증결과보고서', '공문·관보', '언론', '기타']),
  doc_type: new Set(['착수보고회결과보고서', '출장결과보고서', '점검회의록', '발표자료', '저자응답서·반영비교표', '중간보고서', '최종보고서', '자문보고서', '중간평가결과', '종료평가인터뷰', '종료보고서', '후속연계계획서', '실증결과보고서', '계약·행정', '평가양식', '종료평가보고서', '기타']),
  me_stage: new Set(['사전평가', '중간평가', '종료평가', '통합종료평가', '환류', '사후모니터링']),
  approved_ai: new Set(['none', 'local-only', 'external-chat', 'solar']),
  status: new Set(['ai-draft', 'draft', 'reviewed', 'approved', 'retired']),
  review_state: new Set(['미검토', '수정 중', '수정 의견', '확정', '수정 후 확정', '보완 필요', '채택 제외']),
  outcome_state_ai: new Set(['관측됨', '추진 중', '기대/추정', '미확인']),
  outcome_state: new Set(['관측됨', '추진 중', '기대/추정', '미확인']),
  outcome_family: new Set(['협력국 정책 반영', '개발협력 촉진', '경제협력 촉진', '지식 네트워킹']),
  outcome_type: new Set(['만족도', '역량강화', '단기정책형성', '중장기정책형성', '정책도입', '후속사업연계', '민간경제협력', '부수적성과']),
  eipp_class: new Set(['재원연계형', '정책수립·집행촉진형', '교역·교류촉진형', '부수적성과']),
  error_type: new Set(['성과 과장', '근거 부족', '시점 혼동', '주체 혼동', '외부 자료 혼입', '산출물·성과 혼동', '수치 오류', '누락', '기타']),
  factor_scope: new Set(['내부', '외부']),
  pdm_stage: new Set(['투입', '활동', '산출물', '단기성과', '중장기성과', '영향']),
  timing: new Set(['N', 'N+1', 'N+2', 'N+3']),
  screen: new Set(['EV04', 'EV05', 'EV06', 'EV07']),
  output_type: new Set(['제언', '네트워크', '실증시스템']),
  factor_class: new Set(['고위급의지', '담당자역량', '시의성', '수행기관전문성', '재원연계', '설계', '정권·인사교체', '예산부족', '정치·경제불안', '현지적용성', '행정절차', '기타']),
  institution_type: new Set(['공공기관', '대학(산학협력단)', '엔지니어링', 'IT기업', '컨설팅', '기타']),
};

export const ID_PATTERNS: Record<string, RegExp> = {
  evidence: /^SNP-[A-Z0-9]+-[A-Z0-9]+-\d{3,}$/,
  source: /^SRC-[A-Z0-9]+-(?:[A-Z0-9]+-\d{2,}|H[A-F0-9]{16}(?:-[A-F0-9]{10})?)$/,
  activity: /^ACT-[A-Z0-9]+-(?:[A-Z0-9]+-\d{2,}|H[A-F0-9]{16}(?:-[A-F0-9]{10})?)$/,
  output: /^OPT-[A-Z0-9]+-(?:[A-Z0-9]+-\d{2,}|H[A-F0-9]{16}(?:-[A-F0-9]{10})?)$/,
  indicator: /^IND-[A-Z0-9]+-(?:[A-Z0-9]+-\d{2,}|H[A-F0-9]{16}(?:-[A-F0-9]{10})?)$/,
  'outcome-short': /^OUT-S-[A-Z0-9]+-(?:[A-Z0-9]+-\d{2,}|H[A-F0-9]{16}(?:-[A-F0-9]{10})?)$/,
  'outcome-mid': /^OUT-M-[A-Z0-9]+-(?:[A-Z0-9]+-\d{2,}|H[A-F0-9]{16}(?:-[A-F0-9]{10})?)$/,
  enabler: /^FAC-E-[A-Z0-9]+-(?:[A-Z0-9]+-\d{2,}|H[A-F0-9]{16}(?:-[A-F0-9]{10})?)$/,
  constraint: /^FAC-C-[A-Z0-9]+-(?:[A-Z0-9]+-\d{2,}|H[A-F0-9]{16}(?:-[A-F0-9]{10})?)$/,
  implementer: /^(?:IMP-[A-Z0-9]+-(?:[A-Z0-9]+-\d{2,}|H[A-F0-9]{16}(?:-[A-F0-9]{10})?)|(?!(?:IMP|POL|OUT|OPT|IND|ACT|FAC|PRJ|SRC|SNP|REV|CNY|ORG)-)[^\s\/:*?"<>|#^\[\]]+)$/,
  'policy-area': /^(?:POL-[A-Z0-9]+-(?:[A-Z0-9]+-\d{2,}|H[A-F0-9]{16}(?:-[A-F0-9]{10})?)|(?!(?:IMP|POL|OUT|OPT|IND|ACT|FAC|PRJ|SRC|SNP|REV|CNY|ORG)-)[^\s\/:*?"<>|#^\[\]]+)$/,
  review: /^REV-[A-Z0-9]+-[A-Z0-9]+-\d{3,}$/,
  project: /^(?:PRJ-[A-Z0-9]+-(?:[A-Z0-9]+-\d{2,}|H[A-F0-9]{16}(?:-[A-F0-9]{10})?)|P\d+_[A-Z0-9-]+)$/,
  partner: /^(?:CNY-[A-Z0-9]+-(?:[A-Z0-9]+-\d{2,}|H[A-F0-9]{16}(?:-[A-F0-9]{10})?)|.+)$/,
  'participant-org': /^(?:ORG-[A-Z0-9]+-(?:[A-Z0-9]+-\d{2,}|H[A-F0-9]{16}(?:-[A-F0-9]{10})?)|.+)$/,
};

export const REQUIRED: Record<string, string[]> = {
  evidence: ['source', 'locator', 'quote', 'speaker', 'evidence_kind', 'evidence_level', 'category', 'proves', 'supports', 'contradicts', 'status'],
  source: ['doc_type', 'me_stage', 'masked', 'approved_ai', 'holdout', 'status'],
  implementer: ['status'],
  'policy-area': ['status'],
  output: ['screen', 'review_state', 'status'],
  indicator: ['pdm_stage', 'screen', 'review_state', 'status'],
  'outcome-short': ['outcome_family', 'screen', 'review_state', 'outcome_state_ai', 'status'],
  'outcome-mid': ['outcome_family', 'screen', 'review_state', 'outcome_state_ai', 'status'],
  enabler: ['factor_scope', 'screen', 'review_state', 'status'],
  constraint: ['factor_scope', 'screen', 'review_state', 'status'],
};

export const RELATION_FIELDS = ['source', 'proves', 'supports', 'contradicts', 'induces', 'generates', 'extends_to', 'promotes', 'hinders', 'measures', 'verified_by', 'conducts', 'targets', 'partner', 'study_tour', 'participates_in', 'policy_area', 'project'];
const LIST_RELATIONS = new Set(['proves', 'supports', 'contradicts', 'induces', 'generates', 'extends_to', 'promotes', 'hinders', 'measures', 'verified_by', 'conducts', 'targets', 'study_tour', 'participates_in']);
const IGNORED_TYPES = new Set(['index', 'log', 'admin', 'screen-hub', 'brain-active', 'brain-readme', 'signal-log', 'signal', 'rule', 'prompt-card']);
const BAD_NAME = /[\\/:*?"<>|#^\[\]]/;
const PERSONAL = [/[\w.+-]+@[\w-]+\.[\w.]+/, /\b0\d{1,2}-\d{3,4}-\d{4}\b|\+\d{2,3}[ -]?\d/];
const DATE_FIELDS = ['created', 'updated', 'observed_date', 'date_start', 'date_end', 'doc_date', 'confirmed_at'];

/** Mirrors the listed check_vault.py checks and returns metadata only, never note body text. */
export function checkVault(vaultPath: string): OntologyIssue[] {
  const issues: OntologyIssue[] = [];
  const notes = readNotes(vaultPath, issues);
  return uniqueIssues([...issues, ...checkOntologyNotes(notes)]);
}

/** Applies the vault rules to an in-memory graph without filesystem access. */
export function checkOntologyGraph(graph: import('./types').OntologyGraph): OntologyIssue[] {
  const notes: OntologyNote[] = [];
  const byId = new Map<string, OntologyNote>();
  const addRecord = (id: string, data: Record<string, unknown>, type: string, body = '') => {
    const fm = { ...asRecord(data.fm), ...data, type, id: data.id ?? id };
    delete (fm as Record<string, unknown>).fm;
    const note: OntologyNote = { name: id, path: id, frontmatter: fm, body, sections: {} };
    notes.push(note);
    byId.set(id, note);
  };
  for (const [id, data] of Object.entries(graph.sources)) addRecord(id, data, 'source');
  for (const [id, data] of Object.entries(graph.snippets)) {
    const evidence = { ...data };
    if (typeof evidence.source === 'string' && evidence.source && !evidence.source.startsWith('[[')) evidence.source = `[[${evidence.source}]]`;
    addRecord(id, evidence, 'evidence');
  }
  for (const [id, data] of Object.entries(graph.nodes)) addRecord(id, data, String(data.type ?? ''));
  for (const edge of graph.edges) {
    const source = byId.get(edge.source);
    if (!source) continue;
    const current = source.frontmatter[edge.relation];
    if (edge.relation === 'partner') source.frontmatter[edge.relation] = `[[${edge.target}]]`;
    else source.frontmatter[edge.relation] = [...(Array.isArray(current) ? current : empty(current) ? [] : [current]), `[[${edge.target}]]`];
  }
  const missingEdgeSources = graph.edges
    .filter((edge) => !byId.has(edge.source))
    .map((edge) => ({ severity: 'error' as const, file: edge.source, field: `frontmatter.${edge.relation}`, rule: 'R03 2' }));
  return uniqueIssues([...checkOntologyNotes(notes), ...missingEdgeSources]);
}

function checkOntologyNotes(notes: OntologyNote[]): OntologyIssue[] {
  const issues: OntologyIssue[] = [];
  const byName = new Map(notes.map((note) => [note.name, note]));
  const holdout = new Set(notes.filter((note) => note.frontmatter.type === 'source' && note.frontmatter.holdout === true).map((note) => note.name));
  const support = new Map<string, string[]>();

  for (const note of notes) {
    if (note.frontmatter.type !== 'evidence') continue;
    for (const target of [...extractLinks(note.frontmatter.proves), ...extractLinks(note.frontmatter.supports)]) {
      support.set(target, [...(support.get(target) ?? []), note.name]);
    }
  }

  for (const note of notes) {
    const fm = note.frontmatter;
    const type = String(fm.type ?? '');
    if (!type || IGNORED_TYPES.has(type)) continue;
    const file = note.path;
    if (BAD_NAME.test(note.name)) add(issues, 'error', file, 'file.name', 'R03 9');
    if (note.name.includes(' ')) add(issues, 'warning', file, 'file.name', 'R03 9');
    const id = String(fm.id ?? '');
    if (ID_PATTERNS[type]) {
      const generatedPrefix: Record<string, string> = { project: 'PRJ-', partner: 'CNY-', 'participant-org': 'ORG-' };
      const strictGeneratedId = generatedPrefix[type] ? id.startsWith(generatedPrefix[type]) : true;
      if (strictGeneratedId && !ID_PATTERNS[type].test(id)) add(issues, 'error', file, 'frontmatter.id', 'R03 9');
      else if (strictGeneratedId && note.name !== id && !note.name.startsWith(`${id}_`)) add(issues, 'error', file, 'file.name', 'R03 9');
    }
    for (const field of REQUIRED[type] ?? []) if (!(field in fm)) add(issues, 'error', file, `frontmatter.${field}`, 'R03');
    for (const [field, values] of Object.entries(VOCAB)) {
      if (field in fm && !empty(fm[field]) && !values.has(String(fm[field]))) add(issues, 'error', file, `frontmatter.${field}`, 'R03 4');
    }
    for (const field of RELATION_FIELDS) {
      const value = fm[field];
      if (!empty(value)) {
        if (LIST_RELATIONS.has(field) && !Array.isArray(value)) add(issues, 'error', file, `frontmatter.${field}`, 'R03 9');
        for (const target of extractLinks(value)) if (!byName.has(target)) add(issues, 'error', file, `frontmatter.${field}`, 'R03 2');
      }
    }
    for (const field of ['project', 'about']) if (field in fm) add(issues, 'warning', file, `frontmatter.${field}`, 'RQ-33');
    for (const field of DATE_FIELDS) {
      const value = fm[field];
      const normalized = value instanceof Date && !Number.isNaN(value.getTime()) ? value.toISOString().slice(0, 10) : String(value);
      if (!empty(value) && !/^\d{4}(-\d{2}(-\d{2})?)?$/.test(normalized)) add(issues, 'error', file, `frontmatter.${field}`, 'R03 9');
    }
    if (['reviewed', 'approved'].includes(String(fm.status)) && !isHuman(fm.reviewer) && !isHuman(fm.confirmed_by)) {
      add(issues, 'error', file, 'frontmatter.reviewer', 'R02 5');
    }
    const reviewState = fm.review_state;
    if (['확정', '수정 후 확정'].includes(String(reviewState)) && (!isHuman(fm.confirmed_by) || empty(fm.confirmed_at))) {
      add(issues, 'error', file, 'frontmatter.confirmed_by', 'R02 5·R03 8');
    }
    if (['수정 후 확정', '보완 필요', '채택 제외', '수정 의견'].includes(String(reviewState)) && empty(fm.review_reason) && empty(fm.po_opinion)) {
      add(issues, 'error', file, 'frontmatter.review_reason', 'R03 8');
    }
    if (type === 'evidence') checkEvidence(note, byName, holdout, issues);
    if (['output', 'outcome-short', 'outcome-mid', 'enabler', 'constraint'].includes(type) && !support.has(note.name)) {
      add(issues, 'error', file, 'frontmatter.proves|supports', 'R01 1');
    }
    if (['outcome-short', 'outcome-mid'].includes(type) && support.has(note.name)) {
      const levels = new Set(support.get(note.name)!.map((name) => byName.get(name)?.frontmatter.evidence_level));
      if ([...levels].every((level) => ['예견', '추정'].includes(String(level))) && ['관측됨', '추진 중'].includes(String(fm.outcome_state_ai))) {
        add(issues, 'error', file, 'frontmatter.outcome_state_ai', 'R05 7');
      }
    }
    if (type === 'report-draft') checkFootnotes(note, byName, issues);
  }
  return uniqueIssues(issues);
}

export function parseVaultNotes(vaultPath: string): OntologyNote[] {
  return readNotes(vaultPath, []);
}

function readNotes(vaultPath: string, issues: OntologyIssue[]): OntologyNote[] {
  const notes: OntologyNote[] = [];
  const root = path.resolve(vaultPath);
  for (const file of walkMarkdown(root)) {
    const relative = path.relative(root, file).split(path.sep).join('/');
    if (['.obsidian', '.trash', 'Templates'].includes(relative.split('/')[0])) continue;
    const raw = fs.readFileSync(file, 'utf8');
    try {
      notes.push(parseMarkdownNote(relative, raw));
    } catch {
      add(issues, 'error', relative, 'frontmatter', 'R03 9');
    }
  }
  return notes;
}

function* walkMarkdown(directory: string): Generator<string> {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* walkMarkdown(fullPath);
    else if (entry.isFile() && entry.name.endsWith('.md')) yield fullPath;
  }
}

function checkEvidence(note: OntologyNote, notes: Map<string, OntologyNote>, holdout: Set<string>, issues: OntologyIssue[]): void {
  const fm = note.frontmatter;
  if (empty(fm.quote)) add(issues, 'error', note.path, 'frontmatter.quote', 'R01 2');
  else {
    const quote = String(fm.quote);
    if (quote.length > 300) add(issues, 'warning', note.path, 'frontmatter.quote', 'R04 4');
    if (PERSONAL.some((pattern) => pattern.test(quote))) add(issues, 'error', note.path, 'frontmatter.quote', 'R02 2');
  }
  if (empty(fm.locator)) add(issues, 'error', note.path, 'frontmatter.locator', 'R01 2');
  const sources = extractLinks(fm.source);
  if (!sources.length) add(issues, 'error', note.path, 'frontmatter.source', 'R01 2');
  for (const source of sources) {
    if (holdout.has(source)) add(issues, 'error', note.path, 'frontmatter.source', 'R01 5');
    if (notes.get(source)?.frontmatter.approved_ai === 'none' && fm.author === 'ai') add(issues, 'warning', note.path, 'frontmatter.author', 'R02 4');
  }
  if (empty(fm.proves) && empty(fm.supports)) add(issues, 'warning', note.path, 'frontmatter.proves|supports', 'R04 3.5');
}

function checkFootnotes(note: OntologyNote, notes: Map<string, OntologyNote>, issues: OntologyIssue[]): void {
  const used = new Set([...note.body.matchAll(/\[\^(\d+)\](?!:)/g)].map((match) => match[1]));
  const defined = new Set([...note.body.matchAll(/^\[\^(\d+)\]:/gm)].map((match) => match[1]));
  for (const [, number, target] of note.body.matchAll(/^\[\^(\d+)\]:\s*\[\[([^\]|]+)\]/gm)) {
    if (!notes.has(target)) add(issues, 'error', note.path, `body.footnote.${number}`, 'R06 3');
    else if (!target.endsWith(`-${number.padStart(3, '0')}`)) add(issues, 'error', note.path, `body.footnote.${number}`, 'R06 3');
  }
  for (const number of used) if (!defined.has(number)) add(issues, 'error', note.path, `body.footnote.${number}`, 'R06 3');
}

function add(issues: OntologyIssue[], severity: OntologyIssue['severity'], file: string, field: string, rule: string): void {
  issues.push({ severity, file, field, rule });
}

function uniqueIssues(issues: OntologyIssue[]): OntologyIssue[] {
  return [...new Map(issues.map((issue) => [JSON.stringify(issue), issue])).values()];
}

function empty(value: unknown): boolean {
  return value === null || value === undefined || value === '' || (Array.isArray(value) && value.length === 0);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function isHuman(value: unknown): boolean {
  return !empty(value) && !['ai', '볼트'].includes(String(value).trim().toLowerCase());
}
