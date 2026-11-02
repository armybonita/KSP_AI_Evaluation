import { z } from 'zod';
import { VOCAB } from './checker';

const enumWithEmpty = (values: Set<string>) => ['', ...values] as [string, ...string[]];
const speaker = [...VOCAB.speaker] as [string, ...string[]];
const evidenceKind = [...VOCAB.evidence_kind] as [string, ...string[]];
const category = [...VOCAB.category] as [string, ...string[]];
const evidenceLevel = [...VOCAB.evidence_level] as [string, ...string[]];
const nodeType = ['project', 'partner', 'implementer', 'policy-area', 'participant-org', 'activity', 'output', 'outcome-short', 'outcome-mid', 'indicator', 'enabler', 'constraint'] as const;
const relation = ['conducts', 'targets', 'partner', 'study_tour', 'participates_in', 'generates', 'induces', 'extends_to', 'measures', 'verified_by', 'promotes', 'hinders'] as const;
const measuredValue = z.union([z.number(), z.string(), z.null()]);

export const OntologyGenerationResponseSchema = z.object({
  snippets: z.array(z.object({
    paragraph_id: z.string().min(1), quote: z.string().min(1), speaker: z.enum(speaker),
    evidence_kind: z.enum(evidenceKind), evidence_level: z.enum(evidenceLevel), category: z.enum(category),
    fact: z.string(), interpretation: z.string(), uncertainty: z.string(), observed_date: z.string(),
    proves_indices: z.array(z.number().int()), supports_indices: z.array(z.number().int()), contradicts_indices: z.array(z.number().int()),
  }).strict()),
  nodes: z.array(z.object({
    type: z.enum(nodeType), name: z.string().min(1), description: z.string(), evidence_indices: z.array(z.number().int()),
    outcome_family: z.enum(enumWithEmpty(VOCAB.outcome_family)), outcome_type: z.enum(enumWithEmpty(VOCAB.outcome_type)),
    outcome_state_ai: z.enum(enumWithEmpty(VOCAB.outcome_state_ai)), timing: z.enum(enumWithEmpty(VOCAB.timing)),
    pdm_stage: z.enum(enumWithEmpty(VOCAB.pdm_stage)), factor_scope: z.enum(enumWithEmpty(VOCAB.factor_scope)),
    factor_class: z.enum(enumWithEmpty(VOCAB.factor_class)), response: z.string(),
    output_type: z.enum(enumWithEmpty(VOCAB.output_type)), institution_type: z.enum(enumWithEmpty(VOCAB.institution_type)),
    date_start: z.string(), date_end: z.string(), place: z.string(), baseline: measuredValue, target: measuredValue, actual: measuredValue,
    verification_source: z.string(),
  }).strict()),
  edges: z.array(z.object({ source_node_index: z.number().int(), target_node_index: z.number().int(), relation: z.enum(relation) }).strict()),
}).strict();

export type OntologyGenerationResponse = z.infer<typeof OntologyGenerationResponseSchema>;

const stringField = { type: 'string' } as const;
const measuredValueSchema = { anyOf: [{ type: 'number' }, { type: 'string' }, { type: 'null' }] } as const;
const snippetProperties = {
  paragraph_id: stringField, quote: stringField, speaker: { type: 'string', enum: speaker },
  evidence_kind: { type: 'string', enum: evidenceKind }, evidence_level: { type: 'string', enum: evidenceLevel }, category: { type: 'string', enum: category },
  fact: stringField, interpretation: stringField, uncertainty: stringField, observed_date: stringField,
  proves_indices: { type: 'array', items: { type: 'integer' } }, supports_indices: { type: 'array', items: { type: 'integer' } }, contradicts_indices: { type: 'array', items: { type: 'integer' } },
} as const;
const nodeProperties = {
  type: { type: 'string', enum: nodeType }, name: stringField, description: stringField, evidence_indices: { type: 'array', items: { type: 'integer' } },
  outcome_family: { type: 'string', enum: enumWithEmpty(VOCAB.outcome_family) }, outcome_type: { type: 'string', enum: enumWithEmpty(VOCAB.outcome_type) },
  outcome_state_ai: { type: 'string', enum: enumWithEmpty(VOCAB.outcome_state_ai) }, timing: { type: 'string', enum: enumWithEmpty(VOCAB.timing) },
  pdm_stage: { type: 'string', enum: enumWithEmpty(VOCAB.pdm_stage) }, factor_scope: { type: 'string', enum: enumWithEmpty(VOCAB.factor_scope) },
  factor_class: { type: 'string', enum: enumWithEmpty(VOCAB.factor_class) }, response: stringField,
  output_type: { type: 'string', enum: enumWithEmpty(VOCAB.output_type) }, institution_type: { type: 'string', enum: enumWithEmpty(VOCAB.institution_type) },
  date_start: stringField, date_end: stringField, place: stringField, baseline: measuredValueSchema, target: measuredValueSchema, actual: measuredValueSchema, verification_source: stringField,
} as const;
export const ONTOLOGY_GENERATION_JSON_SCHEMA = {
  type: 'object', properties: {
    snippets: { type: 'array', items: { type: 'object', properties: snippetProperties, required: Object.keys(snippetProperties), additionalProperties: false } },
    nodes: { type: 'array', items: { type: 'object', properties: nodeProperties, required: Object.keys(nodeProperties), additionalProperties: false } },
    edges: { type: 'array', items: { type: 'object', properties: { source_node_index: { type: 'integer' }, target_node_index: { type: 'integer' }, relation: { type: 'string', enum: relation } }, required: ['source_node_index', 'target_node_index', 'relation'], additionalProperties: false } },
  }, required: ['snippets', 'nodes', 'edges'], additionalProperties: false,
} as const;
