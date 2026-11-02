import { isAbsolute, relative, resolve, sep } from 'node:path';
import { statSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

async function main(): Promise<void> {
const [databasePathArg, projectId = 'project-0'] = process.argv.slice(2);
const tmpRoot = process.env.TMPDIR ? resolve(process.env.TMPDIR) : '';
const databasePath = databasePathArg ? resolve(databasePathArg) : '';
const relativePath = tmpRoot && databasePath ? relative(tmpRoot, databasePath) : '..';
if (!tmpRoot || !databasePathArg || !isAbsolute(databasePathArg) || !statSync(databasePath, { throwIfNoEntry: false })?.isFile()
  || relativePath === '..' || relativePath.startsWith(`..${sep}`) || relativePath === '') {
  throw new Error('Pass an existing synthetic database located below TMPDIR.');
}

process.env.AIEAS_AUTH_MODE = 'local';
process.env.AIEAS_DB_PATH = databasePath;

const [{ openDatabase, saveReportDraft, getProject, closeDatabase }, { reportInputFingerprint, reportParagraphCount }, { REPORT_FINGERPRINT_VERSION }, { default: ReportPage }] = await Promise.all([
  import('../src/server/store/db'),
  import('../src/server/store/report-input'),
  import('../src/server/report/service'),
  import('../src/app/projects/[projectId]/report/page'),
]);
const db = openDatabase(databasePath);
const project = getProject(projectId, db);
if (!project) throw new Error(`Synthetic project not found: ${projectId}`);
const paragraphs = reportParagraphCount(projectId, db);
const fingerprint = reportInputFingerprint(projectId, db);
const now = new Date().toISOString();
saveReportDraft(projectId, JSON.stringify({
  project_id: projectId,
  project_name: project.name,
  confirmed_count: 0,
  created_at: now,
  draft_number: 1,
  fingerprint,
  judgment_fingerprint: fingerprint,
  fingerprint_version: REPORT_FINGERPRINT_VERSION,
  summary_format: 1,
  version: 2,
  template: 'ksp',
  report_sections: [{ id: 'synthetic-overview', title: '가상 사업 개요', level: 2, empty_message: '※ 근거 자료 미확보' }],
  footnotes: [],
  sections: {
    achievement_table: { title: '성과지표 달성표', rows: [] },
    performance_analysis: { title: '성과 분석', sentences: [] },
    contributing_factors: { title: '기여요인', sentences: [] },
    constraints_and_responses: { title: '제약요인과 대응' },
    lessons_learned: { title: '교훈' },
    monitoring_plan: { title: '모니터링 계획' },
    overall_evaluation: { title: '종합평가' },
  },
}), db);

const samples: number[] = [];
let markupLength = 0;
for (let run = 0; run < 6; run++) {
  const start = performance.now();
  const page = await ReportPage({ params: Promise.resolve({ projectId }) });
  const markup = renderToStaticMarkup(React.createElement(React.Fragment, null, page));
  const elapsed = performance.now() - start;
  if (!markup.includes('가상 사업 개요')) throw new Error('Rendered page did not contain the selected saved report.');
  markupLength = markup.length;
  if (run > 0) samples.push(elapsed);
}
samples.sort((a, b) => a - b);
const medianMs = samples[Math.floor(samples.length / 2)];
console.log(JSON.stringify({ projectId, paragraphs, warmRuns: samples.length, warmReadMs: samples, medianWarmReadMs: medianMs, markupBytes: markupLength }));
closeDatabase();
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
