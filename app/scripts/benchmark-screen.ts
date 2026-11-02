/** Server page timing and JSON equivalence using a synthetic database under TMPDIR. */
import { performance } from 'node:perf_hooks';
import { writeFileSync } from 'node:fs';
import { openDatabase, getReviewData, getReportTargets } from '../src/server/store/db';
import { getProjectOntologyGraph } from '../src/server/store/ontology';
import { getSavedReportDraft } from '../src/server/report';
import { getNoteReviewData } from '../src/server/store/note-review';
import { getTocPageDataAction } from '../src/app/projects/[projectId]/toc/actions';
import TocPage from '../src/app/projects/[projectId]/toc/page';
import ReviewPage from '../src/app/projects/[projectId]/review/page';
import ReportPage from '../src/app/projects/[projectId]/report/page';
import ResultPage from '../src/app/projects/[projectId]/result/page';
const dbPath = process.env.AIEAS_DB_PATH;
if (!dbPath || !process.env.TMPDIR || !dbPath.startsWith(`${process.env.TMPDIR}/`)) throw new Error('synthetic database under TMPDIR required');
process.env.AIEAS_AUTH_MODE = 'local';
openDatabase(dbPath);
const params = Promise.resolve({ projectId: 'project-0' });
const functions: Record<string, () => unknown> = {
  toc: () => TocPage({ params }), graph: () => TocPage({ params, searchParams: Promise.resolve({ view: 'graph' }) }),
  review: () => ReviewPage({ params, searchParams: Promise.resolve({}) }), report: () => ReportPage({ params }), result: () => ResultPage({ params }),
  note_json: () => getNoteReviewData('project-0'), review_json: () => getReviewData('project-0'),
  report_json: () => ({ targets: getReportTargets('project-0'), draft: getSavedReportDraft('project-0') }), toc_json: () => getTocPageDataAction('project-0'), graph_json: () => getProjectOntologyGraph('project-0'),
};
const mode = process.argv[2];
if (!functions[mode]) throw new Error('unknown benchmark');
async function run() {
  const iterations = mode.endsWith('_json') ? 1 : 2;
  for (let iteration = 0; iteration < iterations; iteration++) {
    const start = performance.now();
    const value = await functions[mode]();
    const seconds = (performance.now() - start) / 1000;
    console.log(`${mode} ${iteration === 0 ? 'first' : 'second'}: ${seconds.toFixed(3)}s`);
    if (mode.endsWith('_json')) writeFileSync(`${process.env.TMPDIR}/${process.env.SNAPSHOT_PREFIX}-${mode}.json`, JSON.stringify(value));
    const limits: Record<string, number> = { toc: 1, review: 2, report: 2, result: 2, graph: 3 };
    if (process.env.BENCHMARK_ASSERT === '1' && limits[mode] && seconds > limits[mode]) throw new Error(`${mode} exceeded ${limits[mode]}s`);
  }
}
void run();
