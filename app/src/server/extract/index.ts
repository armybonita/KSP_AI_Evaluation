import { extractHwpx } from './hwpx';
import { extractHwp } from './hwp';
import { extractDocx } from './docx';
import { extractDoc } from './doc';
import { extractPdf } from './pdf';
import { ExtractedParagraph, ExtractionResult } from './types';

export * from './types';
export * from './hwpx';
export * from './hwp';
export * from './docx';
export * from './doc';
export * from './pdf';

export type DocumentFormat = 'hwp' | 'hwpx' | 'doc' | 'docx' | 'pdf' | (string & {});

export async function extractDocument(
  data: Buffer | Uint8Array,
  format: DocumentFormat
): Promise<ExtractionResult> {
  const normalizedFormat = format.toLowerCase().replace(/^\./, '');

  switch (normalizedFormat) {
    case 'hwp':
      return extractHwp(data);
    case 'hwpx':
      return extractHwpx(data);
    case 'doc':
      return extractDoc(data);
    case 'docx':
      return extractDocx(data);
    case 'pdf':
      return extractPdf(data);
    default:
      throw new Error(`지원하지 않는 문서 형식입니다: ${format}`);
  }
}
