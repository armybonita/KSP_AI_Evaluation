import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { chromium } from '@playwright/test';

// 1. 브라우저 설치 및 실행 가능 여부 확인
let canRunChromium = false;
try {
  const executablePath = chromium.executablePath();
  if (executablePath && fs.existsSync(executablePath)) {
    execSync(`"${executablePath}" --version`, { stdio: 'ignore' });
    canRunChromium = true;
  }
} catch {
  canRunChromium = false;
}

if (!canRunChromium) {
  console.error('\n============================================================');
  console.error('[E2E] Chromium 브라우저가 없거나 실행할 수 없습니다.');
  console.error('브라우저 설치 방법:');
  console.error('  npx playwright install chromium');
  console.error('필수 시스템 라이브러리 설치 방법 (관리자 권한 필요):');
  console.error('  npx playwright install-deps chromium');
  console.error('============================================================\n');
  process.exit(1);
}

// 2. 결정적 --fake-ai 시드 데이터베이스 및 시험용 임시 업로드 폴더 준비
const appDir = path.resolve(import.meta.dirname, '..');
const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aieas-e2e-'));
const seedDbPath = path.join(runDir, 'seed.db');
const e2eUploadDir = path.join(runDir, 'seed-uploads');
const e2eDistDir = path.resolve(appDir, '.next-e2e');

// 기본 시험은 이전 산출물을 재사용하지 않는다. 명시적으로 요청한 경우에만 보존한다.
if (process.env.E2E_KEEP_BUILD !== '1') {
  fs.rmSync(e2eDistDir, { recursive: true, force: true });
}

fs.mkdirSync(e2eUploadDir, { recursive: true });

console.log('[E2E] --fake-ai 시드 데이터베이스 생성 중...');
try {
  execSync(`npx tsx scripts/seed-dev.ts --fake-ai --db "${seedDbPath}"`, {
    stdio: 'inherit',
    cwd: appDir,
    env: {
      ...process.env,
      AIEAS_DB_PATH: seedDbPath,
      AIEAS_UPLOAD_DIR: e2eUploadDir,
    },
  });
} catch (err) {
  console.error('[E2E 오류] 시드 데이터베이스 생성 실패:', err);
  fs.rmSync(runDir, { recursive: true, force: true });
  process.exit(1);
}

// 3. 빌드는 한 번만 실행한다. 각 테스트는 이 빌드와 독립 DB로 서버를 띄운다.
const testEnv = {
  ...process.env,
  AIEAS_E2E_RUN_DIR: runDir,
  AIEAS_E2E_SEED_DB: seedDbPath,
  PORT: process.env.PORT || '3041',
  AIEAS_E2E_FAKE_AI: '1',
  NEXT_DIST_DIR: '.next-e2e',
};

const args = process.argv.slice(2).join(' ');
const testCmd = args ? `npx playwright test ${args}` : 'npx playwright test';
console.log(`[E2E] Playwright 테스트 실행 중 (${testCmd})...`);
let exitCode = 0;
try {
  if (process.env.E2E_KEEP_BUILD !== '1') {
    execSync('npx next build', { stdio: 'inherit', cwd: appDir, env: testEnv });
  }
  execSync(testCmd, {
    stdio: 'inherit',
    cwd: appDir,
    env: testEnv,
  });
} catch (err) {
  exitCode =
    err && typeof err === 'object' && 'status' in err && typeof err.status === 'number'
      ? err.status
      : 1;
} finally {
  fs.rmSync(runDir, { recursive: true, force: true });
}

process.exit(exitCode);
