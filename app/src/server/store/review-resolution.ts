import type Database from 'better-sqlite3';

const normalize = (v: string) => Array.from(v.normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, ''));

export function similarity(a: string, b: string, minimum = 0): number {
  const x = normalize(a), y = normalize(b);
  if (!x.length || !y.length) return 0;
  // Edit distance cannot be smaller than the difference in lengths.
  if (1 - Math.abs(x.length - y.length) / Math.max(x.length, y.length) < minimum) return 0;
  if (x.length === y.length && x.every((c, i) => c === y[i])) return 1;
  let previous = Array.from({ length: y.length + 1 }, (_, i) => i);
  for (let i = 1; i <= x.length; i++) {
    const next = [i];
    for (let j = 1; j <= y.length; j++) next.push(Math.min(next[j - 1] + 1, previous[j] + 1, previous[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1)));
    previous = next;
  }
  return 1 - previous[y.length] / Math.max(x.length, y.length);
}

type ResolverData = {
  latest: {id: string} | undefined;
  nodes: Array<{id: string; node_type: string}>;
  aliases: Array<{import_id: string; old_node_id: string; new_node_id: string}>;
  evidence: Array<{import_id: string; node_id: string; source_id: string; quote: string}>;
  keys: Array<{import_id: string; node_id: string; node_type: string}>;
};

export function reviewResolver(projectId: string, db: Database.Database) {
  return createReviewResolver({
    latest: db.prepare('SELECT id FROM ontology_imports WHERE project_id=? ORDER BY imported_at DESC, rowid DESC LIMIT 1').get(projectId) as ResolverData['latest'],
    nodes: db.prepare('SELECT id, node_type FROM ontology_nodes WHERE project_id=? AND import_id=(SELECT id FROM ontology_imports WHERE project_id=? ORDER BY imported_at DESC, rowid DESC LIMIT 1)').all(projectId, projectId) as ResolverData['nodes'],
    aliases: db.prepare('SELECT import_id, old_node_id, new_node_id FROM ontology_review_node_aliases WHERE project_id=?').all(projectId) as ResolverData['aliases'],
    evidence: db.prepare('SELECT import_id, node_id, source_id, quote FROM ontology_review_evidence_keys WHERE project_id=?').all(projectId) as ResolverData['evidence'],
    keys: db.prepare('SELECT import_id, node_id, node_type FROM ontology_review_node_keys WHERE project_id=?').all(projectId) as ResolverData['keys'],
  });
}

// The project list needs the same resolution semantics but loads each kind of
// input once for all projects with reviews, rather than issuing queries per card.
export function reviewResolversForProjects(
  db: Database.Database,
  reviews?: readonly {project_id: string; import_id: string; node_id: string; node_type: string}[],
  additionalProjectIds: readonly string[] = [],
) {
  const reviewProjectIds = reviews
    ? [...new Set(reviews.map(({project_id}) => project_id))]
    : (db.prepare('SELECT DISTINCT project_id FROM ontology_note_reviews').all() as Array<{project_id: string}>).map(({project_id}) => project_id);
  const projectIds = new Set(reviewProjectIds);
  for (const projectId of additionalProjectIds) projectIds.add(projectId);
  const data = new Map([...projectIds].map((project_id) => [project_id, {latest: undefined, nodes: [], aliases: [], evidence: [], keys: []} as ResolverData]));
  const populate = <K extends 'nodes' | 'aliases' | 'evidence' | 'keys'>(key: K, sql: string, parameters: readonly unknown[] = []) => {
    for (const row of db.prepare(sql).all(...parameters) as Array<ResolverData[K][number] & {project_id: string}>) {
      const target = data.get(row.project_id);
      if (target) (target[key] as Array<ResolverData[K][number]>).push(row);
    }
  };
  const reviewProjectsJson = JSON.stringify(reviewProjectIds);
  const additionalProjectsJson = JSON.stringify(additionalProjectIds);
  const projectSource = 'SELECT value AS project_id FROM json_each(?) UNION SELECT value AS project_id FROM json_each(?)';
  for (const row of db.prepare(`SELECT p.project_id, i.id FROM (${projectSource}) p
    JOIN ontology_imports i ON i.id = (SELECT id FROM ontology_imports WHERE project_id=p.project_id ORDER BY imported_at DESC, rowid DESC LIMIT 1)`).all(reviewProjectsJson, additionalProjectsJson) as Array<{project_id: string; id: string}>) {
    const target = data.get(row.project_id);
    if (target) target.latest = {id: row.id};
  }
  populate('nodes', `SELECT n.project_id, n.id, n.node_type FROM (${projectSource}) p
    CROSS JOIN ontology_nodes n WHERE n.project_id=p.project_id
      AND n.import_id = (SELECT id FROM ontology_imports WHERE project_id=p.project_id ORDER BY imported_at DESC, rowid DESC LIMIT 1)`, [reviewProjectsJson, additionalProjectsJson]);
  populate('aliases', `SELECT a.project_id, a.import_id, a.old_node_id, a.new_node_id FROM (${projectSource}) p CROSS JOIN ontology_review_node_aliases a WHERE a.project_id=p.project_id`, [reviewProjectsJson, additionalProjectsJson]);
  // Keys affect only merge detection for old nodes that have aliases.
  populate('keys', `SELECT k.project_id, k.import_id, k.node_id, k.node_type
    FROM (${projectSource}) p
    CROSS JOIN ontology_review_node_aliases a
    JOIN ontology_review_node_keys k ON k.project_id=a.project_id AND k.import_id=a.import_id AND k.node_id=a.old_node_id
    WHERE a.project_id=p.project_id`, [reviewProjectsJson, additionalProjectsJson]);
  const result = new Map([...data].map(([projectId, input]) => [projectId, {resolver: createReviewResolver(input), nodes: input.nodes}]));
  // Shared-document and quote overlap only affect old aliased reviews and
  // unknown types. Resolve once without evidence to find their possible target,
  // then fetch both sides in one indexed query; no project-wide evidence scan.
  const rows = reviews ?? db.prepare(`SELECT r.project_id, r.import_id, r.node_id, k.node_type
    FROM ontology_note_reviews r JOIN ontology_review_node_keys k
      ON k.project_id=r.project_id AND k.import_id=r.import_id AND k.node_id=r.node_id`).all() as Array<{project_id: string; import_id: string; node_id: string; node_type: string}>;
  const aliasesByProject = new Map([...data].map(([id, input]) => [id, new Set(input.aliases.map((a) => JSON.stringify([a.import_id, a.old_node_id])))]));
  const needed = new Map<string, [string, string, string]>();
  for (const row of rows) {
    const item = result.get(row.project_id), input = data.get(row.project_id);
    if (!item || !input) continue;
    const hasAlias = aliasesByProject.get(row.project_id)?.has(JSON.stringify([row.import_id, row.node_id]));
    if (row.node_type !== '종류 불명' && (!hasAlias || row.import_id === input.latest?.id)) continue;
    const {targets} = item.resolver.resolve(row.import_id, row.node_id, row.node_type);
    if (targets.length !== 1 || !input.latest) continue;
    for (const pair of [[row.project_id, row.import_id, row.node_id], [row.project_id, input.latest.id, targets[0].id]] as Array<[string, string, string]>) needed.set(JSON.stringify(pair), pair);
  }
  if (needed.size) {
    const evidence = db.prepare(`SELECT e.project_id, e.import_id, e.node_id, e.source_id, e.quote
      FROM json_each(?) j CROSS JOIN ontology_review_evidence_keys e
      WHERE e.project_id=json_extract(j.value, '$[0]') AND e.import_id=json_extract(j.value, '$[1]')
      AND e.node_id=json_extract(j.value, '$[2]')`).all(JSON.stringify([...needed.values()])) as Array<ResolverData['evidence'][number] & {project_id: string}>;
    for (const row of evidence) result.get(row.project_id)?.resolver.addEvidence(row);
  }
  for (const item of result.values()) item.resolver.clearCache();
  return result;
}

function createReviewResolver({latest, nodes, aliases, evidence, keys}: ResolverData) {
  const key = (importId: string, nodeId: string) => JSON.stringify([importId, nodeId]);
  const evidenceByNode = new Map<string, typeof evidence>();
  for (const e of evidence) {
    const k = key(e.import_id, e.node_id);
    const group = evidenceByNode.get(k) ?? [];
    group.push(e);
    evidenceByNode.set(k, group);
  }
  const evidenceFor = (importId: string, nodeId: string) => evidenceByNode.get(key(importId, nodeId)) ?? [];
  const currentBySource = new Map<string, Set<string>>();
  for (const e of evidence) if (e.import_id === latest?.id) {
    const ids = currentBySource.get(e.source_id) ?? new Set<string>();
    ids.add(e.node_id);
    currentBySource.set(e.source_id, ids);
  }
  const overlapCandidates = (importId: string, nodeId: string) => {
    const ids = new Set<string>();
    for (const e of evidenceFor(importId, nodeId))
      for (const id of currentBySource.get(e.source_id) ?? []) ids.add(id);
    return ids;
  };
  const normalizedQuotes = new Map<string, string[]>();
  const normalizedQuote = (quote: string) => {
    let value = normalizedQuotes.get(quote);
    if (!value) { value = normalize(quote); normalizedQuotes.set(quote, value); }
    return value;
  };
  const quoteMatches = (a: string, b: string) => {
    const x = normalizedQuote(a), y = normalizedQuote(b);
    if (!x.length || !y.length || 1 - Math.abs(x.length - y.length) / Math.max(x.length, y.length) < 0.9) return false;
    if (x.length === y.length && x.every((c, i) => c === y[i])) return true;
    return similarity(a, b) >= 0.9;
  };
  function overlap(importId: string, oldId: string, nodeId: string): number {
    const old = evidenceFor(importId, oldId);
    const current = evidenceFor(latest?.id ?? '', nodeId);
    const used = new Set<number>();
    for (const a of old) {
      const match = current.findIndex((b, i) => !used.has(i) && a.source_id === b.source_id && quoteMatches(a.quote, b.quote));
      if (match >= 0) used.add(match);
    }
    return used.size;
  }
  const nodeById = new Map(nodes.map(n => [n.id, n]));
  const aliasByNode = new Map(aliases.map(a => [key(a.import_id, a.old_node_id), a.new_node_id]));
  const keysByNode = new Map(keys.map(k => [key(k.import_id, k.node_id), k.node_type]));
  // `base` matches the exact id or a prefix followed by a dash. Build both
  // directions once instead of rescanning every node and alias per review.
  const prefixes = (id: string) => {
    const values = [id];
    for (let i = id.indexOf('-'); i !== -1; i = id.indexOf('-', i + 1)) values.push(id.slice(0, i));
    return values;
  };
  const nodesByPrefix = new Map<string, typeof nodes>();
  for (const node of nodes) for (const prefix of prefixes(node.id)) {
    const group = nodesByPrefix.get(prefix) ?? [];
    group.push(node);
    nodesByPrefix.set(prefix, group);
  }
  const aliasesByTarget = new Map<string, typeof aliases>();
  for (const alias of aliases) {
    const aliasKey = key(alias.import_id, alias.new_node_id);
    const group = aliasesByTarget.get(aliasKey) ?? [];
    group.push(alias);
    aliasesByTarget.set(aliasKey, group);
  }
  const cache = new Map<string, ReturnType<typeof resolveUncached>>();
  function resolveUncached(importId: string, id: string, type: string) {
    const alias = aliasByNode.get(key(importId, id));
    const candidate = nodeById.get(id);
    const exact = candidate && (type === '종류 불명' || candidate.node_type === type) ? candidate : undefined;
    const targets = exact ? [exact] : alias ? (nodesByPrefix.get(alias) ?? []).filter(n => type === '종류 불명' || n.node_type === type) : [];
    const target = targets.length === 1 ? targets[0] : undefined;
    // Only nodes from the same older snapshot can establish a many-to-one merge.
    const mergeCount = target && importId !== latest?.id && alias
      ? new Set(prefixes(target.id).flatMap(prefix => aliasesByTarget.get(key(importId, prefix)) ?? []).filter(a => (nodeById.get(a.old_node_id)?.node_type !== target.node_type || a.old_node_id === target.id) && keysByNode.get(key(importId, a.old_node_id)) === target.node_type).map(a => a.old_node_id)).size : 0;
    const sources = target ? new Set(evidenceFor(latest?.id ?? '', target.id).map(e => e.source_id)) : new Set<string>();
    const sharedDocument = !!target && evidenceFor(importId, id).some(a => sources.has(a.source_id));
    const uncertain = !!target && type === '종류 불명' && !overlap(importId, id, target.id);
    const split = targets.length > 1 || (!!target && importId !== latest?.id && !!alias && (!sharedDocument || mergeCount > 1));
    return { id: target && !uncertain && !split ? target.id : id, type: target && !uncertain && !split ? target.node_type : type, targets, split, uncertain, mergeCount };

  }
  function resolve(importId: string, id: string, type: string) {
    const cacheKey = JSON.stringify([importId, id, type]);
    let result = cache.get(cacheKey);
    if (!result) {
      result = resolveUncached(importId, id, type);
      cache.set(cacheKey, result);
    }
    return result;
  }
  const addEvidence = (row: ResolverData['evidence'][number]) => {
    const k = key(row.import_id, row.node_id);
    const group = evidenceByNode.get(k) ?? [];
    group.push(row);
    evidenceByNode.set(k, group);
    if (row.import_id === latest?.id) {
      const ids = currentBySource.get(row.source_id) ?? new Set<string>();
      ids.add(row.node_id);
      currentBySource.set(row.source_id, ids);
    }
  };
  return { resolve, overlap, overlapCandidates, addEvidence, clearCache: () => cache.clear() };
}
