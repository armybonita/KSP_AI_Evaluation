import path from 'node:path';
import { checkVault, parseVaultNotes } from './checker';
import { extractLinks } from './markdown';
import type { OntologyGraph, OntologyNote, VaultExchange } from './types';

const NODE_TYPES = new Set(['project', 'partner', 'policy-area', 'implementer', 'participant-org', 'activity', 'output', 'outcome-short', 'outcome-mid', 'enabler', 'constraint', 'indicator']);
const RELATION_FIELDS = ['proposes', 'shapes', 'participates_in', 'conducts', 'targets', 'performs', 'generates', 'induces', 'extends_to', 'proves', 'promotes', 'hinders', 'measures', 'verified_by', 'source', 'supports', 'contradicts', 'study_tour', 'policy_area', 'partner', 'previous_phase'];

/** Reads a vault once and creates isolated, read-only in-memory graphs by project code. */
export function importVault(vaultPath: string): OntologyGraph[] {
  const notes = parseVaultNotes(vaultPath);
  const issues = checkVault(vaultPath);
  const byName = new Map(notes.map((note) => [note.name, note]));
  const projects = notes.filter((note) => note.frontmatter.type === 'project');
  return projects.map((project) => buildProjectGraph(project, notes, byName, issues));
}

/** One-way conversion to the field names used by window.VAULT. */
export function toVaultExchange(graph: OntologyGraph): VaultExchange {
  return {
    code: graph.code,
    sources: structuredClone(graph.sources),
    snippets: structuredClone(graph.snippets),
    nodes: structuredClone(graph.nodes),
    reports: structuredClone(graph.reports),
    report_status: structuredClone(graph.report_status),
    project: structuredClone(graph.project),
  };
}

function buildProjectGraph(project: OntologyNote, notes: OntologyNote[], byName: Map<string, OntologyNote>, allIssues: OntologyGraph['issues']): OntologyGraph {
  const code = String(project.frontmatter.code ?? project.name.replace(/^P\d+_/, ''));
  const selected = new Set<string>([project.name]);
  // Explicit project membership identifies private records. Shared records are pulled in
  // through the project's own R03 links, then cloned into this graph.
  for (const note of notes) {
    if (extractLinks(note.frontmatter.project).includes(project.name)) selected.add(note.name);
  }
  for (const field of RELATION_FIELDS) for (const linkedName of extractLinks(project.frontmatter[field])) if (byName.has(linkedName)) selected.add(linkedName);

  // Include linked records only while their project membership is empty or matches this
  // project; this avoids traversing through a shared node into another project's records.
  let changed = true;
  while (changed) {
    changed = false;
    for (const name of [...selected]) {
      const note = byName.get(name);
      if (!note) continue;
      for (const candidate of notes) {
        if (selected.has(candidate.name) || !['partner', 'policy-area', 'implementer', 'participant-org'].includes(String(candidate.frontmatter.type))) continue;
        const candidateMembership = extractLinks(candidate.frontmatter.project);
        const pointsToSelected = RELATION_FIELDS.some((field) => extractLinks(candidate.frontmatter[field]).includes(name));
        if (pointsToSelected && (candidateMembership.length === 0 || candidateMembership.includes(project.name))) {
          selected.add(candidate.name);
          changed = true;
        }
      }
      for (const field of RELATION_FIELDS) {
        for (const target of extractLinks(note.frontmatter[field])) {
          const candidate = byName.get(target);
          if (!candidate || selected.has(target)) continue;
          const memberships = extractLinks(candidate.frontmatter.project);
          if (candidate.frontmatter.type === 'project' || memberships.length === 0 || memberships.includes(project.name)) {
            selected.add(target);
            changed = true;
          }
        }
      }
    }
  }

  const scoped = notes.filter((note) => selected.has(note.name));
  const sources: OntologyGraph['sources'] = {};
  const snippets: OntologyGraph['snippets'] = {};
  const nodes: OntologyGraph['nodes'] = {};
  const reports: OntologyGraph['reports'] = {};
  const report_status: OntologyGraph['report_status'] = {};
  const edges: OntologyGraph['edges'] = [];
  let projectData: Record<string, unknown> = {};
  for (const note of scoped) {
    const type = note.frontmatter.type;
    if (type === 'source') sources[note.name] = sourceRecord(note);
    else if (type === 'evidence') snippets[note.name] = evidenceRecord(note);
    else if (type === 'report-draft' || type === 'evaluation-matrix' || type === 'me-checklist') {
      reports[note.name] = note.body;
      report_status[note.name] = String(note.frontmatter.status ?? '');
    } else if (typeof type === 'string' && NODE_TYPES.has(type)) nodes[note.name] = nodeRecord(note, selected);
    if (note.name === project.name) projectData = { ...note.frontmatter, _sec: note.sections };
    for (const relation of RELATION_FIELDS) {
      for (const target of extractLinks(note.frontmatter[relation])) {
        if (selected.has(target)) edges.push({ source: note.name, target, relation });
      }
    }
  }
  const issueFiles = new Set(scoped.map((note) => note.path));
  const graphIssues = allIssues.filter((issue) => issueFiles.has(issue.file));
  return { code, projectName: project.name, project: projectData, sources, snippets, nodes, edges, reports, report_status, issues: graphIssues };
}

function sourceRecord(note: OntologyNote): Record<string, unknown> {
  const fm = note.frontmatter;
  return {
    id: fm.id || note.name,
    title: fm.title || firstHeading(note.body) || note.name,
    doc_type: fm.doc_type ?? '',
    me_stage: fm.me_stage ?? '',
    doc_date: String(fm.doc_date ?? ''),
    holdout: Boolean(fm.holdout),
    masked: fm.masked,
    ...preservedObservedFields(fm),
  };
}

function evidenceRecord(note: OntologyNote): Record<string, unknown> {
  const fm = note.frontmatter;
  return {
    id: note.name,
    title: firstHeading(note.body).replace(/^SNP-\S+\s*/, ''),
    source: extractLinks(fm.source)[0] ?? '',
    locator: fm.locator ?? '',
    quote: fm.quote ?? '',
    speaker: fm.speaker ?? '',
    kind: fm.evidence_kind ?? '',
    level: fm.evidence_level ?? '',
    category: fm.category ?? '',
    conf: fm.ai_confidence,
    date: String(fm.observed_date ?? ''),
    proves: extractLinks(fm.proves),
    supports: extractLinks(fm.supports),
    contradicts: extractLinks(fm.contradicts),
    facts: bullets(note.sections['확인된 사실']),
    ai: bullets(note.sections['해석(AI)']),
    unsure: bullets(note.sections['불확실성·확인 필요']),
    ...preservedObservedFields(fm),
  };
}

function nodeRecord(note: OntologyNote, selected: Set<string>): Record<string, unknown> {
  const fm = note.frontmatter;
  const nodeFm = structuredClone(fm);
  delete nodeFm.type;
  delete nodeFm.layer;
  delete nodeFm.id;
  for (const key of ['generates', 'induces', 'extends_to', 'promotes', 'hinders', 'measures', 'verified_by', 'conducts', 'targets', 'partner', 'policy_area', 'previous_phase', 'performs', 'participates_in', 'proposes', 'shapes', 'supports', 'contradicts', 'source']) {
    if (fm[key]) nodeFm[key] = extractLinks(fm[key]).filter((target) => selected.has(target));
  }
  return { id: note.name, type: fm.type ?? '', title: firstHeading(note.body), fm: nodeFm, sec: structuredClone(note.sections) };
}

function preservedObservedFields(frontmatter: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(['project', 'about'].filter((key) => key in frontmatter).map((key) => [key, structuredClone(frontmatter[key])]));
}

function firstHeading(body: string): string {
  return body.match(/^#\s+(.*)$/m)?.[1].trim() ?? '';
}

function bullets(section = ''): string[] {
  return section.split(/\r?\n/).filter((line) => /^\s*[-*]\s+/.test(line)).map((line) => line.replace(/^\s*[-*]\s+/, '').trim());
}
