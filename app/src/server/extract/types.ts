export interface ExtractedParagraph {
  sequence_no: number;
  location: string;
  content: string;
  table_index?: number | null;
  table_cols?: number | null;
  table_row?: number;
  table_col?: number;
  /** Grid coordinate interpretation used when this paragraph was extracted. */
  grid_coord_version?: number | null;
}

export interface ExtractionResult {
  status: '추출 완료' | '읽지 못함';
  paragraphs: ExtractedParagraph[];
  reason?: string;
}
