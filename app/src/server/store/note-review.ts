import { isReviewableNodeType } from "../../lib/reviewable-node";
import crypto from "node:crypto";
import { reviewResolver, similarity } from "./review-resolution";
import { latestLinkReviewsFromHistory, linkKey, linkReviewHistory, type LinkReview } from "./link-review";
import type Database from "better-sqlite3";
import { getDatabase, getBannedSentencesByProject, resolveProjectCitationContext, type ProjectCitationContext } from "./db";
import {
  maskTextIfForbiddenSentenceOverlap,
  createForbiddenSentenceIndex,
  isEvidenceCitationBanned,
  isCitationBannedSentence,
  hasForbiddenSentenceOverlap,
} from "./citation-ban";
import { getOntologyQuoteChecks } from "./ontology";
import { holdoutOntologySources } from "./ontology-holdout";
import { getPortfolioPageData } from "./portfolio";

export type NoteReview = {
  id: string;
  project_id: string;
  import_id: string;
  node_id: string;
  status: string;
  text: string;
  original_text: string;
  outcome_state: string;
  reason: string;
  error_type: string;
  reviewer: string;
  created_at: string;
  old_title?: string;
};
export type NoteItem = {
  id: string;
  type: string;
  title: string;
  text: string;
  fields: Record<string, unknown>;
  sections: Record<string, unknown>;
  evidence: NoteEvidence[];
  contradictions: NoteEvidence[];
  relations: Array<{ relation: string; target: string }>;
  candidates: Array<{
    source: string;
    title: string;
    status: string;
    relation: string;
    unknownRelation: boolean;
    splitLink: boolean;
  }>;
  history: NoteReview[];
  renamedHistory?: NoteReview[];
  splitHistory?: NoteReview[];
  splitPending?: boolean;
  mergeCount?: number;
  splitLinkHistory?: LinkReview[];
  uncertainHistory?: NoteReview[];
  linkHistory?: LinkReview[];
};
export type NoteEvidence = {
  id: string;
  quote: string;
  sourceId: string;
  sourceTitle: string;
  date: string;
  level: string;
  speaker: string;
  location: string;
  verified: boolean;
  match: number | null;
};
const record = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
const json = (v: string) => record(JSON.parse(v));
const str = (v: unknown) =>
  typeof v === "string" ? v : v == null ? "" : String(v);
const list = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
export const NOTE_STATUSES = [
  "확정",
  "수정 중",
  "수정 의견",
  "수정 후 확정",
  "보완 필요",
  "채택 제외",
] as const;
export const NOTE_STATES = [
  "관측됨",
  "추진 중",
  "기대/추정",
  "미확인",
] as const;
export const ERROR_TYPES = [
  "성과 과장",
  "근거 부족",
  "시점 혼동",
  "주체 혼동",
  "외부 자료 혼입",
  "산출물·성과 혼동",
  "수치 오류",
  "누락",
  "기타",
] as const;
export function evidenceSufficiency(evidence: NoteEvidence[]): string {
  const verified = evidence.filter((e) => e.verified);
  if (verified.some((e) => e.level === "입증")) return "충분";
  const observations = verified.filter((e) => e.level === "관측");
  if (new Set(observations.map((e) => e.sourceId).filter(Boolean)).size >= 2)
    return "충분";
  if (observations.length) return "검토 중";
  return "추가 확인";
}
/** Only the IDs used for ToC links, with the same citation masking as full review data. */
export function getNoteReviewItemIds(projectId: string, db: Database.Database = getDatabase()): string[] {
  const latest = db.prepare("SELECT id FROM ontology_imports WHERE project_id = ? ORDER BY imported_at DESC, rowid DESC LIMIT 1").get(projectId) as { id: string } | undefined;
  if (!latest) return [];
  const rows = db.prepare("SELECT id FROM ontology_nodes WHERE project_id = ? AND import_id = ? AND node_type IN ('indicator','output','outcome-short','outcome-mid','enabler','constraint') ORDER BY rowid").all(projectId, latest.id) as Array<{ id: string }>;
  const banned = [...new Set(getBannedSentencesByProject(projectId, db).map(s => s.content))];
  const index = createForbiddenSentenceIndex(banned);
  return rows.map(row => index(row.id) ? "[인용 금지 문장]" : row.id);
}

/** Fast count of current-import notes whose latest review confirms them. */
const latestNodeStatusSql = (nodeAlias = 'n') => `COALESCE(
  (SELECT current_review.status FROM ontology_note_reviews current_review
    JOIN ontology_review_node_keys current_key ON current_key.project_id=current_review.project_id
      AND current_key.import_id=current_review.import_id AND current_key.node_id=current_review.node_id
    WHERE current_review.project_id=${nodeAlias}.project_id AND current_review.import_id=${nodeAlias}.import_id
      AND current_review.node_id=${nodeAlias}.id AND current_key.node_type=${nodeAlias}.node_type
    ORDER BY current_review.rowid DESC LIMIT 1),
  (SELECT old_review.status FROM ontology_note_reviews old_review
    JOIN ontology_review_node_keys old_key ON old_key.project_id=old_review.project_id
      AND old_key.import_id=old_review.import_id AND old_key.node_id=old_review.node_id
    WHERE old_review.project_id=${nodeAlias}.project_id AND old_review.import_id<>${nodeAlias}.import_id
      AND old_review.node_id=${nodeAlias}.id AND old_key.node_type=${nodeAlias}.node_type
    ORDER BY old_review.rowid DESC LIMIT 1))`;
const unresolvedSplitSql = (nodeAlias = 'n') => `EXISTS (
  SELECT 1 FROM ontology_review_node_aliases a
  JOIN ontology_review_node_keys old_key ON old_key.project_id=a.project_id AND old_key.import_id=a.import_id AND old_key.node_id=a.old_node_id
  JOIN ontology_note_reviews old_review ON old_review.project_id=a.project_id AND old_review.import_id=a.import_id AND old_review.node_id=a.old_node_id
  WHERE a.project_id=${nodeAlias}.project_id AND a.import_id <> ${nodeAlias}.import_id AND old_key.node_type=${nodeAlias}.node_type
    AND (${nodeAlias}.id=a.new_node_id OR substr(${nodeAlias}.id,1,length(a.new_node_id)+1)=a.new_node_id || '-')
    AND ((SELECT COUNT(*) FROM ontology_nodes target WHERE target.project_id=${nodeAlias}.project_id
      AND target.import_id=${nodeAlias}.import_id AND target.node_type=${nodeAlias}.node_type
      AND (target.id=a.new_node_id OR substr(target.id,1,length(a.new_node_id)+1)=a.new_node_id || '-')) > 1
      OR NOT EXISTS (SELECT 1 FROM ontology_review_evidence_keys previous_evidence
        JOIN ontology_review_evidence_keys current_evidence ON current_evidence.project_id=previous_evidence.project_id
          AND current_evidence.source_id=previous_evidence.source_id
        WHERE previous_evidence.project_id=a.project_id AND previous_evidence.import_id=a.import_id
          AND previous_evidence.node_id=a.old_node_id AND current_evidence.import_id=${nodeAlias}.import_id
          AND current_evidence.node_id=${nodeAlias}.id))
  )`;
const hasReviewAliases = (projectId: string, db: Database.Database) =>
  Boolean(db.prepare('SELECT 1 FROM ontology_review_node_aliases WHERE project_id=? LIMIT 1').get(projectId));
export function getConfirmedNoteCount(projectId: string, db: Database.Database = getDatabase()): number {
  // Split aliases only turn otherwise unreviewed/changed notes into pending.
  // They cannot remove a note whose latest status is already confirmed, so the
  // confirmed count uses exact-ID/type history without the expensive split scan.
  const status = latestNodeStatusSql('n');
  return (db.prepare(`SELECT COUNT(*) AS count FROM ontology_nodes n
    JOIN ontology_imports i ON i.id=n.import_id AND i.project_id=n.project_id
    WHERE n.project_id=? AND i.rowid=(SELECT current.rowid FROM ontology_imports current
      WHERE current.project_id=n.project_id ORDER BY current.imported_at DESC,current.rowid DESC LIMIT 1)
      AND ${status} IN ('확정','수정 후 확정')`).get(projectId) as {count:number}).count;
}

/** Current factor titles and latest review status for the pathway screen. */
export function getFactorNoteStatuses(projectId: string, db: Database.Database = getDatabase(), graphNodes: readonly { id: string; type: string; title: string }[] = []): Array<{ id: string; type: string; title: string; status: string }> {
  const rows = db.prepare(`SELECT n.id, n.node_type AS type, n.title, COALESCE((
      SELECT r.status FROM ontology_note_reviews r
      JOIN ontology_review_node_keys k ON k.project_id=r.project_id AND k.import_id=r.import_id
        AND k.node_id=r.node_id AND k.node_type=n.node_type
      WHERE r.project_id=n.project_id AND r.node_id=n.id
      ORDER BY r.rowid DESC LIMIT 1
    ), '미검토') AS status
    FROM ontology_nodes n JOIN ontology_imports i ON i.id = n.import_id AND i.project_id = n.project_id
    WHERE n.project_id = ? AND i.rowid = (SELECT current.rowid FROM ontology_imports current
      WHERE current.project_id = n.project_id ORDER BY current.imported_at DESC, current.rowid DESC LIMIT 1)
      AND n.node_type IN ('enabler','constraint') ORDER BY n.rowid`).all(projectId) as Array<{ id: string; type: string; title: string; status: string }>;
  const needsOverlap = (value: string) => value.length >= 8 || value.toLowerCase().length >= 8 || value.replace(/\s+/g, '').length >= 8;
  const graphFactors = graphNodes.filter(node => node.type === 'enabler' || node.type === 'constraint');
  const needsBannedText = [...rows, ...graphFactors].some(row => needsOverlap(row.id) || needsOverlap(row.title));
  const banned = needsBannedText ? getBannedSentencesByProject(projectId, db).map(sentence => sentence.content) : [];
  const bannedIndex = banned.length ? createForbiddenSentenceIndex(banned) : null;
  const overlapsBanned = (value: string) => bannedIndex?.(value) ?? false;
  const safeText = (value: string) => isCitationBannedSentence(value) || overlapsBanned(value) ? '[인용 금지 문장]' : value;
  const safeId = (value: string) => isCitationBannedSentence(value) || overlapsBanned(value)
    ? `masked-${crypto.createHash('sha256').update(value).digest('hex').slice(0, 20)}` : value;
  // The graph already contains these IDs; retain them for exact matching while
  // continuing to mask IDs that were not supplied by the graph.
  const graphByKey = new Map(graphFactors.map(node => [JSON.stringify([node.id, node.type]), node]));
  const rowKeys = new Set(rows.map(row => JSON.stringify([row.id, row.type])));
  return [
    ...rows.map(row => { const node = graphByKey.get(JSON.stringify([row.id, row.type])); return { ...row, id: node ? row.id : safeId(row.id), title: safeText(node?.title ?? row.title) }; }),
    ...graphFactors.filter(node => !rowKeys.has(JSON.stringify([node.id, node.type])))
      .map(node => ({ ...node, title: safeText(node.title), status: '미검토' })),
  ];
}

/** Exact ID/type history plus source-level split guards; quote-similarity resolution stays on review. */
export function getCurrentNoteStatus(projectId: string, nodeId: string, db: Database.Database = getDatabase()): string {
  const latestStatus = latestNodeStatusSql('n');
  const status = hasReviewAliases(projectId, db) ? `CASE WHEN ${unresolvedSplitSql('n')} AND COALESCE(${latestStatus},'미검토') NOT IN ('확정','수정 후 확정','채택 제외') THEN '미검토' ELSE COALESCE(${latestStatus},'미검토') END` : `COALESCE(${latestStatus},'미검토')`;
  const row = db.prepare(`SELECT ${status} AS status
    FROM ontology_nodes n JOIN ontology_imports i ON i.id=n.import_id AND i.project_id=n.project_id
    WHERE n.project_id=? AND n.id=? AND i.rowid=(SELECT current.rowid FROM ontology_imports current
      WHERE current.project_id=n.project_id ORDER BY current.imported_at DESC,current.rowid DESC LIMIT 1)`).get(projectId, nodeId) as {status:string} | undefined;
  return row?.status ?? '미검토';
}
export function getNoteReviewData(
  projectId: string,
  db: Database.Database = getDatabase(),
  citationContext?: ProjectCitationContext,
): {
  importId: string | null;
  items: NoteItem[];
  missingReviewedCount: number;
  unknownReviewedCount: number;
  missingLinkCount: number;
  unknownLinkCount: number;
  unknownRelationLinks: LinkReview[];
  splitReviewedCount: number;
  splitLinkCount: number;
} {
  const latest = db
    .prepare(
      "SELECT id FROM ontology_imports WHERE project_id = ? ORDER BY imported_at DESC, rowid DESC LIMIT 1",
    )
    .get(projectId) as { id: string } | undefined;
  if (!latest) return { importId: null, items: [], missingReviewedCount: 0, unknownReviewedCount: 0, missingLinkCount: 0, unknownLinkCount: 0, unknownRelationLinks: [], splitReviewedCount: 0, splitLinkCount: 0 };
  const rows = db
    .prepare(
      "SELECT id, node_type, title, data_json FROM ontology_nodes WHERE project_id = ? AND import_id = ? ORDER BY rowid",
    )
    .all(projectId, latest.id) as Array<{
    id: string;
    node_type: string;
    title: string;
    data_json: string;
  }>;
  const sourceRows = db
    .prepare(
      `SELECT
         id,
         json_extract(data_json, '$.document_id') AS document_id,
         json_extract(data_json, '$.title') AS title,
         json_extract(data_json, '$.doc_date') AS doc_date,
         json_type(data_json, '$.evidence_metadata') AS meta_type
       FROM ontology_sources
       WHERE project_id = ? AND import_id = ?`,
    )
    .all(projectId, latest.id) as Array<{
      id: string;
      document_id: string | null;
      title: string | null;
      doc_date: string | null;
      meta_type: string | null;
    }>;
  const metaRows = sourceRows.some((s) => s.meta_type !== null)
    ? (db
        .prepare(
          `SELECT id, json_extract(data_json, '$.evidence_metadata') AS meta_json
           FROM ontology_sources
           WHERE project_id = ? AND import_id = ? AND json_type(data_json, '$.evidence_metadata') IS NOT NULL`,
        )
        .all(projectId, latest.id) as Array<{ id: string; meta_json: string }>)
    : [];
  const metaMap = new Map(metaRows.map((r) => [r.id, json(r.meta_json)]));
  const sources = new Map<string, Record<string, unknown>>();
  for (const r of sourceRows) {
    const meta = r.meta_type !== null ? metaMap.get(r.id) ?? {} : {};
    sources.set(r.id, {
      id: r.id,
      document_id: r.document_id,
      title: r.title,
      doc_date: r.doc_date,
      evidence_metadata: meta,
    });
  }
  const snippetRows = db
    .prepare(
      "SELECT id, data_json FROM ontology_snippets WHERE project_id = ? AND import_id = ?",
    )
    .all(projectId, latest.id) as Array<{ id: string; data_json: string }>;
  const holdoutSources = holdoutOntologySources(projectId, db, sources);
  const snippetData = snippetRows.map((r) => {
    const raw = json(r.data_json);
    const sourceId = str(raw.source);
    const source = sources.get(sourceId) ?? {};
    const meta = record(record(source.evidence_metadata)[r.id]);
    return { id: r.id, data: { ...meta, ...raw } };
  }).filter(snippet => !holdoutSources.has(str(snippet.data.source)));
  const context = resolveProjectCitationContext(projectId, db, citationContext);
  const verified = getOntologyQuoteChecks(projectId, latest.id, db, snippetData, sources, context);
  const snippets = snippetData.map(({ id, data }) => {
    const sourceId = str(data.source);
    const source = sources.get(sourceId) ?? {};
    const check = verified.get(id);
    return {
      data,
      view: {
        id,
        quote: str(data.quote),
        sourceId,
        sourceTitle: str(source.title) || sourceId,
        date: str(source.doc_date),
        level: str(data.evidence_level ?? data.level),
        speaker: str(data.speaker),
        location: str(data.locator),
        verified: check?.verified ?? false,
        match: check?.coverage ?? null,
      },
    };
  });
  const history = db
    .prepare(
      `SELECT r.*, r.node_id AS mapped_node_id FROM ontology_note_reviews r
    JOIN ontology_review_node_keys k ON k.project_id = r.project_id AND k.import_id = r.import_id AND k.node_id = r.node_id
    WHERE r.project_id = ? ORDER BY r.rowid`,
    )
    .all(projectId) as Array<NoteReview & { mapped_node_id: string }>;
  const keys = db
    .prepare(
      "SELECT import_id, node_id, node_type FROM ontology_review_node_keys WHERE project_id = ?",
    )
    .all(projectId) as Array<{
    import_id: string;
    node_id: string;
    node_type: string;
  }>;
  const keyTypes = new Map(keys.map(k => [JSON.stringify([k.import_id, k.node_id]), k.node_type]));
  const oldNodeKeys = new Set(keys.filter(k => k.import_id !== latest.id).map(k => JSON.stringify([k.node_id, k.node_type])));
  const resolver = reviewResolver(projectId, db);
  const resolution = (h: NoteReview) => resolver.resolve(h.import_id, h.node_id, keyTypes.get(JSON.stringify([h.import_id, h.node_id])) ?? "종류 불명");
  const typeFor = (h: NoteReview) => resolution(h).type;
  for (const h of history) h.mapped_node_id = resolution(h).id;
  const reviewedTargets = new Set(history.filter(h => !resolution(h).split && ["확정", "수정 후 확정", "채택 제외"].includes(h.status)).map(h => resolution(h).id));
  const reviewedTarget = (id: string) => reviewedTargets.has(id);
  const rowKeys = new Set(rows.map(r => JSON.stringify([r.id, r.node_type])));
  const splitReviewedCount = new Set(history.filter(h => resolution(h).split).flatMap(h => resolution(h).targets.filter(t => !reviewedTarget(t.id)).map(t => t.id))).size;
  const missingReviewedCount = new Set(history.filter(h => !resolution(h).split && typeFor(h) !== "종류 불명" && !rowKeys.has(JSON.stringify([h.mapped_node_id, typeFor(h)]))).map(h => `${typeFor(h)}:${h.mapped_node_id}`)).size;
  const candidates = db
    .prepare(
      "SELECT source_id, target_id, relation FROM ontology_relation_candidates WHERE project_id = ? AND import_id = ?",
    )
    .all(projectId, latest.id) as Array<{
    source_id: string;
    target_id: string;
    relation: string;
    unknownRelation: boolean;
    splitLink: boolean;
  }>;
  const allLinkReviews = linkReviewHistory(projectId, db, resolver);
  const linkReviews = latestLinkReviewsFromHistory(allLinkReviews);
  // Use the already loaded node keys and link resolutions. A note view needs
  // only graph edges and titles, not the graph's parsed display fields.
  const edges = db.prepare(`SELECT source_id, target_id, relation_field FROM ontology_edges
    WHERE project_id = ? AND import_id = ? AND NOT EXISTS (SELECT 1 FROM ontology_relation_candidates c WHERE c.project_id = ontology_edges.project_id AND c.import_id = ontology_edges.import_id AND c.source_id = ontology_edges.source_id AND c.target_id = ontology_edges.target_id AND c.relation = ontology_edges.relation_field) ORDER BY source_id, relation_field, target_id`).all(projectId, latest.id) as Array<{source_id: string; target_id: string; relation_field: string}>;
  for (const link of linkReviews.values()) {
    if (link.status === '확정' && link.relation && rowKeys.has(JSON.stringify([link.source_id, link.source_type])) && rowKeys.has(JSON.stringify([link.target_id, link.target_type])))
      edges.push({source_id: link.source_id, target_id: link.target_id, relation_field: link.relation});
  }
  const pairKey = (source: string, target: string) => JSON.stringify([source, target]);
  const reviewedPairs = new Set([...linkReviews.values()].filter(l => !l.split && !!l.relation && ["확정", "기각"].includes(l.status)).map(l => pairKey(l.source_id, l.target_id)));
  const pairReviewed = (source: string, target: string) => reviewedPairs.has(pairKey(source, target));
  const splitLinks = [...linkReviews.values()].filter(l => l.split && l.status === "확정");
  const candidatesBySource = new Map<string, Set<string>>();
  for (const candidate of candidates) {
    const targets = candidatesBySource.get(candidate.source_id) ?? new Set<string>();
    targets.add(candidate.target_id);
    candidatesBySource.set(candidate.source_id, targets);
  }
  const pendingPairs = new Set<string>();
  for (const link of splitLinks) {
    const targets = new Set(link.target_targets ?? []);
    for (const source of link.source_targets ?? []) for (const target of candidatesBySource.get(source) ?? []) {
      if (targets.has(target) && !pairReviewed(source, target)) pendingPairs.add(pairKey(source, target));
    }
  }
  const splitLinkCount = pendingPairs.size;
  const confirmedPairs = new Set([...linkReviews.values()].filter(l => !l.split && !!l.relation && l.status === "확정").map(l => pairKey(l.source_id, l.target_id)));
  const graphTitles = new Map<string, string>();
  for (const node of rows) if (!graphTitles.has(node.id)) graphTitles.set(node.id, node.title);
  const unknownRelationLinks = [...linkReviews.values()].filter(l => l.status === "확정" && !l.relation && !l.split && !confirmedPairs.has(pairKey(l.source_id, l.target_id))).map(l => ({ ...l, source_title: graphTitles.get(l.source_id), target_title: graphTitles.get(l.target_id) }));
  const unknownLinkCount = [...linkReviews.values()].filter(l => l.status === "확정" && !!l.relation && (l.source_type === "종류 불명" || l.target_type === "종류 불명")).length;
  const missingLinkCount = [...linkReviews.values()].filter(l => l.status === "확정" && !l.split && l.relation && l.source_type !== "종류 불명" && l.target_type !== "종류 불명" && (!rowKeys.has(JSON.stringify([l.source_id, l.source_type])) || !rowKeys.has(JSON.stringify([l.target_id, l.target_type])))).length;
  const titles = db.prepare("SELECT import_id, node_id, title FROM ontology_review_node_titles WHERE project_id = ?").all(projectId) as Array<{import_id: string; node_id: string; title: string}>;
  const titlesByKey = new Map(titles.map(t => [JSON.stringify([t.import_id, t.node_id]), t.title]));
  const titleFor = (h: NoteReview) => titlesByKey.get(JSON.stringify([h.import_id, h.node_id]));
  const byTarget = <T>(map: Map<string, T[]>, id: string, value: T) => {
    const group = map.get(id) ?? [];
    group.push(value);
    map.set(id, group);
  };
  const splitByTarget = new Map<string, typeof history>();
  const uncertainByTarget = new Map<string, typeof history>();
  const historyByTarget = new Map<string, typeof history>();
  const renamedByTarget = new Map<string, typeof history>();
  const rowById = new Map(rows.map(r => [r.id, r]));
  const renameMatches = new Map<string, string[]>();
  const titleSimilarities = new Map<string, number>();
  for (const h of history) {
    const resolved = resolution(h);
    if (resolved.split) for (const t of resolved.targets) byTarget(splitByTarget, t.id, h);
    if (resolved.uncertain) for (const t of resolved.targets) byTarget(uncertainByTarget, t.id, h);
    if (!resolved.split) byTarget(historyByTarget, JSON.stringify([h.mapped_node_id, resolved.type]), h);
    if (!rowKeys.has(JSON.stringify([h.mapped_node_id, resolved.type]))) {
      const key = JSON.stringify([h.import_id, h.node_id, resolved.type, h.mapped_node_id]);
      let matches = renameMatches.get(key);
      if (!matches) {
        matches = [];
        for (const id of resolver.overlapCandidates(h.import_id, h.node_id)) {
          const r = rowById.get(id);
          if (!r || oldNodeKeys.has(JSON.stringify([r.id, r.node_type])) || resolved.type !== r.node_type || h.mapped_node_id === r.id) continue;
          const title = titleFor(h) ?? '';
          const titleKey = JSON.stringify([title, r.title]);
          let titleSimilarity = titleSimilarities.get(titleKey);
          if (titleSimilarity === undefined) {
            titleSimilarity = similarity(title, r.title, 0.5);
            titleSimilarities.set(titleKey, titleSimilarity);
          }
          if (titleSimilarity < 0.5) continue;
          const count = resolver.overlap(h.import_id, h.node_id, r.id);
          if (count && titleSimilarity >= (count >= 2 ? 0.5 : 0.8)) matches.push(r.id);
        }
        renameMatches.set(key, matches);
      }
      for (const id of matches) byTarget(renamedByTarget, id, h);
    }
  }
  const splitLinksByTarget = new Map<string, LinkReview[]>();
  for (const l of splitLinks) for (const id of new Set([...(l.source_targets ?? []), ...(l.target_targets ?? [])])) byTarget(splitLinksByTarget, id, l);
  const linksByTarget = new Map<string, LinkReview[]>();
  for (const l of allLinkReviews) if (!l.split) for (const id of new Set([l.source_id, l.target_id])) byTarget(linksByTarget, id, l);
  // Index relations in snippet order so the result is identical to filtering
  // the complete snippet array, without a node × snippet scan.
  const snippetsById = new Map(snippets.map((s, index) => [s.view.id, { snippet: s, index }]));
  const evidenceByNode = new Map<string, Set<string>>();
  const contradictionsByNode = new Map<string, Set<string>>();
  const add = (map: Map<string, Set<string>>, key: string, value: string) => {
    const values = map.get(key) ?? new Set<string>();
    values.add(value);
    map.set(key, values);
  };
  for (const s of snippets) {
    for (const id of [...list(s.data.proves), ...list(s.data.supports)]) add(evidenceByNode, id, s.view.id);
    for (const id of list(s.data.contradicts)) add(contradictionsByNode, id, s.view.id);
  }
  const contradictionEdges = new Map<string, Set<string>>();
  const incomingContradictions = new Map<string, Set<string>>();
  for (const edge of edges) if (edge.relation_field === 'contradicts') {
    add(incomingContradictions, edge.target_id, edge.source_id);
    add(contradictionEdges, edge.source_id, edge.target_id);
    add(contradictionEdges, edge.target_id, edge.source_id);
  }
  const orderedViews = (ids: Set<string>) => [...ids].flatMap(id => {
    const found = snippetsById.get(id);
    return found ? [found] : [];
  }).sort((a, b) => a.index - b.index).map(found => found.snippet.view);
  const edgesBySource = new Map<string, typeof edges>();
  for (const edge of edges) byTarget(edgesBySource, edge.source_id, edge);
  const candidatesByTarget = new Map<string, typeof candidates>();
  for (const candidate of candidates) byTarget(candidatesByTarget, candidate.target_id, candidate);
  const unknownPairs = new Set(unknownRelationLinks.map(l => pairKey(l.source_id, l.target_id)));
  const items = rows
    .filter((r) => isReviewableNodeType(r.node_type))
    .map((r) => {
      const data = json(r.data_json),
        fields = { ...data, ...record(data.fm) },
        sections = record(data.sec);
      const evidenceIds = new Set([...list(data.evidence), ...(evidenceByNode.get(r.id) ?? [])]);
      const evidence = orderedViews(evidenceIds);
      const contradictionIds = new Set(contradictionsByNode.get(r.id) ?? []);
      // An edge to the node only counts when its source is a snippet; edges
      // touching a piece of evidence work in either direction.
      for (const id of incomingContradictions.get(r.id) ?? []) contradictionIds.add(id);
      for (const item of evidence) for (const id of contradictionEdges.get(item.id) ?? []) contradictionIds.add(id);
      const contradictions = orderedViews(contradictionIds);
      const text =
        str(
          data.description ??
            fields.description ??
            sections["확인된 사실"] ??
            sections["요약"],
        ) || r.title;
      return {
        id: r.id,
        type: r.node_type,
        title: r.title,
        text,
        fields,
        sections,
        evidence,
        contradictions,
        relations: (edgesBySource.get(r.id) ?? [])
          .map((e) => ({ relation: e.relation_field, target: e.target_id })),
        candidates:
          r.node_type === "outcome-mid"
            ? (candidatesByTarget.get(r.id) ?? [])
                .filter(
                  (e) =>
                    e.target_id === r.id &&
                    !!rowById.get(e.source_id) && rowById.get(e.source_id)?.node_type !== "종류 불명" &&
                    ["extends_to", "targets"].includes(e.relation),
                )
                .map((e) => ({
                  source: e.source_id,
                  splitLink: pendingPairs.has(pairKey(e.source_id, e.target_id)),
                  unknownRelation: unknownPairs.has(pairKey(e.source_id, e.target_id)),
                  relation: e.relation,
                  title:
                    rowById.get(e.source_id)?.title ??
                    e.source_id,
                  status: linkReviews.get(linkKey({ source_id: e.source_id, target_id: e.target_id, relation: e.relation, source_type: rowById.get(e.source_id)?.node_type ?? '', target_type: r.node_type }))?.status ?? "AI 후보",
                })).filter(c => c.status !== "기각")
            : [],
        renamedHistory: renamedByTarget.get(r.id) ?? [],
        splitHistory: (splitByTarget.get(r.id) ?? []).map(h => ({...h, old_title: titleFor(h)})),
        mergeCount: Math.max(0, ...(splitByTarget.get(r.id) ?? []).map(h => resolution(h).mergeCount)),
        splitPending: !reviewedTarget(r.id) && (splitByTarget.get(r.id)?.length ?? 0) > 0,
        splitLinkHistory: splitLinksByTarget.get(r.id) ?? [],
        uncertainHistory: uncertainByTarget.get(r.id) ?? [],
        linkHistory: (linksByTarget.get(r.id) ?? []).map(l => ({...l, source_title: rowById.get(l.source_id)?.title ?? l.source_title, target_title: rowById.get(l.target_id)?.title ?? l.target_title})),
        history: historyByTarget.get(JSON.stringify([r.id, r.node_type])) ?? [],
      };
    });
  const { sentences: banned, index: bannedIndex } = context;
  const safeStrings = new Map<string, string>();
  const safeString = (value: string) => {
    let result = safeStrings.get(value);
    if (result === undefined) {
      result = bannedIndex(value) ? "[인용 금지 문장]" : value;
      safeStrings.set(value, result);
    }
    return result;
  };
  const safe = (v: unknown): unknown =>
    typeof v === "string"
      ? safeString(v)
      : Array.isArray(v)
        ? v.map(safe)
        : v && typeof v === "object"
          ? Object.fromEntries(
              Object.entries(v).map(([k, val]) => [k, safe(val)]),
            )
          : v;
  return {
    importId: latest.id,
    missingReviewedCount,
    splitReviewedCount,
    splitLinkCount,
    missingLinkCount,
    unknownLinkCount,
    unknownRelationLinks: safe(unknownRelationLinks) as LinkReview[],
    unknownReviewedCount: new Set(history.filter((h) => typeFor(h) === "종류 불명").map((h) => h.node_id)).size,
    items: items.map(
      (item) =>
        safe({
          ...item,
          evidence: item.evidence.map((e) =>
            isEvidenceCitationBanned(e, banned, bannedIndex)
              ? {
                  ...e,
                  quote: "[인용 금지 문장]",
                  speaker: "",
                  verified: false,
                }
              : e,
          ),
          contradictions: item.contradictions.map((e) =>
            isEvidenceCitationBanned(e, banned, bannedIndex)
              ? {
                  ...e,
                  quote: "[인용 금지 문장]",
                  speaker: "",
                  verified: false,
                }
              : e,
          ),
        }) as NoteItem,
    ),
  };
}
export function saveNoteReview(
  projectId: string,
  importId: string,
  nodeId: string,
  input: {
    status: string;
    text: string;
    outcomeState: string;
    reason: string;
    errorType: string;
  },
  reviewer: string,
  db: Database.Database = getDatabase(),
): void {
  const transaction = db.transaction(() => {
    const data = getNoteReviewData(projectId, db);
    const item =
      data.importId === importId
        ? data.items.find((i) => i.id === nodeId)
        : undefined;
    if (!item) throw new Error("현재 사업의 노트를 찾을 수 없습니다.");
    if (
      !(NOTE_STATUSES as readonly string[]).includes(input.status) ||
      !(NOTE_STATES as readonly string[]).includes(input.outcomeState) ||
      (input.errorType &&
        !(ERROR_TYPES as readonly string[]).includes(input.errorType))
    )
      throw new Error("잘못된 검토 값입니다.");
    const last = item.history.at(-1);
    if (
      last &&
      ["확정", "수정 후 확정", "채택 제외"].includes(last.status) &&
      input.status !== "수정 중"
    )
      throw new Error("새 이력으로 수정을 시작해 주십시오.");
    const banned = getBannedSentencesByProject(projectId, db).map(
      (s) => s.content,
    );
    if (
      hasForbiddenSentenceOverlap(input.text, banned, 8) ||
      hasForbiddenSentenceOverlap(input.reason, banned, 8)
    )
      throw new Error("인용 금지 문장이 포함되어 저장할 수 없습니다.");
    if (!input.text.trim()) throw new Error("판단 문안을 입력해 주십시오.");
    if (
      (["수정 후 확정", "보완 필요", "채택 제외", "수정 의견"].includes(
        input.status,
      ) ||
        (input.status === "확정" && input.text.trim() !== item.text)) &&
      !input.reason.trim()
    )
      throw new Error("사유를 입력해 주십시오.");
    if (
      (["수정 후 확정", "보완 필요", "채택 제외", "수정 의견"].includes(
        input.status,
      ) ||
        (input.status === "확정" && input.text.trim() !== item.text)) &&
      !input.errorType.trim()
    )
      throw new Error("오류 유형을 선택해 주십시오.");
    const status =
      input.status === "확정" && input.text.trim() !== item.text
        ? "수정 후 확정"
        : input.status;
    db.prepare(
      "INSERT INTO ontology_note_reviews VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      crypto.randomUUID(),
      projectId,
      importId,
      nodeId,
      status,
      input.text.trim(),
      item.history[0]?.original_text ?? item.text,
      input.outcomeState,
      input.reason.trim(),
      input.errorType,
      reviewer,
      new Date().toISOString(),
    );
    getPortfolioPageData(projectId, db);
  });
  transaction();
}

export function confirmNoteLink(projectId: string, importId: string, sourceId: string, targetId: string, reviewer: string, db: Database.Database = getDatabase(), relation?: string) {
  reviewNoteLink(projectId, importId, sourceId, targetId, relation, "확정", "", "", reviewer, db);
}
export function rejectNoteLink(projectId: string, importId: string, sourceId: string, targetId: string, relation: string, reason: string, errorType: string, reviewer: string, db: Database.Database = getDatabase()) {
  reviewNoteLink(projectId, importId, sourceId, targetId, relation, "기각", reason, errorType, reviewer, db);
}
function reviewNoteLink(projectId: string, importId: string, sourceId: string, targetId: string, relation: string | undefined, status: string, reason: string, errorType: string, reviewer: string, db: Database.Database) {
  db.transaction(() => {
    const data = getNoteReviewData(projectId, db);
    const candidates = data.importId === importId ? data.items.find(i => i.id === targetId)?.candidates.filter(c => c.source === sourceId && (!relation || c.relation === relation)) ?? [] : [];
    if (candidates.length !== 1 || candidates[0].status !== 'AI 후보') throw new Error("현재 사업의 연결 후보를 찾을 수 없습니다.");
    if (status === '기각' && (!reason.trim() || !(ERROR_TYPES as readonly string[]).includes(errorType))) throw new Error("사유와 오류 유형을 입력해 주십시오.");
    const banned = getBannedSentencesByProject(projectId, db).map(s => s.content);
    if (hasForbiddenSentenceOverlap(reason, banned, 8)) throw new Error("인용 금지 문장이 포함되어 저장할 수 없습니다.");
    const id = crypto.randomUUID();
    db.prepare("INSERT INTO ontology_link_reviews VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(id, projectId, importId, sourceId, targetId, status, reviewer, new Date().toISOString());
    db.prepare("INSERT INTO ontology_link_review_details VALUES (?, ?, ?, ?)").run(id, candidates[0].relation, reason.trim(), errorType);
  })();
}
