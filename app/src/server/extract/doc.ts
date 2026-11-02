import WordExtractor from 'word-extractor';
import { ExtractedParagraph, ExtractionResult } from './types';

const PASSWORD_REASON = '암호가 걸린 워드 문서라 읽지 못합니다. 암호를 풀어 다시 올려 주세요.';
const INVALID_DOC_REASON = '워드 문서가 손상되었거나 DOC 형식이 아니라 읽지 못합니다.';
const NO_TEXT_REASON = '글자를 찾지 못했습니다(그림만 있는 문서일 수 있음).';

function splitNonEmptyLines(text: string): string[] {
  return text
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function extractDoc(data: Buffer | Uint8Array): Promise<ExtractionResult> {
  try {
    const extractor = new WordExtractor();
    const document = await extractor.extract(Buffer.from(data));
    const contents = [
      ...splitNonEmptyLines(document.getBody({ filterUnicode: false })),
      ...splitNonEmptyLines(
        document.getTextboxes({
          filterUnicode: false,
          includeHeadersAndFooters: false,
        })
      ),
    ];

    if (contents.length === 0) {
      return { status: '읽지 못함', paragraphs: [], reason: NO_TEXT_REASON };
    }

    const paragraphs: ExtractedParagraph[] = contents.map((content, index) => ({
      sequence_no: index + 1,
      location: '¶' + (index + 1),
      content,
    }));

    return { status: '추출 완료', paragraphs };
  } catch (error) {
    const message = errorMessage(error);
    return {
      status: '읽지 못함',
      paragraphs: [],
      // word-extractor 1.0.4 exposes no typed password error, so keep message matching here.
      reason: /암호|password/i.test(message) ? PASSWORD_REASON : INVALID_DOC_REASON,
    };
  }
}
