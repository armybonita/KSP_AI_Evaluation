import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const appRoot = path.resolve(__dirname, '..');

describe('경계 검사 단위 시험 (RQ-24, RQ-25, RQ-26)', () => {
  it('boundary-check.mjs 가 오류 없이 성공(종료 코드 0)해야 한다', () => {
    const result = execFileSync('node', ['scripts/boundary-check.mjs'], {
      cwd: appRoot,
      encoding: 'utf8',
    });

    expect(result).toContain('경계 검사 통과:');
    expect(result).toContain('DB 접근이 저장 모듈(app/src/server/store/) 밖에 없음 (0건)');
    expect(result).toContain('AI 호출이 AI 모듈(app/src/server/ai/) 밖에 없음 (0건)');
    expect(result).toContain('저장소 전체에서 키 패턴 0건');
    expect(result).toContain('app/fixtures/ 밖에 문서 형식 파일 0건');
    expect(result).toContain('app/fixtures/ 모든 파일이 README.md에 "지어낸 자료"와 함께 등록됨');
    expect(result).toContain('app/src 에서 fixtures/answers.json 참조 0건');
  });

  describe('위반 탐지 및 비정상 종료 단언 (RQ-24, RQ-25, RQ-26)', () => {
    const fs = require('node:fs');
    const os = require('node:os');

    function createMinimalValidDir(): string {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'boundary-test-'));
      fs.mkdirSync(path.join(tmp, 'src/server/store'), { recursive: true });
      fs.writeFileSync(path.join(tmp, 'src/server/store/db.ts'), '// db');
      fs.mkdirSync(path.join(tmp, 'src/server/ai'), { recursive: true });
      fs.writeFileSync(path.join(tmp, 'src/server/ai/client.ts'), '// ai client');
      fs.mkdirSync(path.join(tmp, 'fixtures'), { recursive: true });
      fs.writeFileSync(
        path.join(tmp, 'fixtures/README.md'),
        '# 가상 자료\n- test.txt: 지어낸 자료\n'
      );
      fs.writeFileSync(path.join(tmp, 'fixtures/test.txt'), 'fixture file');
      return tmp;
    }

    function runChecker(targetDir: string) {
      return execFileSync('node', [path.join(appRoot, 'scripts/boundary-check.mjs'), targetDir], {
        cwd: appRoot,
        encoding: 'utf8',
        stdio: 'pipe',
      });
    }

    it('저장 모듈 밖에서 DB 라이브러리에 직접 접근하면 비정상 종료한다', () => {
      const tmp = createMinimalValidDir();
      try {
        fs.mkdirSync(path.join(tmp, 'src/other'), { recursive: true });
        fs.writeFileSync(
          path.join(tmp, 'src/other/db-leak.ts'),
          "import Database from 'better-sqlite3';"
        );

        expect(() => runChecker(tmp)).toThrowError();
        try {
          runChecker(tmp);
        } catch (err: any) {
          expect(err.stderr || err.stdout).toContain('[DB 경계 위반]');
        }
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    it('scripts/ 에서 직접 SQL(.prepare) 또는 DB 라이브러리에 접근하면 비정상 종료한다', () => {
      const tmp = createMinimalValidDir();
      try {
        fs.mkdirSync(path.join(tmp, 'scripts'), { recursive: true });
        fs.writeFileSync(
          path.join(tmp, 'scripts/seed-leak.ts'),
          "const insert = db.prepare('INSERT INTO ...');"
        );

        expect(() => runChecker(tmp)).toThrowError();
        try {
          runChecker(tmp);
        } catch (err: any) {
          expect(err.stderr || err.stdout).toContain('[DB 경계 위반]');
        }
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    it('다른 경로에 위치한 같은 이름(boundary-check.mjs)의 파일은 제외되지 않고 검사되어 위반 시 비정상 종료한다', () => {
      const tmp = createMinimalValidDir();
      try {
        fs.mkdirSync(path.join(tmp, 'scripts'), { recursive: true });
        fs.writeFileSync(
          path.join(tmp, 'scripts/boundary-check.mjs'),
          "import Database from 'better-sqlite3';"
        );

        expect(() => runChecker(tmp)).toThrowError();
        try {
          runChecker(tmp);
        } catch (err: any) {
          expect(err.stderr || err.stdout).toContain('[DB 경계 위반]');
          expect(err.stderr || err.stdout).toContain('scripts/boundary-check.mjs');
        }
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    it('AI 모듈 밖에서 fetch/axios/openai 등 AI 호출 및 엔드포인트를 사용하면 비정상 종료한다', () => {
      const tmp = createMinimalValidDir();
      try {
        fs.mkdirSync(path.join(tmp, 'src/other'), { recursive: true });
        fs.writeFileSync(
          path.join(tmp, 'src/other/ai-caller.ts'),
          "export async function callApi() { return fetch('https://api.openai.com/v1'); }"
        );

        expect(() => runChecker(tmp)).toThrowError();
        try {
          runChecker(tmp);
        } catch (err: any) {
          expect(err.stderr || err.stdout).toContain('[AI 경계 위반]');
        }
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    it('디렉터리 내에 비밀키 패턴이 검출되면 비정상 종료한다', () => {
      const tmp = createMinimalValidDir();
      try {
        fs.mkdirSync(path.join(tmp, 'src/leak'), { recursive: true });
        // 동적으로 조합하여 테스트 소스 자체에 키 패턴이 노출되지 않도록 함
        const fakeKey = ['sk', 'proj', '1234567890abcdefghij'].join('-');
        fs.writeFileSync(
          path.join(tmp, 'src/leak/key.ts'),
          `const leaked = '${fakeKey}';`
        );

        expect(() => runChecker(tmp)).toThrowError();
        try {
          runChecker(tmp);
        } catch (err: any) {
          expect(err.stderr || err.stdout).toContain('[키 패턴 검출]');
        }
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    it('fixtures 디렉터리 밖에 문서 형식 파일이 존재하면 비정상 종료한다', () => {
      const tmp = createMinimalValidDir();
      try {
        fs.mkdirSync(path.join(tmp, 'docs'), { recursive: true });
        fs.writeFileSync(path.join(tmp, 'docs/sample.docx'), 'fake docx');

        expect(() => runChecker(tmp)).toThrowError();
        try {
          runChecker(tmp);
        } catch (err: any) {
          expect(err.stderr || err.stdout).toContain('[자료 경계 위반]');
        }
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    it('app/src 디렉터리 내에서 fixtures/answers.json을 참조하거나 import하면 비정상 종료한다', () => {
      const tmp = createMinimalValidDir();
      try {
        fs.mkdirSync(path.join(tmp, 'src/logic'), { recursive: true });
        fs.writeFileSync(
          path.join(tmp, 'src/logic/cheat.ts'),
          "import answers from '../../fixtures/answers.json';"
        );

        expect(() => runChecker(tmp)).toThrowError();
        try {
          runChecker(tmp);
        } catch (err: any) {
          expect(err.stderr || err.stdout).toContain('[정답표 경계 위반]');
        }
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });
  });
});

