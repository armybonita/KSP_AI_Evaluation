import { performance } from 'node:perf_hooks';
import { openDatabase, getReviewData, getReportTargets, getBannedSentencesByProject } from '../src/server/store/db';
import { getProjectOntologyGraph } from '../src/server/store/ontology';
import { getNoteReviewData, getNoteReviewItemIds } from '../src/server/store/note-review';
import { isProjectPdmRegistered } from '../src/server/project-pdm';
import { assertProjectVisibleToCurrentViewer } from '../src/server/project-visibility';
import { getTocPageDataAction } from '../src/app/projects/[projectId]/toc/actions';
const path = process.env.AIEAS_DB_PATH;
if (!path || !process.env.TMPDIR || !path.startsWith(`${process.env.TMPDIR}/`)) throw new Error('synthetic database under TMPDIR required');
process.env.AIEAS_AUTH_MODE = 'local';
openDatabase(path);
const mode = process.argv[2];
const funcs: Record<string, () => unknown> = {
  toc: () => getTocPageDataAction('project-0'),
  graph: () => getProjectOntologyGraph('project-0'),
  review: () => getNoteReviewData('project-0'),
  pdm: () => isProjectPdmRegistered('project-0'),
  visibility: () => assertProjectVisibleToCurrentViewer('project-0'),
  toc_total: async () => { await assertProjectVisibleToCurrentViewer('project-0'); isProjectPdmRegistered('project-0'); await getTocPageDataAction('project-0'); getProjectOntologyGraph('project-0', openDatabase(path), false); getNoteReviewItemIds('project-0'); },
  review_total: async () => { await assertProjectVisibleToCurrentViewer('project-0'); isProjectPdmRegistered('project-0'); getReviewData('project-0'); getNoteReviewData('project-0'); },
  report_total: async () => { await assertProjectVisibleToCurrentViewer('project-0'); isProjectPdmRegistered('project-0'); getReportTargets('project-0'); getBannedSentencesByProject('project-0'); },
};
if (!funcs[mode]) throw new Error('unknown benchmark');
const start = performance.now();
Promise.resolve(funcs[mode]()).then(() => {
  const seconds = (performance.now() - start) / 1000;
  console.log(`${mode}: ${seconds.toFixed(3)}s`);
  const limits: Record<string, number> = { toc_total: 1, review_total: 2, report_total: 2 };
  if (process.env.BENCHMARK_ASSERT === '1' && limits[mode] && seconds > limits[mode]) throw new Error(`${mode} exceeded ${limits[mode]}s`);
});
