import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkVault, importVault, toVaultExchange } from './index';
import { checkOntologyGraph, ID_PATTERNS } from './checker';
import crypto from 'node:crypto';

const fixtureRoot = path.resolve(process.cwd(), 'fixtures/ontology');

describe('ontology vault import and checks', () => {
  it('accepts legacy named entities and generated IDs, while rejecting malformed generated IDs', () => {
    expect(ID_PATTERNS.implementer.test('가상수행기관_공용')).toBe(true);
    expect(ID_PATTERNS['policy-area'].test('가상정책분야_공용')).toBe(true);
    expect(ID_PATTERNS.implementer.test('IMP-PABCDE-D12345-01')).toBe(true);
    expect(ID_PATTERNS['policy-area'].test('POL-PABCDE-D12345-01')).toBe(true);
    expect(ID_PATTERNS.implementer.test('POL-PABCDE-D12345-01')).toBe(false);
    expect(ID_PATTERNS['policy-area'].test('IMP-PABCDE-D12345-01')).toBe(false);
    expect(ID_PATTERNS.implementer.test('POL-PABCDEF-H1234567890ABCDEF')).toBe(false);
    expect(ID_PATTERNS['policy-area'].test('IMP-PABCDEF-H1234567890ABCDEF')).toBe(false);
    for (const id of ['POL-가상001', 'OUT-S-가상001', 'OPT-가상001']) {
      expect(ID_PATTERNS.implementer.test(id)).toBe(false);
      expect(ID_PATTERNS['policy-area'].test(id)).toBe(false);
    }
    expect(ID_PATTERNS.implementer.test('IMP-잘못된ID')).toBe(false);
    expect(ID_PATTERNS['policy-area'].test('POL-잘못된ID')).toBe(false);
  });

  it('keeps the existing full-vault checker result stable and accepts graph input', () => {
    const issues = checkVault(fixtureRoot);
    expect(issues).toHaveLength(70);
    expect(issues.filter(({ severity }) => severity === 'error')).toHaveLength(45);
    expect(issues.filter(({ severity }) => severity === 'warning')).toHaveLength(25);
    expect(crypto.createHash('sha256').update(JSON.stringify(issues)).digest('hex')).toBe('c6a7e53e0563212ecd48c708aed58d163b87e4253cd3ed2039bee87f475d2297');
    const graph = importVault(fixtureRoot)[0];
    expect(checkOntologyGraph(graph).every((issue) => !issue.file.includes('/'))).toBe(true);
  });

  it('attributes generated graph errors and warnings to source, evidence, and point ids', () => {
    const sourceId = 'SRC-PABCDE-D12345-01';
    const snippetId = 'SNP-PABCDE-D12345-001';
    const outputId = 'OPT-PABCDE-D12345-01';
    const issues = checkOntologyGraph({
      code: 'PABCDE', projectName: '가상 사업', project: { id: 'project-a' },
      sources: { [sourceId]: { id: sourceId, doc_type: '가상 미등록 유형', me_stage: '', masked: null, approved_ai: 'none', holdout: null, status: 'ai-draft' } },
      snippets: { [snippetId]: { id: snippetId, type: 'evidence', layer: 'L3', created: '2026-10-30', updated: '2026-10-30', source: sourceId, locator: '¶1', quote: '가상 문장입니다.', speaker: '수행기관', evidence_kind: '기타', evidence_level: '관측', category: '산출물', proves: [], supports: [], contradicts: [], status: 'ai-draft', author: 'ai' } },
      nodes: { [outputId]: { id: outputId, type: 'output', title: '가상 산출물', screen: 'EV04', review_state: '미검토', status: 'ai-draft' } },
      edges: [{ source: 'SRC-PABCDE-D12345-99', target: outputId, relation: 'generates' }],
      reports: {}, report_status: {}, issues: [],
    });
    expect(issues).toContainEqual({ severity: 'error', file: sourceId, field: 'frontmatter.doc_type', rule: 'R03 4' });
    expect(issues).toContainEqual({ severity: 'warning', file: snippetId, field: 'frontmatter.author', rule: 'R02 4' });
    expect(issues).toContainEqual({ severity: 'error', file: outputId, field: 'frontmatter.proves|supports', rule: 'R01 1' });
    expect(issues).toContainEqual({ severity: 'error', file: 'SRC-PABCDE-D12345-99', field: 'frontmatter.generates', rule: 'R03 2' });
  });
  it('imports both synthetic businesses with fixed point, edge, source, evidence and report counts', () => {
    const graphs = importVault(fixtureRoot);
    expect(graphs.map(({ code }) => code).sort()).toEqual(['VA01', 'VB01']);
    expect(graphs.map(({ nodes }) => Object.keys(nodes).length)).toEqual([8, 8]);
    expect(graphs.map(({ edges }) => edges.length)).toEqual([12, 12]);
    expect(graphs.map(({ sources }) => Object.keys(sources).length)).toEqual([1, 1]);
    expect(graphs.map(({ snippets }) => Object.keys(snippets).length)).toEqual([1, 1]);
    expect(graphs.map(({ reports }) => Object.keys(reports).length)).toEqual([1, 1]);
    expect(graphs.flatMap(({ issues }) => issues).filter(({ severity }) => severity === 'error')).toEqual([]);
  });

  it('clones shared nodes and keeps mutations and lookups isolated by business', () => {
    const [a, b] = importVault(fixtureRoot);
    const sharedName = '가상협력국_공용';
    expect(a.nodes[sharedName]).toBeDefined();
    expect(b.nodes[sharedName]).toBeDefined();
    expect(a.nodes[sharedName]).not.toBe(b.nodes[sharedName]);
    a.nodes[sharedName].title = '사업 A 내부 변경';
    (a.nodes[sharedName] as { sec: Record<string, unknown> }).sec['운영상 유의점'] = '사업 A 내부 본문';
    a.edges.splice(0, 1);
    delete a.nodes['OPT-VB01-K001-01_가상산출물B'];
    expect(b.nodes[sharedName].title).toBe('가상협력국');
    expect((b.nodes[sharedName] as { sec: Record<string, unknown> }).sec['운영상 유의점']).toContain('가상 협력 점입니다.');
    expect(b.edges).toHaveLength(12);
    expect(b.nodes['OPT-VB01-K001-01_가상산출물B']).toBeDefined();
    expect(a.nodes['OPT-VB01-K001-01_가상산출물B']).toBeUndefined();
  });

  it('preserves schema-external project/about values and reports field-only warnings', () => {
    const graphs = importVault(fixtureRoot);
    const project = graphs[0].nodes['P1_VA01'] as { fm: Record<string, unknown> };
    const activity = graphs[0].nodes['ACT-VA01-K001-01_가상활동A'] as { fm: Record<string, unknown> };
    expect(project.fm.about).toBe('가상 자료의 설명 필드입니다.');
    expect(activity.fm.project).toBe('[[P1_VA01]]');
    const warnings = graphs.flatMap(({ issues }) => issues).filter(({ severity, field }) => severity === 'warning' && ['frontmatter.project', 'frontmatter.about'].includes(field));
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings.every((issue) => Object.keys(issue).sort().join(',') === 'field,file,rule,severity')).toBe(true);
    expect(warnings.some(({ field }) => field === 'frontmatter.about')).toBe(true);
  });

  it('removes another business activity from VA01 shared-node relationships', () => {
    const [va01] = importVault(fixtureRoot);
    const sharedImplementer = va01.nodes['가상수행기관_공용'] as { fm: Record<string, unknown> };
    expect(sharedImplementer.fm.performs).not.toContain('ACT-VB01-K001-01_가상활동B');
    expect(sharedImplementer.fm.performs).toContain('ACT-VA01-K001-01_가상활동A');
  });

  it.each([
    ['required-vocab', 'R03 4'],
    ['required-fields', 'R03'],
    ['list-link', 'R03 9'],
    ['review-authority', 'R02 5·R03 8'],
    ['evidence-source', 'R01 5'],
    ['no-evidence', 'R01 1'],
    ['outcome-state', 'R05 7'],
    ['report-footnote', 'R06 3'],
  ])('reports the expected invalid rule for %s', (caseName, rule) => {
    const issues = checkVault(path.join(fixtureRoot, 'invalid', caseName));
    expect(issues.some((issue) => issue.severity === 'error' && issue.rule === rule)).toBe(true);
  });

  it('asserts filename, identifier, and date failures independently in name-id-date', () => {
    const issues = checkVault(path.join(fixtureRoot, 'invalid/name-id-date'));
    expect(issues).toContainEqual(expect.objectContaining({ field: 'file.name', rule: 'R03 9', severity: 'error' }));
    expect(issues).toContainEqual(expect.objectContaining({ field: 'frontmatter.id', rule: 'R03 9', severity: 'error' }));
    expect(issues).toContainEqual(expect.objectContaining({ field: 'frontmatter.created', rule: 'R03 9', severity: 'error' }));
  });

  it('accepts an unquoted YAML date after normalizing the parsed Date value', () => {
    const issues = checkVault(path.join(fixtureRoot, 'invalid/unquoted-date'));
    expect(issues.some(({ field, rule }) => field === 'frontmatter.created' && rule === 'R03 9')).toBe(false);
  });

  it('reports an existing footnote target whose suffix does not match its number', () => {
    const issues = checkVault(path.join(fixtureRoot, 'invalid/report-footnote'));
    expect(issues).toContainEqual(expect.objectContaining({ field: 'body.footnote.2', rule: 'R06 3', severity: 'error' }));
  });

  it('rejects every required result and factor point when no evidence supports it', () => {
    const issues = checkVault(path.join(fixtureRoot, 'invalid/no-evidence'));
    expect(issues.filter(({ severity, rule }) => severity === 'error' && rule === 'R01 1')).toHaveLength(5);
  });

  it('reports evidence required values, personal data and broken links without copying quote text', () => {
    const issues = checkVault(path.join(fixtureRoot, 'invalid/evidence-source'));
    expect(issues.some(({ field, rule }) => field === 'frontmatter.locator' && rule === 'R01 2')).toBe(true);
    expect(issues.some(({ field, rule }) => field === 'frontmatter.quote' && rule === 'R01 2')).toBe(true);
    expect(issues.some(({ field, rule }) => field === 'frontmatter.quote' && rule === 'R02 2')).toBe(true);
    expect(issues.some(({ field, rule }) => field === 'frontmatter.speaker' && rule === 'R03 4')).toBe(true);
    expect(issues.some(({ field, rule }) => field === 'frontmatter.source' && rule === 'R01 5')).toBe(true);
    expect(checkVault(path.join(fixtureRoot, 'invalid/list-link')).some(({ rule }) => rule === 'R03 2')).toBe(true);
    expect(JSON.stringify(issues)).not.toContain(['010', '1234', '5678'].join('-'));
  });

  it('reports the source length notice and AI extraction notice without promoting either to an error', () => {
    const issues = checkVault(path.join(fixtureRoot, 'invalid/evidence-notices'));
    expect(issues.some(({ severity, rule }) => severity === 'warning' && rule === 'R04 4')).toBe(true);
    expect(issues.some(({ severity, rule }) => severity === 'warning' && rule === 'R02 4')).toBe(true);
  });

  it('converts to the window.VAULT exchange field names in one function', () => {
    const graph = importVault(fixtureRoot)[0];
    const exchange = toVaultExchange(graph);
    expect(Object.keys(exchange)).toEqual(['code', 'sources', 'snippets', 'nodes', 'reports', 'report_status', 'project']);
    expect(exchange.code).toBe('VA01');
    expect(exchange.project.title_ko).toBe('가상사업 A');
    expect(exchange.report_status.VA01_가상보고서A).toBe('draft');
  });

  it('lists the fixture Markdown files under the expected vault directories', () => {
    const files = fs.readdirSync(path.join(fixtureRoot, '30_Entities/사업'));
    expect(files.sort()).toEqual(['P1_VA01.md', 'P2_VB01.md']);
  });
});
