import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import { getDatabase } from './db';
import { getNoteReviewData } from './note-review';
import { getAiDocumentEligibility } from '../documents/ai-eligibility';
import type { DocType } from './types';
import { reviewResolver } from './review-resolution';
import {
  OUTCOME_FAMILIES,
  type PortfolioLevelHistory,
  type PortfolioOutcome,
  type PortfolioOutcomeType,
  type PortfolioPageData,
  type PortfolioProjectSummary,
  portfolioLevelForFamily,
  summarizePortfolioProject,
} from '@/lib/portfolio';
export { summarizePortfolioProject };
export type {
  PortfolioAxis,
  PortfolioEmptyReason,
  PortfolioLevel,
  PortfolioLevelHistory,
  PortfolioOutcome,
  PortfolioOutcomeType,
  PortfolioPageData,
  PortfolioOutcomeInput,
  PortfolioProjectSummary,
} from '@/lib/portfolio';

type LevelRow = {
  id: string;
  project_id: string;
  import_id: string;
  node_id: string;
  node_type: string;
  outcome_family: string;
  ai_level: string;
  team_level: string | null;
  reviewer: string;
  created_at: string;
};

const ALL_FAMILY_SET = new Set<string>(OUTCOME_FAMILIES);
const OUTCOME_TYPE_SET = new Set<string>(['outcome-short', 'outcome-mid']);

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function fieldsFromJson(raw: string): Record<string, unknown> {
  try {
    const data = record(JSON.parse(raw));
    return { ...data, ...record(data.fm) };
  } catch {
    return {};
  }
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();
}

function noteStatusAndState(review: {status: string; outcome_state: string} | undefined, fields: Record<string, unknown>) {
  return {
    reviewStatus: review?.status ?? '미검토',
    outcomeState: review ? asText(review.outcome_state) : asText(fields.outcome_state_ai) || asText(fields.outcome_state),
  };
}

function levelHistoryForProject(projectId: string, items: ReturnType<typeof getNoteReviewData>['items'], db: Database.Database): Map<string, PortfolioLevelHistory[]> {
  const rows = db.prepare(`SELECT id, project_id, import_id, node_id, node_type, outcome_family, ai_level, team_level, reviewer, created_at
    FROM ontology_portfolio_level_reviews WHERE project_id=? ORDER BY rowid`).all(projectId) as LevelRow[];
  const resolver = reviewResolver(projectId, db);
  const current = new Map(items.filter((item) => OUTCOME_TYPE_SET.has(item.type)).map((item) => [JSON.stringify([item.id, item.type]), item]));
  const historyByNode = new Map<string, PortfolioLevelHistory[]>();
  for (const row of rows) {
    const resolved = resolver.resolve(row.import_id, row.node_id, row.node_type);
    if (resolved.split || resolved.uncertain || !OUTCOME_TYPE_SET.has(resolved.type)) continue;
    const key = JSON.stringify([resolved.id, resolved.type]);
    if (!current.has(key)) continue;
    const history = historyByNode.get(resolved.id) ?? [];
    history.push({
      id: row.id,
      importId: row.import_id,
      nodeId: row.node_id,
      nodeType: row.node_type as PortfolioOutcomeType,
      outcomeFamily: row.outcome_family,
      aiLevel: row.ai_level,
      teamLevel: portfolioLevelForFamily(row.outcome_family, row.team_level),
      reviewer: row.reviewer,
      createdAt: row.created_at,
    });
    historyByNode.set(resolved.id, history);
  }
  return historyByNode;
}

export function getPortfolioPageData(projectId: string, db: Database.Database = getDatabase()): PortfolioPageData | null {
  const project = db.prepare('SELECT id, name FROM projects WHERE id=?').get(projectId) as {id: string; name: string} | undefined;
  if (!project) return null;
  const noteData = getNoteReviewData(projectId, db);
  const sourceDocuments = noteData.importId ? db.prepare(`SELECT s.id, d.doc_type, d.is_past_final_report, d.is_included, d.masked, d.approved_ai
    FROM ontology_sources s JOIN documents d ON d.id=json_extract(s.data_json, '$.document_id') AND d.project_id=s.project_id
    WHERE s.project_id=? AND s.import_id=?`).all(projectId, noteData.importId) as Array<{
      id: string; doc_type: DocType | null; is_past_final_report: number | null;
      is_included: number; masked: number | null; approved_ai: string;
    }> : [];
  const eligibleSources = new Set(sourceDocuments.filter(d => d.is_included === 1 && getAiDocumentEligibility({
    doc_type: d.doc_type,
    is_past_final_report: d.is_past_final_report === null ? null : d.is_past_final_report === 1,
    masked: d.masked === null ? null : d.masked === 1,
    approved_ai: d.approved_ai,
  }).eligible).map(d => d.id));
  const historyByNode = levelHistoryForProject(projectId, noteData.items, db);
  const outcomes: PortfolioOutcome[] = noteData.items
    .filter((item) => OUTCOME_TYPE_SET.has(item.type))
    .map((item) => {
      const fields = item.fields;
      const family = asText(fields.outcome_family);
      const latestReview = item.history.at(-1);
      const history = historyByNode.get(item.id) ?? [];
      const latestLevel = history.at(-1);
      const latestTeamLevel = latestLevel
        ? latestLevel.outcomeFamily === family ? portfolioLevelForFamily(family, latestLevel.teamLevel) : null
        : portfolioLevelForFamily(family, asText(fields.level));
      const { reviewStatus, outcomeState } = noteStatusAndState(latestReview, fields);
      return {
        id: item.id,
        type: item.type as PortfolioOutcomeType,
        title: item.title,
        text: item.text,
        outcomeFamily: family,
        aiLevel: asText(fields.level_ai) || asText(fields.outcome_level),
        reviewStatus,
        outcomeState,
        evidenceEligible: item.evidence.some(evidence => evidence.verified && eligibleSources.has(evidence.sourceId)),
        evidenceObserved: item.evidence.some(evidence => evidence.verified && eligibleSources.has(evidence.sourceId) && ['관측', '입증'].includes(evidence.level)),
        teamLevel: latestTeamLevel,
        teamLevelSource: latestLevel ? 'review_history' : latestTeamLevel ? 'imported' : null,
        history,
      };
    });
  const summary = summarizePortfolioProject(project.id, project.name, outcomes);
  const revision = db.prepare('SELECT revision FROM report_input_revisions WHERE project_id=?').get(projectId) as {revision: number} | undefined;
  db.prepare(`INSERT INTO ontology_portfolio_snapshots
    (project_id, knowledge_level, cooperation_level, quadrant, knowledge_empty_reason, cooperation_empty_reason, calculated_at, input_revision)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(project_id) DO UPDATE SET knowledge_level=excluded.knowledge_level, cooperation_level=excluded.cooperation_level,
      quadrant=excluded.quadrant, knowledge_empty_reason=excluded.knowledge_empty_reason, cooperation_empty_reason=excluded.cooperation_empty_reason,
      calculated_at=excluded.calculated_at, input_revision=excluded.input_revision, calculation_version=excluded.calculation_version`).run(
    projectId, summary.knowledge.level, summary.cooperation.level, summary.quadrant, summary.knowledge.emptyReason,
    summary.cooperation.emptyReason, new Date().toISOString(), revision?.revision ?? 0,
  );
  return {
    projectId: project.id,
    projectName: project.name,
    importId: noteData.importId,
    outcomes,
    summary,
  };
}

export type PortfolioSnapshotRow = {
  projectId: string;
  projectName: string;
  summary: PortfolioProjectSummary | null;
  calculatedAt: string | null;
};

/** A bounded, single SQL read; stale and absent projections are never recomputed here. */
export function getPortfolioSummaries(page: number, pageSize: number, db: Database.Database = getDatabase()): { rows: PortfolioSnapshotRow[]; hasNext: boolean } {
  const rows = db.prepare(`SELECT p.id, p.name, s.knowledge_level, s.cooperation_level, s.quadrant,
      s.knowledge_empty_reason, s.cooperation_empty_reason, s.calculated_at,
      CASE WHEN s.project_id IS NOT NULL AND s.calculation_version=1 AND s.input_revision=COALESCE(r.revision, 0) THEN 1 ELSE 0 END AS fresh
    FROM projects p LEFT JOIN ontology_portfolio_snapshots s ON s.project_id=p.id
    LEFT JOIN report_input_revisions r ON r.project_id=p.id
    ORDER BY p.created_at DESC, p.id DESC LIMIT ? OFFSET ?`).all(pageSize + 1, (page - 1) * pageSize) as Array<{
      id: string; name: string; knowledge_level: PortfolioProjectSummary['knowledge']['level'];
      cooperation_level: PortfolioProjectSummary['cooperation']['level']; quadrant: string | null;
      knowledge_empty_reason: PortfolioProjectSummary['knowledge']['emptyReason'];
      cooperation_empty_reason: PortfolioProjectSummary['cooperation']['emptyReason']; calculated_at: string | null; fresh: number;
    }>;
  return {
    hasNext: rows.length > pageSize,
    rows: rows.slice(0, pageSize).map(row => ({
      projectId: row.id, projectName: row.name, calculatedAt: row.fresh ? row.calculated_at : null,
      summary: row.fresh ? {
        projectId: row.id, projectName: row.name,
        knowledge: { level: row.knowledge_level, emptyReason: row.knowledge_empty_reason },
        cooperation: { level: row.cooperation_level, emptyReason: row.cooperation_empty_reason }, quadrant: row.quadrant,
      } : null,
    })),
  };
}

export function savePortfolioLevel(
  projectId: string,
  importId: string,
  nodeId: string,
  teamLevel: string | null,
  reviewer: string,
  db: Database.Database = getDatabase(),
  createdAt = new Date().toISOString(),
): void {
  const latest = db.prepare('SELECT id FROM ontology_imports WHERE project_id=? ORDER BY imported_at DESC, rowid DESC LIMIT 1').get(projectId) as {id: string} | undefined;
  if (!latest || latest.id !== importId) throw new Error('최신 사업 성과 노트를 찾을 수 없습니다. 화면을 새로고침해 주세요.');
  const node = db.prepare(`SELECT node_type, data_json FROM ontology_nodes
    WHERE project_id=? AND import_id=? AND id=?`).get(projectId, importId, nodeId) as {node_type: string; data_json: string} | undefined;
  if (!node || !OUTCOME_TYPE_SET.has(node.node_type)) throw new Error('현재 사업의 성과 노트를 찾을 수 없습니다.');
  const fields = fieldsFromJson(node.data_json);
  const family = asText(fields.outcome_family);
  if (!ALL_FAMILY_SET.has(family)) throw new Error('성과군이 확인된 성과에만 레벨을 입력할 수 있습니다.');
  const normalizedLevel = teamLevel === '' ? null : teamLevel;
  const level = normalizedLevel === null ? null : portfolioLevelForFamily(family, normalizedLevel);
  if (normalizedLevel !== null && !level) throw new Error('성과군에 맞지 않는 레벨입니다.');
  if (!reviewer.trim()) throw new Error('평가자 정보를 확인할 수 없습니다.');
  const aiLevel = asText(fields.level_ai) || asText(fields.outcome_level);
  db.transaction(() => {
  db.prepare(`INSERT INTO ontology_portfolio_level_reviews (
    id, project_id, import_id, node_id, node_type, outcome_family, ai_level, team_level, reviewer, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    crypto.randomUUID(), projectId, importId, nodeId, node.node_type, family, aiLevel, level, reviewer.trim(), createdAt,
  );
  getPortfolioPageData(projectId, db);
  })();
}
