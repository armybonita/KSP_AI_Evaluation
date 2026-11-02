import fs from 'node:fs';
import path from 'node:path';
import * as nodeModule from 'node:module';
import type { HwpDocument } from '@rhwp/core';
import { ExtractedParagraph, ExtractionResult } from './types';

type RhwpModule = typeof import('@rhwp/core');
type RhwpLoadOptions = { wasmPath?: string };

let rhwpModulePromise: Promise<RhwpModule> | undefined;

class RhwpEngineLoadError extends Error {
  constructor(readonly originalError: unknown) {
    super(errorMessage(originalError));
    this.name = 'RhwpEngineLoadError';
  }
}

function resolveRhwpWasmPath(options: RhwpLoadOptions = {}): string {
  if (options.wasmPath !== undefined) return path.resolve(options.wasmPath);

  const configuredPath = process.env.RHWP_WASM_PATH;
  if (configuredPath) return path.resolve(configuredPath);

  const appRequire = Reflect.apply(nodeModule.createRequire, undefined, [
    path.resolve(process.cwd(), 'package.json'),
  ]);
  return appRequire.resolve('@rhwp/core/rhwp_bg.wasm');
}

/**
 * WASM 찾기 순서: ① 호출자가 넘긴 `wasmPath` ② `RHWP_WASM_PATH`
 * ③ `process.cwd()/package.json` 기준 `@rhwp/core/rhwp_bg.wasm`.
 * 개발 서버는 앱 폴더에서 `npm run start`로 실행한다. cwd가 앱 폴더가 아니면 ① 또는 ②를 사용한다.
 */
export function loadRhwpModule(options: RhwpLoadOptions = {}): Promise<RhwpModule> {
  if (rhwpModulePromise) return rhwpModulePromise;

  let wasmPath: string;
  try {
    wasmPath = resolveRhwpWasmPath(options);
  } catch (error) {
    return Promise.reject(new RhwpEngineLoadError(error));
  }

  const pending = (async () => {
    try {
      const mod = await import('@rhwp/core');
      await mod.default({ module_or_path: fs.readFileSync(wasmPath) });
      return mod;
    } catch (error) {
      throw new RhwpEngineLoadError(error);
    }
  })();

  rhwpModulePromise = pending;
  void pending.catch(() => {
    if (rhwpModulePromise === pending) rhwpModulePromise = undefined;
  });
  return pending;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const PASSWORD_REASON = '암호가 걸린 한글 문서라 읽지 못합니다. 암호를 풀어 다시 올려 주세요.';
const INVALID_HWP_REASON = '한글 문서가 손상되었거나 HWP 형식이 아니라 읽지 못합니다.';
const ENGINE_LOAD_REASON = '한글 읽기 엔진을 불러오지 못했습니다(서버 설정 문제).';
const NO_TEXT_REASON = '글자를 찾지 못했습니다(그림만 있는 문서일 수 있음).';

/**
 * WASM 찾기 순서: ① 호출자가 넘긴 `wasmPath` ② `RHWP_WASM_PATH`
 * ③ `process.cwd()/package.json` 기준 `@rhwp/core/rhwp_bg.wasm`.
 * 개발 서버는 앱 폴더에서 `npm run start`로 실행한다. cwd가 앱 폴더가 아니면 ① 또는 ②를 사용한다.
 */
export async function extractHwp(
  data: Buffer | Uint8Array,
  options: RhwpLoadOptions = {}
): Promise<ExtractionResult> {
  let doc: HwpDocument | undefined;

  try {
    const { HwpDocument } = await loadRhwpModule(options);
    doc = new HwpDocument(new Uint8Array(data));

    const paragraphs: ExtractedParagraph[] = [];
    let sequence = 1;
    let tableIndex = 0;

    for (let section = 0; section < doc.getSectionCount(); section++) {
      const paragraphCount = doc.getParagraphCount(section);
      for (let paragraph = 0; paragraph < paragraphCount; paragraph++) {
        const length = doc.getParagraphLength(section, paragraph);
        const content = doc.getTextRange(section, paragraph, 0, length).trim();
        if (content.length > 0) {
          paragraphs.push({
            sequence_no: sequence,
            location: '¶' + sequence,
            content,
          });
          sequence++;
        }

        let controlCount = 0;
        try {
          const controlPositions = JSON.parse(doc.getControlTextPositions(section, paragraph));
          if (Array.isArray(controlPositions)) controlCount = controlPositions.length;
        } catch {
          controlCount = 0;
        }

        for (let control = 0; control < controlCount; control++) {
          let dimensions: { cellCount?: number; rowCount?: number; colCount?: number };
          try {
            dimensions = JSON.parse(doc.getTableDimensions(section, paragraph, control));
          } catch {
            // Text boxes and other controls are not tables.
            continue;
          }

          const cellCount =
            dimensions.cellCount ?? (dimensions.rowCount ?? 0) * (dimensions.colCount ?? 0);
          if (!Number.isInteger(cellCount) || cellCount <= 0) continue;

          const index = tableIndex++;
          for (let cell = 0; cell < cellCount; cell++) {
            try {
              const cellInfo = JSON.parse(
                doc.getCellInfo(section, paragraph, control, cell)
              ) as { row: number; col: number };
              const cellParagraphCount = doc.getCellParagraphCount(
                section,
                paragraph,
                control,
                cell
              );
              const cellParagraphs: string[] = [];

              for (let cellParagraph = 0; cellParagraph < cellParagraphCount; cellParagraph++) {
                const cellLength = doc.getCellParagraphLength(
                  section,
                  paragraph,
                  control,
                  cell,
                  cellParagraph
                );
                const content = doc
                  .getTextInCell(
                    section,
                    paragraph,
                    control,
                    cell,
                    cellParagraph,
                    0,
                    cellLength
                  )
                  .trim();
                if (content.length > 0) cellParagraphs.push(content);
              }

              const cellContent = cellParagraphs.join('\n');
              if (cellContent.length === 0) continue;

              paragraphs.push({
                sequence_no: sequence,
                location: '¶' + sequence,
                content: cellContent,
                table_index: index,
                table_cols: Number.isInteger(dimensions.colCount) && dimensions.colCount! > 0 ? dimensions.colCount : null,
                table_row: cellInfo.row + 1,
                table_col: cellInfo.col + 1,
                grid_coord_version: 1,
              });
              sequence++;
            } catch {
              // A malformed or unsupported cell does not hide the other cells.
            }
          }
        }
      }
    }

    if (paragraphs.length === 0) {
      return { status: '읽지 못함', paragraphs: [], reason: NO_TEXT_REASON };
    }

    return { status: '추출 완료', paragraphs };
  } catch (error) {
    if (error instanceof RhwpEngineLoadError) {
      const detail = errorMessage(error.originalError).replace(/\s+/g, ' ').trim();
      console.error('[hwp] RHWP WASM engine load failed: ' + detail);
      return { status: '읽지 못함', paragraphs: [], reason: ENGINE_LOAD_REASON };
    }

    const message = errorMessage(error);
    return {
      status: '읽지 못함',
      paragraphs: [],
      // rhwp 0.8.7 reports encrypted HWP as “비밀번호가 필요한 암호 문서입니다”; it has no typed error kind, so keep message matching.
      reason: /암호|password/i.test(message) ? PASSWORD_REASON : INVALID_HWP_REASON,
    };
  } finally {
    doc?.free();
  }
}
