import { z } from 'zod';
import { SPEAKERS, VERDICT_STATUSES } from '../store/types';

export const AiEvidenceSchema = z.object({
  quote: z.string().min(1, '인용문은 비어 있을 수 없습니다'),
  document_id: z.string().min(1, '문서 식별자는 비어 있을 수 없습니다'),
  location: z.string().min(1, '위치는 비어 있을 수 없습니다'),
  speaker: z.enum(SPEAKERS),
}).strict();

export const AiSuggestionSchema = z.object({
  verdict_status: z.enum(VERDICT_STATUSES),
  sentence: z.string().trim().min(1, '제안 문장은 비어 있을 수 없습니다'),
  evidences: z.array(AiEvidenceSchema),
}).strict();

export type AiSuggestion = z.infer<typeof AiSuggestionSchema>;
export type AiEvidence = z.infer<typeof AiEvidenceSchema>;

export const AI_SUGGESTION_JSON_SCHEMA = {
  type: 'object',
  properties: {
    verdict_status: {
      type: 'string',
      enum: ['실현', '추진 중', '기대', '미확인', '근거 충돌'],
      description: '지표의 달성 상태 판정',
    },
    sentence: {
      type: 'string',
      description: '판정을 뒷받침하는 제안 서술 문장',
    },
    evidences: {
      type: 'array',
      description: '제안 문장을 뒷받침하는 원문 근거 목록',
      items: {
        type: 'object',
        properties: {
          quote: { type: 'string', description: '원문 문장 정확한 인용' },
          document_id: { type: 'string', description: '인용한 문서 식별자' },
          location: { type: 'string', description: '인용한 문단의 위치 (예: ¶1 또는 1쪽 ¶2)' },
          speaker: {
            type: 'string',
            enum: ['KDI', '협력국', '심사위원', '수행기관'],
            description: '인용 문장을 말한 주체',
          },
        },
        required: ['quote', 'document_id', 'location', 'speaker'],
        additionalProperties: false,
      },
    },
  },
  required: ['verdict_status', 'sentence', 'evidences'],
  additionalProperties: false,
} as const;

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface AiUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  reasoning_tokens?: number;
  total_tokens?: number;
}

export interface AiCallMeta {
  usage?: AiUsage;
  duration_ms: number;
}

export interface AiSuggestionResult {
  suggestion: AiSuggestion;
  meta: AiCallMeta;
}

export const AiReportSentenceSchema = z.object({
  indicator_id: z.string().min(1),
  sentence: z.string().min(1),
  evidence_ids: z.array(z.string()),
}).strict();

export const AiReportResponseSchema = z.object({
  sentences: z.array(AiReportSentenceSchema),
}).strict();

export type AiReportSentence = z.infer<typeof AiReportSentenceSchema>;
export type AiReportResponse = z.infer<typeof AiReportResponseSchema>;

export const AI_REPORT_JSON_SCHEMA = {
  type: 'object',
  properties: {
    sentences: {
      type: 'array',
      description: '확정된 판단과 근거를 바탕으로 작성된 성과 분석 서술 문장 목록',
      items: {
        type: 'object',
        properties: {
          indicator_id: { type: 'string', description: '관련 성과지표 식별자' },
          sentence: { type: 'string', description: '근거 인용문과 수치·단위가 일치하는 서술 문장' },
          evidence_ids: {
            type: 'array',
            description: '이 문장을 뒷받침하는 근거 식별자 목록',
            items: { type: 'string' },
          },
        },
        required: ['indicator_id', 'sentence', 'evidence_ids'],
        additionalProperties: false,
      },
    },
  },
  required: ['sentences'],
  additionalProperties: false,
} as const;

export interface AiReportResult {
  report: AiReportResponse;
  meta: AiCallMeta;
}
