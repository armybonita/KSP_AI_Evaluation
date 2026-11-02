import { execSync } from 'node:child_process';
import path from 'node:path';

const appDir = path.resolve(import.meta.dirname, '..');

const targetTestFiles = [
  'tests/extract.test.ts',
  'tests/quote-verify.test.ts',
  'tests/citation-ban.test.ts',
  'tests/schema-verdict.test.ts',
  'tests/suggest.test.ts',
  'tests/review-ui.test.ts',
  'tests/confirmation.test.ts',
  'tests/history-ui.test.ts',
  'tests/report.test.ts',
  'tests/report-it.test.ts',
  'tests/report-ui.test.ts',
];

const categoryMap = [
  { match: (f) => f.includes('extract'), category: '추출' },
  { match: (f) => f.includes('quote-verify') || f.includes('citation-ban'), category: '인용 검증' },
  { match: (f) => f.includes('schema-verdict') || f.includes('suggest') || f.includes('review-ui'), category: '판정 상태' },
  { match: (f) => f.includes('confirmation') || f.includes('history-ui'), category: '이력 추가' },
  { match: (f) => f.includes('report'), category: '보고서 생성' },
];

function getCategory(filePath) {
  for (const entry of categoryMap) {
    if (entry.match(filePath)) {
      return entry.category;
    }
  }
  return '기타';
}

const testCmd = `npx vitest run ${targetTestFiles.join(' ')} --reporter=json`;

let stdout = '';
let execFailed = false;

try {
  stdout = execSync(testCmd, {
    cwd: appDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 50 * 1024 * 1024,
    env: {
      ...process.env,
      AIEAS_E2E_FAKE_AI: '1',
    },
  });
} catch (err) {
  execFailed = true;
  stdout = String(err.stdout ?? '') + '\n' + String(err.stderr ?? '');
}

// vitest JSON 리포터 출력 파싱 (출력 중 {"numTotalTestSuites": 찾기)
let jsonParsed = null;
const jsonStartIdx = stdout.indexOf('{"numTotalTestSuites":');
if (jsonStartIdx !== -1) {
  try {
    const rawJson = stdout.slice(jsonStartIdx);
    jsonParsed = JSON.parse(rawJson);
  } catch {
    jsonParsed = null;
  }
}

if (!jsonParsed || !Array.isArray(jsonParsed.testResults)) {
  console.error('[오류] vitest JSON 리포터 출력을 파싱할 수 없습니다.');
  console.error(stdout);
  process.exit(1);
}

const rows = [];
let totalRun = 0;
let totalPassed = 0;
let totalFailed = 0;

for (const targetFile of targetTestFiles) {
  const matched = jsonParsed.testResults.find((r) => r.name.replace(/\\/g, '/').endsWith(targetFile));
  const category = getCategory(targetFile);

  if (!matched) {
    rows.push({
      category,
      file: targetFile,
      total: 0,
      passed: 0,
      failed: 0,
      exitCode: 1,
      status: 'NOT_FOUND',
    });
    totalFailed += 1;
    continue;
  }

  const assertions = matched.assertionResults ?? [];
  const runCount = assertions.length;
  const failedCount = assertions.filter((a) => a.status === 'failed').length;
  const passedCount = assertions.filter((a) => a.status === 'passed').length;
  const fileExitCode = matched.status === 'passed' && failedCount === 0 ? 0 : 1;

  totalRun += runCount;
  totalPassed += passedCount;
  totalFailed += failedCount;

  rows.push({
    category,
    file: targetFile,
    total: runCount,
    passed: passedCount,
    failed: failedCount,
    exitCode: fileExitCode,
    status: fileExitCode === 0 ? 'PASS' : 'FAIL',
  });
}

// 표준출력에 마크다운 표 출력 (RQ-29)
console.log('');
console.log('========================================================================================');
console.log('[RQ-29 영수증] 시험 결과 요약표 (추출·인용 검증·판정 상태·이력 추가·보고서 생성)');
console.log('========================================================================================');
console.log('');
console.log('| 영역 | 시험 파일 | 실행 수 | 통과 수 | 실패 수 | 종료 코드 | 결과 |');
console.log('|:---|:---|:---:|:---:|:---:|:---:|:---:|');

for (const r of rows) {
  console.log(
    `| ${r.category} | ${r.file} | ${r.total} | ${r.passed} | ${r.failed} | ${r.exitCode} | ${r.status} |`
  );
}

const overallExitCode = totalFailed === 0 && !execFailed ? 0 : 1;
const overallVerdict = overallExitCode === 0 ? 'PASS' : 'FAIL';

console.log('|:---|:---|:---:|:---:|:---:|:---:|:---:|');
console.log(
  `| **합계** | **${rows.length}개 파일** | **${totalRun}** | **${totalPassed}** | **${totalFailed}** | **${overallExitCode}** | **${overallVerdict}** |`
);
console.log('');
console.log(`전체 판정: ${overallVerdict} (종료 코드: ${overallExitCode}, 총 실행 수: ${totalRun}, 실패 수: ${totalFailed})`);
console.log('========================================================================================');
console.log('');

process.exit(overallExitCode);
