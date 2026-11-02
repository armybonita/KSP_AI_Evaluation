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

function extractTextFromXml(xml: string): string {
  const tMatches = xml.match(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/gi) || [];
  const textParts = tMatches.map((tXml) => {
    const inner = tXml.replace(/^<w:t\b[^>]*>/i, '').replace(/<\/w:t>$/i, '');
    return decodeXmlEntities(inner);
  });
  return textParts.join('').trim();
}

// Find paired elements at the current level, keeping nested tables inside their cell.
function elements(xml: string, tag: string, firstOnly = false): string[] {
  const tags = new RegExp(`<(/?)${tag}\\b[^>]*>`, 'gi');
  const result: string[] = [];
  let depth = 0;
  let start = 0;
  let match: RegExpExecArray | null;
  while ((match = tags.exec(xml))) {
    if (match[1]) {
      if (depth > 0 && --depth === 0) {
        result.push(xml.slice(start, tags.lastIndex));
        if (firstOnly) break;
      }
    } else if (match[0].endsWith('/>')) {
      if (depth === 0) {
        result.push(match[0]);
        if (firstOnly) break;
      }
    } else {
      if (depth++ === 0) start = match.index;
    }
  }
  return result;
}

function gridSpan(cell: string): number {
  const value = cell.match(/<w:gridSpan\b[^>]*\bw:val=["'](\d+)["']/i)?.[1];
  return Math.max(1, Number(value) || 1);
}

function gridBefore(row: string): number {
  return Number(row.match(/<w:gridBefore\b[^>]*\bw:val=["'](\d+)["']/i)?.[1]) || 0;
}

export async function extractDocx(data: Buffer | Uint8Array): Promise<ExtractionResult> {
  const zip = await JSZip.loadAsync(data);

  const docFile = zip.file('word/document.xml');
  if (!docFile) {
    return { status: '읽지 못함', paragraphs: [] };
  }

  const xml = await docFile.async('text');
  const paragraphs: ExtractedParagraph[] = [];
  let seq = 1;
  let tableIndex = 0;

  const bodyMatch = xml.match(/<w:body\b[^>]*>([\s\S]*?)<\/w:body>/i);
  if (!bodyMatch) {
    return { status: '읽지 못함', paragraphs: [] };
  }

  const body = bodyMatch[1];
  const tagRe = /<(w:p|w:tbl)\b/gi;
  let match;

  while ((match = tagRe.exec(body)) !== null) {
    const tag = match[1];
    const startIndex = match.index;
    const opening = body.slice(startIndex).match(/^<[^>]*>/)?.[0];
    if (opening?.endsWith('/>')) {
      tagRe.lastIndex = startIndex + opening.length;
      continue;
    }
    const elementXml = elements(body.slice(startIndex), tag, true)[0];
    if (!elementXml) break;
    tagRe.lastIndex = startIndex + elementXml.length;

    if (tag === 'w:p') {
      const fullText = extractTextFromXml(elementXml);
      if (fullText.length > 0) {
        paragraphs.push({
          sequence_no: seq,
          location: `¶${seq}`,
          content: fullText,
        });
        seq++;
      }
    } else if (tag === 'w:tbl') {
      const index = tableIndex++;
      const trMatches = elements(elementXml, 'w:tr');
      const grid = elementXml.match(/<w:tblGrid\b[^>]*>([\s\S]*?)<\/w:tblGrid>/i)?.[1];
      const gridCols = grid?.match(/<w:gridCol\b[^>]*\/?\s*>/gi)?.length ?? 0;
      const tableCols = Math.max(gridCols, ...trMatches.map(row => gridBefore(row) + elements(row, 'w:tc').reduce((sum, cell) => sum + gridSpan(cell), 0)));
      trMatches.forEach((trXml, rIndex) => {
        const tcMatches = elements(trXml, 'w:tc');
        let col = gridBefore(trXml) + 1;
        tcMatches.forEach((tcXml) => {
          const cellCol = col;
          col += gridSpan(tcXml);
          const fullText = extractTextFromXml(tcXml);
          if (fullText.length > 0) {
            paragraphs.push({
              sequence_no: seq,
              location: `¶${seq}`,
              content: fullText,
              table_index: index,
              table_cols: tableCols,
              table_row: rIndex + 1,
              table_col: cellCol,
              grid_coord_version: 1,
            });
            seq++;
          }
        });
      });
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
