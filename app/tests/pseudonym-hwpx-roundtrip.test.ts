import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import JSZip from 'jszip';
import { expect, it } from 'vitest';
import { extractDocx } from '../src/server/extract/docx';

it('HWPX 병합과 머리말 및 빈 칸을 가명화 DOCX로 왕복해 표 번호를 보존한다', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pseudo-hwpx-'));
  try {
    const source = join(dir, 'sample.hwpx');
    const input = join(dir, 'in');
    const output = join(dir, 'out');
    mkdirSync(input);
    const p = (text: string) => `<hp:p><hp:run><hp:t>${text}</hp:t></hp:run></hp:p>`;
    const cell = (text: string, span = '') => `<hp:tc>${span}<hp:subList>${p(text)}</hp:subList></hp:tc>`;
    const table = (rows: string[]) => `<hp:p><hp:run><hp:tbl>${rows.map(row => `<hp:tr>${row}</hp:tr>`).join('')}</hp:tbl></hp:run></hp:p>`;
    const first = table([cell('첫 칸', '<hp:cellSpan colSpan="2" rowSpan="2"/>') + cell('둘째 칸'), cell('아래') + cell('끝')]);
    const second = table([cell('') + cell('빈 칸 다음'), cell('다음 행') + cell('마지막')]);
    const zip = new JSZip();
    zip.file('Contents/section0.xml', `<root xmlns:hp="urn:test"><hp:header>${table([cell('머리말')])}</hp:header>${first}${second}</root>`);
    writeFileSync(source, await zip.generateAsync({ type: 'nodebuffer' }));
    const packageDir = resolve(process.cwd(), '../packages/pseudonym');
    const script = `import random, sys\nfrom pathlib import Path\nsys.path.insert(0, sys.argv[1])\nfrom aieas_pseudonym import core, extract\nsrc = extract.extract(Path(sys.argv[2]))\nres = core.process(src, {'entries': {}, 'counters': {}, 'perturb': {}}, random.Random(1), core.Options(server='http://localhost', extractor=lambda *a: ([], {}, {}), countries='keep'))\nPath(sys.argv[3]).write_text(res.text, encoding='utf-8')`;
    execFileSync('python3', ['-I', '-c', script, packageDir, source, join(input, 'doc-001.pseudo.txt')]);
    execFileSync('python3', ['-I', join(packageDir, 'to_docx.py'), input, output]);
    const result = await extractDocx(readFileSync(join(output, 'doc-001.docx')));
    expect(result.status).toBe('추출 완료');
    expect(result.paragraphs.map(p => [p.content, p.table_index ?? null, p.table_row ?? null, p.table_col ?? null])).toEqual([
      ['머리말', null, null, null],
      ['첫 칸', 0, 1, 1], ['둘째 칸', 0, 1, 2], ['아래', 0, 2, 1], ['끝', 0, 2, 2],
      ['빈 칸 다음', 1, 1, 2], ['다음 행', 1, 2, 1], ['마지막', 1, 2, 2],
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
