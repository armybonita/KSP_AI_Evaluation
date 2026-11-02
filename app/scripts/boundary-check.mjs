import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { fileURLToPath } from 'node:url';

const targetArg = process.argv[2];
const appRoot = targetArg ? path.resolve(targetArg) : path.resolve(import.meta.dirname, '..');
const repoRoot = targetArg ? appRoot : path.resolve(appRoot, '..');
const selfPath = path.resolve(fileURLToPath(import.meta.url));

const errors = [];

// ============================================================================
// 1. DB 접근이 저장 모듈 밖에 없음 (RQ-26)
// ============================================================================
function checkDbBoundary() {
  const dirs = [path.join(appRoot, 'src'), path.join(appRoot, 'scripts')];

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;

    function walk(currentDir) {
      for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
        const full = path.join(currentDir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.(ts|tsx|js|mjs)$/.test(entry.name)) continue;

        // boundary-check.mjs 자체는 검사 정규식을 포함하므로 이 파일의 절대 경로 일치로만 제외
        if (path.resolve(full) === selfPath) continue;

        const rel = path.relative(appRoot, full).replace(/\\/g, '/');
        // app/src/server/store/ 만 DB 라이브러리에 직접 접근 가능
        if (rel.startsWith('src/server/store/')) continue;

        const content = fs.readFileSync(full, 'utf8');
        if (
          /from\s+['"]better-sqlite3['"]/.test(content) ||
          /require\(['"]better-sqlite3['"]\)/.test(content) ||
          /from\s+['"]node:sqlite['"]/.test(content) ||
          /require\(['"]node:sqlite['"]\)/.test(content) ||
          /\bnew\s+Database\s*\(/.test(content) ||
          /\.prepare\s*\(/.test(content)
        ) {
          errors.push(`[DB 경계 위반] 저장 모듈 밖에서 DB 라이브러리 또는 SQL(prepare)에 직접 접근함: ${rel}`);
        }
      }
    }

    walk(dir);
  }
}

// ============================================================================
// 2. AI 호출이 AI 모듈 밖에 없음 (RQ-25)
// ============================================================================
// Next.js 기본 코드 및 향후 허용이 필요한 파일 명시적 허용 목록
const AI_BOUNDARY_ALLOWLIST = new Set([]);

function checkAiBoundary() {
  const srcDir = path.join(appRoot, 'src');
  if (!fs.existsSync(srcDir)) return;

  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(ts|tsx|js|mjs)$/.test(entry.name)) continue;

      const rel = path.relative(srcDir, full).replace(/\\/g, '/');
      // app/src/server/ai/ 만 AI 엔드포인트 및 환경변수를 직접 다룰 수 있음
      if (rel.startsWith('server/ai/')) continue;
      if (AI_BOUNDARY_ALLOWLIST.has(rel)) continue;

      const content = fs.readFileSync(full, 'utf8');
      if (/chat\/completions/.test(content)) {
        errors.push(`[AI 경계 위반] AI 모듈 밖에서 chat/completions 엔드포인트 참조: src/${rel}`);
      }
      if (/\bfetch\s*\(/.test(content)) {
        errors.push(`[AI 경계 위반] AI 모듈 밖에서 fetch( 사용: src/${rel}`);
      }
      if (/\bundici\b/.test(content)) {
        errors.push(`[AI 경계 위반] AI 모듈 밖에서 undici 라이브러리 사용: src/${rel}`);
      }
      if (/\baxios\b/.test(content)) {
        errors.push(`[AI 경계 위반] AI 모듈 밖에서 axios 라이브러리 사용: src/${rel}`);
      }
      if (/\bopenai\b/i.test(content)) {
        errors.push(`[AI 경계 위반] AI 모듈 밖에서 openai 라이브러리 사용: src/${rel}`);
      }
      if (/process\.env\.AIEAS_LLM_BASE_URL/.test(content)) {
        errors.push(`[AI 경계 위반] AI 모듈 밖에서 AIEAS_LLM_BASE_URL 직접 참조: src/${rel}`);
      }
      if (/process\.env\.AIEAS_LLM_API_KEY/.test(content)) {
        errors.push(`[AI 경계 위반] AI 모듈 밖에서 AIEAS_LLM_API_KEY 직접 참조: src/${rel}`);
      }
      if (/process\.env\.AIEAS_MODEL/.test(content)) {
        errors.push(`[AI 경계 위반] AI 모듈 밖에서 AIEAS_MODEL 직접 참조: src/${rel}`);
      }
      if (/process\.env\.AIEAS_REASONING_EFFORT/.test(content)) {
        errors.push(`[AI 경계 위반] AI 모듈 밖에서 AIEAS_REASONING_EFFORT 직접 참조: src/${rel}`);
      }
    }
  }

  walk(srcDir);
}

// ============================================================================
// 3. 저장소 전체에서 키 패턴 0건 (RQ-25, 보안)
// ============================================================================
function checkSecretKeyPatterns() {
  const excludedDirs = new Set(['.git', 'node_modules', '.next', '.next-e2e']);
  const suspicious = [
    { id: 'aws-access-key', re: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA)[0-9A-Z]{16}\b/ },
    { id: 'github-token', re: /\bgh[pousr]_[0-9A-Za-z]{30,}\b/ },
    { id: 'slack-token', re: /\bxox[abprs]-[0-9A-Za-z-]{10,}\b/ },
    { id: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{30,}\b/ },
    { id: 'openai-key', re: /\bsk-(?:live-|proj-)?[0-9A-Za-z_-]{16,}\b/ },
    { id: 'discord-bot-token', re: /\b[MNO][0-9A-Za-z_-]{22,}\.[0-9A-Za-z_-]{6}\.[0-9A-Za-z_-]{25,}\b/ },
  ];

  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (excludedDirs.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }

      // 이진 파일이나 큰 파일 제외
      const data = fs.readFileSync(full);
      if (data.includes(0)) continue;

      const text = data.toString('utf8');
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const context = `${lines[i - 1] ?? ''}\n${line}`;
        if (context.includes('public-safety-allow:')) continue;
        for (const { id, re } of suspicious) {
          if (re.test(line)) {
            const rel = path.relative(repoRoot, full);
            errors.push(`[키 패턴 검출] ${rel}:${i + 1} (${id})`);
            break;
          }
        }
      }
    }
  }

  walk(repoRoot);
}

// ============================================================================
// 4. app/fixtures/ 밖에 hwpx/docx/pdf/hwp/xlsx/pptx 0건 (RQ-24)
// ============================================================================
function checkDocumentFileBoundary() {
  const docExtensions = new Set(['.hwpx', '.docx', '.doc', '.pdf', '.hwp', '.xlsx', '.pptx', '.hwt']);
  const excludedDirs = new Set(['.git', 'node_modules', '.next', '.next-e2e']);
  const normalizedFixturesPath = path.join(appRoot, 'fixtures').replace(/\\/g, '/');

  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (excludedDirs.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }

      const ext = path.extname(entry.name).toLowerCase();
      if (docExtensions.has(ext)) {
        const normalizedFull = full.replace(/\\/g, '/');
        if (!normalizedFull.startsWith(normalizedFixturesPath + '/')) {
          const rel = path.relative(repoRoot, full);
          errors.push(`[자료 경계 위반] app/fixtures/ 밖에 문서 형식 파일이 존재함: ${rel}`);
        }
      }
    }
  }

  walk(repoRoot);
}

// ============================================================================
// 5. app/fixtures/README.md 파일 목록 및 "지어낸 자료" 문구 확인 (RQ-24)
// ============================================================================
function checkFixturesReadme() {
  const fixturesDir = path.join(appRoot, 'fixtures');
  if (!fs.existsSync(fixturesDir)) {
    errors.push('[가상 자료 경계 위반] app/fixtures/ 디렉터리가 존재하지 않음');
    return;
  }

  const readmePath = path.join(fixturesDir, 'README.md');
  if (!fs.existsSync(readmePath)) {
    errors.push('[가상 자료 경계 위반] app/fixtures/README.md 파일이 존재하지 않음');
    return;
  }

  const readmeContent = fs.readFileSync(readmePath, 'utf8');
  const readmeLines = readmeContent.split('\n');
  const allFixtureFiles = [];

  function collectFixtureFiles(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        collectFixtureFiles(full);
      } else if (path.resolve(full) !== path.resolve(readmePath)) {
        allFixtureFiles.push(path.relative(fixturesDir, full).split(path.sep).join('/'));
      }
    }
  }

  collectFixtureFiles(fixturesDir);

  for (const file of allFixtureFiles) {
    const matchingLine = readmeLines.find((line) => line.includes(file));
    if (!matchingLine) {
      errors.push(`[README 누락] app/fixtures/README.md 에 파일 누락: ${file}`);
    } else if (!matchingLine.includes('지어낸 자료')) {
      errors.push(`[README 문구 누락] app/fixtures/README.md 에 '지어낸 자료' 문구 누락: ${file}`);
    }
  }
}

// ============================================================================
// 6. app/src 에서 fixtures/answers.json 참조 0건 (런타임 정답표 참조 금지)
// ============================================================================
function checkAnswersJsonBoundary() {
  const srcDir = path.join(appRoot, 'src');
  if (!fs.existsSync(srcDir)) return;

  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(ts|tsx|js|mjs)$/.test(entry.name)) continue;

      const content = fs.readFileSync(full, 'utf8');
      if (
        /fixtures\/answers\.json/.test(content) ||
        /from\s+['"][^'"]*answers\.json['"]/.test(content) ||
        /require\(['"][^'"]*answers\.json['"]\)/.test(content) ||
        /\banswers\.json\b/.test(content)
      ) {
        const rel = path.relative(appRoot, full).replace(/\\/g, '/');
        errors.push(`[정답표 경계 위반] app/src 에서 fixtures/answers.json 참조 검출: ${rel}`);
      }
    }
  }

  walk(srcDir);
}

// ============================================================================
// 실행 및 결과 출력
// ============================================================================
checkDbBoundary();
checkAiBoundary();
checkSecretKeyPatterns();
checkDocumentFileBoundary();
checkFixturesReadme();
checkAnswersJsonBoundary();

if (errors.length > 0) {
  console.error('\n경계 검사 실패:');
  errors.forEach((e) => console.error(`  - ${e}`));
  process.exit(1);
}

console.log('경계 검사 통과:');
console.log('  - DB 접근이 저장 모듈(app/src/server/store/) 밖에 없음 (0건)');
console.log('  - AI 호출이 AI 모듈(app/src/server/ai/) 밖에 없음 (0건)');
console.log('  - 저장소 전체에서 키 패턴 0건');
console.log('  - app/fixtures/ 밖에 문서 형식 파일 0건');
console.log('  - app/fixtures/ 모든 파일이 README.md에 "지어낸 자료"와 함께 등록됨');
console.log('  - app/src 에서 fixtures/answers.json 참조 0건');

