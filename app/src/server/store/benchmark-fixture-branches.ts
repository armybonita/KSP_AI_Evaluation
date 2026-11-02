/** Additional synthetic review branches, also used on an already generated fixture. */
import type Database from 'better-sqlite3';
import { computeJudgmentFingerprint, REPORT_FINGERPRINT_VERSION } from '../report/service';

export function addFixtureBranches(db: Database.Database): void {
  const old = 'project-0-import-0', current = 'project-0-import-1';
  const addNode = db.prepare('INSERT INTO ontology_nodes(id,project_id,import_id,node_type,title,data_json) VALUES (?, ?, ?, ?, ?, ?)');
  const addKey = db.prepare('INSERT INTO ontology_review_node_keys VALUES (?, ?, ?, ?)');
  const addReview = db.prepare('INSERT INTO ontology_note_reviews VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const addAlias = db.prepare('INSERT INTO ontology_review_node_aliases VALUES (?, ?, ?, ?)');
  const addTitle = db.prepare('INSERT INTO ontology_review_node_titles VALUES (?, ?, ?, ?)');
  const addEvidence = db.prepare('INSERT INTO ontology_review_evidence_keys VALUES (?, ?, ?, ?, ?, ?)');
  const oldNodes = ['rename-old', 'split-old', 'merge-old-a', 'merge-old-b', 'uncertain'];
  db.transaction(() => {
    for (const id of oldNodes) {
      addNode.run(id, 'project-0', old, 'output', '가상 성과 개선', '{}');
      addKey.run('project-0', old, id, id === 'uncertain' ? '종류 불명' : 'output');
      addTitle.run('project-0', old, id, '가상 성과 개선');
      addReview.run(`branch-${id}`, 'project-0', old, id, '확정', '가상 검토', '가상 성과 개선', '관측됨', '', '', '가상 평가자', '2026-01-01');
      addEvidence.run('project-0', old, id, 'branch-source', '쪽 1', '같은 가상 근거 문장');
    }
    for (const id of ['rename-new', 'split-new-a', 'split-new-b', 'merge-new', 'uncertain']) {
      addNode.run(id, 'project-0', current, 'output', '가상 성과 개선안', '{}');
      addKey.run('project-0', current, id, 'output');
      addEvidence.run('project-0', current, id, id === 'uncertain' ? 'other-source' : 'branch-source', '쪽 1', '같은 가상 근거 문장');
    }
    // Old-only IDs force alias resolution; pairs also exercise many-to-one merges.
    for (let j = 0; j < 1000; j++) {
      const id = `legacy-branch-${j}`;
      const target = j < 500 ? Math.floor(j / 2) * 2 : (j - 500) * 2;
      addNode.run(id, 'project-0', old, 'output', `가상 노트 ${target}`, '{}');
      addKey.run('project-0', old, id, 'output');
      addTitle.run('project-0', old, id, `가상 노트 ${target}`);
      addReview.run(`branch-history-${j}`, 'project-0', old, id, '확정', '가상 검토', '가상 노트', '관측됨', '', '', '가상 평가자', '2026-01-01');
      addEvidence.run('project-0', old, id, `source-${target % 45}`, `쪽 ${target}`, `가상 근거 ${target}`);
      if (j < 750) addAlias.run('project-0', old, id, `node-${target}`);
    }
    for (const [a, b] of [['split-old', 'split-new'], ['merge-old-a', 'merge-new'], ['merge-old-b', 'merge-new']]) addAlias.run('project-0', old, a, b);
    db.prepare('INSERT INTO ontology_link_reviews VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('branch-link', 'project-0', old, 'rename-old', 'split-old', '확정', '가상 평가자', '2026-01-01');
    db.prepare('INSERT INTO ontology_link_review_details VALUES (?, ?, ?, ?)').run('branch-link', 'targets', '가상 검토', '');
    for (const target of ['split-new-a', 'split-new-b']) db.prepare('INSERT INTO ontology_relation_candidates VALUES (?, ?, ?, ?, ?)').run('project-0', current, 'rename-new', target, 'targets');
  })();
  const report = db.prepare('SELECT content_json FROM reports WHERE id = ?').get('report-0') as { content_json: string };
  const draft = JSON.parse(report.content_json);
  draft.fingerprint = computeJudgmentFingerprint('project-0', db);
  draft.fingerprint_version = REPORT_FINGERPRINT_VERSION;
  db.prepare('UPDATE reports SET content_json = ? WHERE id = ?').run(JSON.stringify(draft), 'report-0');
}
