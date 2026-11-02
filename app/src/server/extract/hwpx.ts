import JSZip from 'jszip';
import { ExtractedParagraph, ExtractionResult } from './types';

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

export async function extractHwpx(data: Buffer | Uint8Array): Promise<ExtractionResult> {
  const zip = await JSZip.loadAsync(data);

  // Contents/section*.xml 파일들을 순서대로 찾는다
  const sectionFiles = Object.keys(zip.files)
    .filter((name) => /^Contents\/section\d+\.xml$/i.test(name))
    .sort((a, b) => {
      const numA = parseInt(a.replace(/\D/g, ''), 10) || 0;
      const numB = parseInt(b.replace(/\D/g, ''), 10) || 0;
      return numA - numB;
    });

  if (sectionFiles.length === 0) {
    return { status: '읽지 못함', paragraphs: [] };
  }

  const paragraphs: ExtractedParagraph[] = [];
  let seq = 1;

  for (const filename of sectionFiles) {
    const file = zip.file(filename);
    if (!file) continue;

    const xml = await file.async('text');
    // 문단 태그 <hp:p> 또는 <p> 매칭
    const pMatches = xml.match(/<(?:hp:)?p\b[\s\S]*?<\/(?:hp:)?p>/gi) || [];

    for (const pXml of pMatches) {
      // 문단 안의 텍스트 태그 <hp:t> 또는 <t> 매칭
      const tMatches = pXml.match(/<(?:hp:)?t\b[^>]*>([\s\S]*?)<\/(?:hp:)?t>/gi) || [];
      const textParts = tMatches.map((tXml) => {
        const inner = tXml.replace(/^<(?:hp:)?t\b[^>]*>/i, '').replace(/<\/(?:hp:)?t>$/i, '');
        return decodeXmlEntities(inner);
      });

      const fullText = textParts.join('').trim();
      if (fullText.length > 0) {
        paragraphs.push({
          sequence_no: seq,
          location: `¶${seq}`,
          content: fullText,
        });
        seq++;
      }
    }
  }

  if (paragraphs.length === 0) {
    return { status: '읽지 못함', paragraphs: [] };
  }

  return {
    status: '추출 완료',
    paragraphs,
  };
}
