import fs from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import { loadRhwpModule } from '../src/server/extract/hwp';

const FIXTURES_DIR = path.resolve(process.cwd(), 'fixtures');
const LEGACY_FIXTURES_DIR = path.join(FIXTURES_DIR, 'legacy');

export const LEGACY_HWP_PARAGRAPHS = [
  '가상 사업 옛 한글 회의록 (지어낸 자료)',
  '회의 일시: 가상 2차연도 3분기 정기 점검 회의.',
  '현지 교육 과정 수료생은 목표 120명 가운데 96명으로 집계되었다.',
  '교육 만족도 조사는 다음 분기에 실시할 예정이다.',
  '장비 지원 품목 가운데 노트북 40대는 현지에 도착하였다.',
];

export const FAKE_FIXTURE_PASSWORD = 'not-a-secret-fixture';

// ---------------- HWPX 생성 헬퍼 ----------------
export async function createHwpx(paragraphs: string[]): Promise<Buffer> {
  const zip = new JSZip();

  const pXmls = paragraphs
    .map(
      (text, idx) => `  <hp:p id="${idx}">
    <hp:run>
      <hp:t>${escapeXml(text)}</hp:t>
    </hp:run>
  </hp:p>`
    )
    .join('\n');

  const sectionXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<hs:sec xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph">
${pXmls}
</hs:sec>`;

  zip.file('mimetype', 'application/hwp+zip');
  zip.file('Contents/section0.xml', sectionXml);

  return zip.generateAsync({ type: 'nodebuffer' });
}

export async function createHwp(
  paragraphs: string[],
  options: { password?: string; table?: (string | string[])[][] } = {}
): Promise<Buffer> {
  const { HwpDocument } = await loadRhwpModule();
  const doc = HwpDocument.createEmpty();

  try {
    doc.createBlankDocument();
    if (paragraphs.length > 0) {
      doc.insertText(0, 0, 0, paragraphs[0]);
      for (let index = 1; index < paragraphs.length; index++) {
        const previousLength = doc.getParagraphLength(0, index - 1);
        doc.splitParagraph(0, index - 1, previousLength);
        doc.insertText(0, index, 0, paragraphs[index]);
      }
    }

    if (options.table && options.table.length > 0) {
      const rowCount = options.table.length;
      const colCount = Math.max(...options.table.map((row) => row.length));
      const anchorParagraph = doc.getParagraphCount(0) - 1;
      const anchorOffset = doc.getParagraphLength(0, anchorParagraph);
      const table = JSON.parse(
        doc.createTable(0, anchorParagraph, anchorOffset, rowCount, colCount)
      ) as { paraIdx: number; controlIdx: number };

      for (let cell = 0; cell < rowCount * colCount; cell++) {
        const cellInfo = JSON.parse(
          doc.getCellInfo(0, table.paraIdx, table.controlIdx, cell)
        ) as { row: number; col: number };
        const cellValue = options.table[cellInfo.row]?.[cellInfo.col] ?? '';
        const cellParagraphs = typeof cellValue === 'string' ? [cellValue] : cellValue;

        for (let cellParagraph = 0; cellParagraph < cellParagraphs.length; cellParagraph++) {
          if (cellParagraph > 0) {
            const previousParagraph = cellParagraph - 1;
            const previousLength = doc.getCellParagraphLength(
              0,
              table.paraIdx,
              table.controlIdx,
              cell,
              previousParagraph
            );
            doc.splitParagraphInCell(
              0,
              table.paraIdx,
              table.controlIdx,
              cell,
              previousParagraph,
              previousLength
            );
          }

          const content = cellParagraphs[cellParagraph];
          if (content) {
            doc.insertTextInCell(
              0,
              table.paraIdx,
              table.controlIdx,
              cell,
              cellParagraph,
              0,
              content
            );
          }
        }
      }
    }

    const hwp = options.password ? doc.exportHwpWithPassword(options.password) : doc.exportHwp();
    return Buffer.from(hwp);
  } finally {
    doc.free();
  }
}

// .doc is kept from the virtual HTML source via:
// soffice --headless --convert-to 'doc:MS Word 97' --outdir fixtures/legacy fixtures/legacy/13_legacy_minutes.html
export async function buildLegacyFixtures(): Promise<void> {
  fs.mkdirSync(LEGACY_FIXTURES_DIR, { recursive: true });

  const normalHwp = await createHwp(LEGACY_HWP_PARAGRAPHS);
  fs.writeFileSync(path.join(LEGACY_FIXTURES_DIR, '09_legacy_minutes.hwp'), normalHwp);
  fs.writeFileSync(
    path.join(LEGACY_FIXTURES_DIR, '10_legacy_minutes_password.hwp'),
    // public-safety-allow: 지어낸 시험 견본용 가상 암호 상수, 실제 비밀 아님
    await createHwp(LEGACY_HWP_PARAGRAPHS, { password: FAKE_FIXTURE_PASSWORD })
  );
  fs.writeFileSync(
    path.join(LEGACY_FIXTURES_DIR, '11_legacy_minutes_corrupt.hwp'),
    normalHwp.subarray(0, 600)
  );
  fs.writeFileSync(
    path.join(LEGACY_FIXTURES_DIR, '12_legacy_table.hwp'),
    await createHwp(LEGACY_HWP_PARAGRAPHS, {
      table: [
        ['구분', '결과'],
        [['수료생', '추가 이수 실적은 가상으로 작성됨.'], '96명'],
      ],
    })
  );
}

// ---------------- DOCX 생성 헬퍼 ----------------
async function createDocx(paragraphs: string[]): Promise<Buffer> {
  const zip = new JSZip();

  const pXmls = paragraphs
    .map(
      (text) => `    <w:p>
      <w:r>
        <w:t xml:space="preserve">${escapeXml(text)}</w:t>
      </w:r>
    </w:p>`
    )
    .join('\n');

  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
${pXmls}
  </w:body>
</w:document>`;

  const contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

  const relsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

  zip.file('[Content_Types].xml', contentTypesXml);
  zip.file('_rels/.rels', relsXml);
  zip.file('word/document.xml', documentXml);

  return zip.generateAsync({ type: 'nodebuffer' });
}

// ---------------- PDF 생성 헬퍼 (UTF-16BE / ToUnicode CMap 기반 순수 JS) ----------------
function createPdf(pagesContent: (string | string[])[][]): Buffer {
  const cmap = `/CIDInit /ProcSet findresource begin
12 dict begin
begincmap
/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def
/CMapName /Custom-ToUnicode def
/CMapType 2 def
1 begincodespacerange
<0000> <FFFF>
endcodespacerange
1 beginbfrange
<0000> <FFFF> <0000>
endbfrange
endcmap
CMapName currentdict /CMap defineresource pop
end
end`;

  const cmapObjId = 4;
  const fontObjId = 3;
  const catalogObjId = 1;
  const pagesObjId = 2;

  const totalPages = pagesContent.length;
  const pageObjIds: number[] = [];
  const contentObjs: string[] = [];

  for (let i = 0; i < totalPages; i++) {
    const paras = pagesContent[i];
    let streamContent = 'BT /F1 12 Tf\n';
    let y = 750;
    for (const para of paras) {
      const lines = Array.isArray(para) ? para : [para];
      for (let l = 0; l < lines.length; l++) {
        const line = lines[l];
        const hex = line
          .split('')
          .map((c) => c.charCodeAt(0).toString(16).padStart(4, '0'))
          .join('');
        streamContent += `1 0 0 1 50 ${y} Tm <${hex}> Tj\n`;
        if (l < lines.length - 1) {
          y -= 18; // 동일 문단 내 줄바꿈 간격 (높이 12)
        }
      }
      y -= 36; // 문단 사이 간격 (> 12 * 1.5)
    }
    streamContent += 'ET\n';
    contentObjs.push(streamContent);
  }

  for (let i = 0; i < totalPages; i++) {
    pageObjIds.push(4 + i + 1);
  }
  const contentObjStart = 4 + totalPages + 1;

  const offsets: number[] = [0];
  let pdf = '%PDF-1.4\n%\x00\xff\x00\xff\n';

  function writeObj(num: number, body: string) {
    offsets[num] = Buffer.byteLength(pdf, 'utf8');
    pdf += `${num} 0 obj\n${body}\nendobj\n`;
  }

  writeObj(catalogObjId, `<< /Type /Catalog /Pages ${pagesObjId} 0 R >>`);
  writeObj(
    pagesObjId,
    `<< /Type /Pages /Kids [${pageObjIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${totalPages} >>`
  );
  writeObj(
    fontObjId,
    `<< /Type /Font /Subtype /Type0 /BaseFont /CustomFont /Encoding /Identity-H /DescendantFonts [<< /Type /Font /Subtype /CIDFontType2 /BaseFont /CustomFont /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor << /Type /FontDescriptor /FontName /CustomFont /Flags 4 /FontBBox [-1000 -1000 1000 1000] /ItalicAngle 0 /Ascent 800 /Descent -200 /CapHeight 800 /StemV 80 >> >>] /ToUnicode ${cmapObjId} 0 R >>`
  );
  writeObj(cmapObjId, `<< /Length ${Buffer.byteLength(cmap, 'utf8')} >>\nstream\n${cmap}\nendstream`);

  for (let i = 0; i < totalPages; i++) {
    const pId = pageObjIds[i];
    const cId = contentObjStart + i;
    writeObj(
      pId,
      `<< /Type /Page /Parent ${pagesObjId} 0 R /MediaBox [0 0 1200 1200] /Resources << /Font << /F1 ${fontObjId} 0 R >> >> /Contents ${cId} 0 R >>`
    );
  }

  for (let i = 0; i < totalPages; i++) {
    const cId = contentObjStart + i;
    const body = contentObjs[i];
    writeObj(cId, `<< /Length ${Buffer.byteLength(body, 'utf8')} >>\nstream\n${body}\nendstream`);
  }

  const totalObjs = 4 + totalPages * 2;
  const xrefOffset = Buffer.byteLength(pdf, 'utf8');
  // public-safety-allow: PDF xref table entry format, not a card number
  pdf += `xref\n0 ${totalObjs + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= totalObjs; i++) {
    pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${totalObjs + 1} /Root ${catalogObjId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  return Buffer.from(pdf, 'utf8');
}

// 텍스트 레이어가 전혀 없는 빈 PDF 생성 (읽지 못함 함정)
function createEmptyPdf(): Buffer {
  const offsets: number[] = [0];
  let pdf = '%PDF-1.4\n%\x00\xff\x00\xff\n';

  function write(num: number, body: string) {
    offsets[num] = Buffer.byteLength(pdf, 'utf8');
    pdf += `${num} 0 obj\n${body}\nendobj\n`;
  }

  write(1, '<< /Type /Catalog /Pages 2 0 R >>');
  write(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  write(3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>');

  const startXref = Buffer.byteLength(pdf, 'utf8');
  // public-safety-allow: PDF xref table entry format, not a card number
  pdf += `xref\n0 4\n0000000000 65535 f \n`;
  for (let i = 1; i <= 3; i++) {
    pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n${startXref}\n%%EOF\n`;

  return Buffer.from(pdf, 'utf8');
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// ---------------- 가상 자료 생성 메인 ----------------
export async function buildFixtures(): Promise<void> {
  fs.mkdirSync(FIXTURES_DIR, { recursive: true });

  // 1. 사업계획서 (01_project_plan.hwpx)
  // 함정 1 포함 (수치 충돌 A: 만족도 80% 달성)
  const hwpxContent = [
    '가상국 디지털 행정 역량 강화 사업 사업계획서',
    '사업 기간: 2024.01 - 2026.12',
    '본 사업은 가상국 행정 업무 전산화 및 공공 데이터 연계를 목표로 한다.',
    '핵심 성과지표로서 행정 시스템 이용 만족도 80% 달성을 최종 목표로 설정한다.',
    '수행기관 가상IT컨소시엄은 단계별 이행 계획에 따라 시스템을 납품하여야 한다.',
  ];
  fs.writeFileSync(path.join(FIXTURES_DIR, '01_project_plan.hwpx'), await createHwpx(hwpxContent));

  // 2. 성과관리표 (02_pdm.docx)
  // 성과 경로 계층 (영향/중기성과/단기성과/산출물/활동)
  // 함정 1 포함 (수치 충돌 B: 5점 척도 3.5점 달성)
  // 함정 2 포함 (근거 없는 판단: 법제 정비율 지표)
  const pdmContent = [
    '성과관리표(PDM) - 가상국 디지털 행정 역량 강화 사업',
    '사업 기간: 2024.01 - 2026.12',
    '영향 단계 성과지표로 대국민 전자정부 서비스 체감 만족도 5점 척도 3.5점 달성을 설정함.',
    '중기성과 지표: 행정 업무 처리 시간 30% 단축 달성.',
    '단기성과 지표: 디지털 공공 포털 가입자 100만명 확보 달성.',
    '산출물 지표: 통합 플랫폼 1식 개발 완료 및 검수 통과.',
    '활동 지표: 핵심 공무원 500명 이수 완료 달성.',
    '함정지표: 가상국 디지털 법제 정비율 100% 달성.',
  ];
  fs.writeFileSync(path.join(FIXTURES_DIR, '02_pdm.docx'), await createDocx(pdmContent));

  // 3. 출장결과보고서 (03_trip_report.pdf)
  // 2쪽으로 구성, 쪽 번호 유지
  // 함정 5 포함 (인용 금지 문장: 이름을 밝히지 말아 달라고 요청함)
  const tripReportPages = [
    [
      '가상국 디지털 행정 현지 출장결과보고서',
      '사업명: 가상국 디지털 행정 역량 강화 사업 (2024.01 - 2026.12)',
      '출장 기간: 2025.10.12 - 2025.10.18',
      '출장자: 가상평가단 현지실사팀',
      '현지 점검 결과: 통합 플랫폼 1식 개발 완료 및 검수 통과 확인됨.',
    ],
    [
      '관계자 면담 및 성과 점검 세부 내용',
      '교육 훈련 실적: 핵심 공무원 500명 이수 완료 달성을 현장에서 확인하였음.',
      [
        '면담에 참여한 현지 실무관은 이름을 밝히지 말아 달라고 요청하며',
        '초기 시스템 도입 과정에서 부서 간 이견이 상당했다고 진술함.',
      ],
      '포털 운영 현황: 단기성과인 디지털 공공 포털 가입자 100만명 확보 달성이 양호하게 추진 중임.',
    ],
  ];
  fs.writeFileSync(path.join(FIXTURES_DIR, '03_trip_report.pdf'), createPdf(tripReportPages));

  // 4. 심사 의견과 반영비교표 (04_review_opinion.docx)
  const reviewContent = [
    '심사 의견 및 반영비교표 - 가상국 디지털 행정 역량 강화 사업',
    '사업 기간: 2024.01 - 2026.12',
    '심사위원 검토 의견에 따라 보안성 검토 기준을 보완 반영함.',
    '협력국 요청사항에 따라 모바일 접근성 개선 방안을 추가 수립함.',
  ];
  fs.writeFileSync(path.join(FIXTURES_DIR, '04_review_opinion.docx'), await createDocx(reviewContent));

  // 5. 다른 사업 자료 섞임 함정 (05_other_project.docx)
  // 기본 제외 대상 (다른 사업 자료)
  const otherProjectContent = [
    '이웃국 항만 물류 정보시스템 구축사업 완료보고서',
    '사업 기간: 2021.05 - 2023.11',
    '본 보고서는 이웃국 항만청의 물류 전산화 지원 사업에 대한 최종 완료 결과이다.',
    '가상국 디지털 행정 사업과는 무관한 타 사업 자료임.',
  ];
  fs.writeFileSync(path.join(FIXTURES_DIR, '05_other_project.docx'), await createDocx(otherProjectContent));

  // 6. 개인 서류 섞임 함정 (06_personal_memo.pdf)
  // 기본 제외 대상 (개인 서류)
  const personalMemoPages = [
    [
      '개인 출장 여비 정산 신청서',
      '신청자: 평가원 개인 연구원',
      '항공료 및 숙박비 실비 영수증을 첨부하여 여비 정산을 청구합니다.',
      '본 문서는 공무 여비 정산용 개인 서류입니다.',
    ],
  ];
  fs.writeFileSync(path.join(FIXTURES_DIR, '06_personal_memo.pdf'), createPdf(personalMemoPages));

  // 7. 텍스트 없는 파일 함정 (07_empty.pdf)
  // 읽지 못함 상태 확인용
  fs.writeFileSync(path.join(FIXTURES_DIR, '07_empty.pdf'), createEmptyPdf());

  // 8. 무관 문서 함정 (08_irrelevant_note.docx)
  // 사업명과 사업 기간이 모두 언급되지 않은 문서 (기본 제외 대상)
  const irrelevantContent = [
    '사내 전자기기 반출입 및 정보보안 준수 안내문',
    '전자기기 반출 시 사전 승인 절차를 준수해야 합니다.',
    '임직원은 보안 점검 지침을 철저히 따라 주시기 바랍니다.',
  ];
  fs.writeFileSync(path.join(FIXTURES_DIR, '08_irrelevant_note.docx'), await createDocx(irrelevantContent));

  await buildLegacyFixtures();
  console.log('가상 자료 생성 완료: 기존 8개 파일과 W-06 옛 한글 견본을 빌드했습니다.');
}

if (process.argv[1]?.endsWith('build.ts')) {
  const build = process.argv.includes('--legacy-only') ? buildLegacyFixtures : buildFixtures;
  build().catch((err) => {
    console.error('가상 자료 생성 실패:', err);
    process.exit(1);
  });
}
