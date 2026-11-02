import { extractText, extractTextItems } from 'unpdf';
import { ExtractedParagraph, ExtractionResult } from './types';

export async function extractPdf(data: Buffer | Uint8Array): Promise<ExtractionResult> {
  const uint8Data = new Uint8Array(
    data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
  );

  let textItemsResult: {
    totalPages: number;
    items: Array<Array<{ str: string; y: number; height?: number; fontSize?: number }>>;
  } | null = null;

  try {
    textItemsResult = await extractTextItems(uint8Data);
  } catch {
    // extractTextItems 실패 시 text 기반 폴백
  }

  const paragraphs: ExtractedParagraph[] = [];
  let globalSeq = 1;

  if (textItemsResult && textItemsResult.totalPages > 0) {
    for (let pageIdx = 0; pageIdx < textItemsResult.totalPages; pageIdx++) {
      const pageNum = pageIdx + 1;
      const items = textItemsResult.items[pageIdx] ?? [];
      if (items.length === 0) continue;

      // 같은 줄(y 좌표 오차 2 이내)의 항목들을 줄 단위로 묶음
      const lines: Array<{ y: number; height: number; text: string }> = [];
      let currentLine: { y: number; height: number; text: string } | null = null;

      for (const item of items) {
        if (!currentLine || Math.abs(item.y - currentLine.y) > 2) {
          if (currentLine) lines.push(currentLine);
          currentLine = {
            y: item.y,
            height: item.height || item.fontSize || 12,
            text: item.str,
          };
        } else {
          currentLine.text += item.str;
          if ((item.height || 0) > currentLine.height) {
            currentLine.height = item.height!;
          }
        }
      }
      if (currentLine) lines.push(currentLine);

      // 빈 줄 및 y 간격(줄 높이 초과 여부)을 기준으로 문단 경계 그룹핑
      let currentParaLines: string[] = [];
      let prevLine: { y: number; height: number; text: string } | null = null;
      let pageParaIdx = 1;

      for (const line of lines) {
        const trimmed = line.text.trim();
        if (trimmed.length === 0) {
          // 빈 줄 -> 문단 마감
          if (currentParaLines.length > 0) {
            paragraphs.push({
              sequence_no: globalSeq++,
              location: `${pageNum}쪽 ¶${pageParaIdx++}`,
              content: currentParaLines.join(' '),
            });
            currentParaLines = [];
          }
          prevLine = null;
          continue;
        }

        if (prevLine !== null) {
          const gap = prevLine.y - line.y;
          const threshold = (prevLine.height || 12) * 1.5;
          if (gap > threshold) {
            // y 간격이 줄 높이보다 큼 -> 새 문단 경계
            if (currentParaLines.length > 0) {
              paragraphs.push({
                sequence_no: globalSeq++,
                location: `${pageNum}쪽 ¶${pageParaIdx++}`,
                content: currentParaLines.join(' '),
              });
              currentParaLines = [];
            }
          }
        }

        currentParaLines.push(trimmed);
        prevLine = line;
      }

      if (currentParaLines.length > 0) {
        paragraphs.push({
          sequence_no: globalSeq++,
          location: `${pageNum}쪽 ¶${pageParaIdx++}`,
          content: currentParaLines.join(' '),
        });
      }
    }
  } else {
    // 텍스트 기반 폴백
    let extracted: { totalPages: number; text: string[] };
    try {
      extracted = await extractText(uint8Data);
    } catch {
      return { status: '읽지 못함', paragraphs: [] };
    }

    for (let pageIdx = 0; pageIdx < extracted.totalPages; pageIdx++) {
      const pageNum = pageIdx + 1;
      const pageText = extracted.text[pageIdx] ?? '';
      const blocks = pageText.split(/\n\s*\n+/);
      let pageParaIdx = 1;

      for (const block of blocks) {
        const combined = block
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean)
          .join(' ')
          .trim();

        if (combined.length > 0) {
          paragraphs.push({
            sequence_no: globalSeq++,
            location: `${pageNum}쪽 ¶${pageParaIdx++}`,
            content: combined,
          });
        }
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
