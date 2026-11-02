import type Database from 'better-sqlite3';

export function similarity(a: string, b: string): number {
  const normalize = (v: string) => Array.from(v.normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, ''));
  const x = normalize(a), y = normalize(b);
  if (!x.length || !y.length) return 0;
  let previous = Array.from({ length: y.length + 1 }, (_, i) => i);
  for (let i = 1; i <= x.length; i++) {
    const next = [i];
    for (let j = 1; j <= y.length; j++) next.push(Math.min(next[j - 1] + 1, previous[j] + 1, previous[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1)));
    previous = next;
  }
  return 1 - previous[y.length] / Math.max(x.length, y.length);
}

export function reviewResolver(projectId: string, db: Database.Database) {
  const latest = db.prepare('SELECT id FROM ontology_imports WHERE project_id=? ORDER BY imported_at DESC, rowid DESC LIMIT 1').get(projectId) as {id:string} | undefined;
  const nodes = db.prepare('SELECT id, node_type FROM ontology_nodes WHERE project_id=? AND import_id=?').all(projectId, latest?.id ?? '') as Array<{id:string; node_type:string}>;
  const aliases = db.prepare('SELECT import_id, old_node_id, new_node_id FROM ontology_review_node_aliases WHERE project_id=?').all(projectId) as Array<{import_id:string; old_node_id:string; new_node_id:string}>;
  const evidence = db.prepare('SELECT import_id, node_id, source_id, quote FROM ontology_review_evidence_keys WHERE project_id=?').all(projectId) as Array<{import_id:string; node_id:string; source_id:string; quote:string}>;
  function overlap(importId: string, oldId: string, nodeId: string): number {
    const old = evidence.filter(e => e.import_id === importId && e.node_id === oldId);
    const current = evidence.filter(e => e.import_id === latest?.id && e.node_id === nodeId);
    const used = new Set<number>();
    for (const a of old) {
      const match = current.findIndex((b, i) => !used.has(i) && a.source_id === b.source_id && similarity(a.quote, b.quote) >= 0.9);
      if (match >= 0) used.add(match);
    }
    return used.size;
  }
  const keys = db.prepare('SELECT import_id, node_id, node_type FROM ontology_review_node_keys WHERE project_id=?').all(projectId) as Array<{import_id:string; node_id:string; node_type:string}>;
  const matches = (base: string, id: string) => id === base || id.startsWith(`${base}-`);
  function resolve(importId: string, id: string, type: string) {
    const alias = aliases.find(a => a.import_id === importId && a.old_node_id === id)?.new_node_id;
    const exact = nodes.find(n => n.id === id && (type === '종류 불명' || n.node_type === type));
    const targets = exact ? [exact] : alias ? nodes.filter(n => (n.id === alias || n.id.startsWith(`${alias}-`)) && (type === '종류 불명' || n.node_type === type)) : [];
    const target = targets.length === 1 ? targets[0] : undefined;
    // Only nodes from the same older snapshot can establish a many-to-one merge.
    const mergeCount = target && importId !== latest?.id && alias
      ? new Set(aliases.filter(a => a.import_id === importId && matches(a.new_node_id, target.id) && (!nodes.some(n => n.id === a.old_node_id && n.node_type === target.node_type) || a.old_node_id === target.id) && keys.some(k => k.import_id === importId && k.node_id === a.old_node_id && k.node_type === target.node_type)).map(a => a.old_node_id)).size : 0;
    const sharedDocument = !!target && evidence.some(a => a.import_id === importId && a.node_id === id && evidence.some(b => b.import_id === latest?.id && b.node_id === target.id && a.source_id === b.source_id));
    const uncertain = !!target && type === '종류 불명' && !overlap(importId, id, target.id);
    const split = targets.length > 1 || (!!target && importId !== latest?.id && !!alias && (!sharedDocument || mergeCount > 1));
    return { id: target && !uncertain && !split ? target.id : id, type: target && !uncertain && !split ? target.node_type : type, targets, split, uncertain, mergeCount };

  }
  return { resolve, overlap };
}
