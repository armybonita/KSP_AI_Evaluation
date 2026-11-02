import type Database from 'better-sqlite3';
import { reviewResolver } from './review-resolution';

export type LinkReview = { id: string; source_id: string; target_id: string; source_type: string; target_type: string; relation: string; status: string; reason: string; error_type: string; reviewer: string; created_at: string; source_title?: string; target_title?: string; split?: boolean; source_targets?: string[]; target_targets?: string[] };

// Old confirmations have no relation. Candidate rows cannot prove which relation was confirmed.
export function linkReviewHistory(projectId: string, db: Database.Database, resolver = reviewResolver(projectId, db)): LinkReview[] {
  const resolve = resolver.resolve;
  const rows = db.prepare(`SELECT r.*, s.node_type AS source_type, t.node_type AS target_type,
    COALESCE(d.relation, '') AS relation, COALESCE(d.reason, '') AS reason, COALESCE(d.error_type, '') AS error_type
    FROM ontology_link_reviews r
    JOIN ontology_review_node_keys s ON s.project_id=r.project_id AND s.import_id=r.import_id AND s.node_id=r.source_id
    JOIN ontology_review_node_keys t ON t.project_id=r.project_id AND t.import_id=r.import_id AND t.node_id=r.target_id
    LEFT JOIN ontology_link_review_details d ON d.review_id=r.id
    WHERE r.project_id=? ORDER BY r.rowid`).all(projectId) as Array<LinkReview & {import_id:string}>;
  const titles = db.prepare('SELECT import_id, node_id, title FROM ontology_review_node_titles WHERE project_id=?').all(projectId) as Array<{import_id:string; node_id:string; title:string}>;
  const titleByKey = new Map(titles.map(t => [JSON.stringify([t.import_id, t.node_id]), t.title]));
  return rows.map(r => {
    const source = resolve(r.import_id, r.source_id, r.source_type);
    const target = resolve(r.import_id, r.target_id, r.target_type);
    return { ...r, source_id: source.id, source_type: source.type, target_id: target.id, target_type: target.type, split: source.split || target.split, source_targets: source.targets.map(n => n.id), target_targets: target.targets.map(n => n.id), source_title: titleByKey.get(JSON.stringify([r.import_id, r.source_id])), target_title: titleByKey.get(JSON.stringify([r.import_id, r.target_id])) };
  });
}
export function linkKey(r: Pick<LinkReview, 'source_id' | 'target_id' | 'source_type' | 'target_type' | 'relation'>): string {
  return JSON.stringify([r.source_type, r.source_id, r.target_type, r.target_id, r.relation]);
}
export function latestLinkReviews(projectId: string, db: Database.Database, resolver = reviewResolver(projectId, db)): Map<string, LinkReview> {
  return latestLinkReviewsFromHistory(linkReviewHistory(projectId, db, resolver));
}
export function latestLinkReviewsFromHistory(history: LinkReview[]): Map<string, LinkReview> {
  const result = new Map<string, LinkReview>();
  for (const review of history) result.set(review.split ? JSON.stringify(["split", review.id]) : linkKey(review), review);
  return result;
}
