import { describe, expect, it } from 'vitest';
import { VOCAB } from './checker';
import { buildOntologyPrompt } from './generator';
import { ONTOLOGY_GENERATION_JSON_SCHEMA, OntologyGenerationResponseSchema } from './generator-types';

describe('ontology generation vocabulary', () => {
  it('binds remaining vocabulary fields across schema, validation and prompt while preserving empty values', () => {
    const snippet = { paragraph_id: 'p', quote: 'q', speaker: [...VOCAB.speaker][0], evidence_kind: [...VOCAB.evidence_kind][0], evidence_level: [...VOCAB.evidence_level][0], category: [...VOCAB.category][0], fact: '', interpretation: '', uncertainty: '', observed_date: '', proves_indices: [], supports_indices: [], contradicts_indices: [] };
    const node = { type: 'activity', name: '가상 점', description: '', evidence_indices: [], outcome_family: '', outcome_type: '', outcome_state_ai: [...VOCAB.outcome_state_ai][0], timing: '', pdm_stage: '', factor_scope: '', factor_class: '', response: '', output_type: '', institution_type: '', date_start: '', date_end: '', place: '', baseline: null, target: null, actual: null, verification_source: '' };
    const response = { snippets: [snippet], nodes: [node], edges: [] };
    const snippetFields = ONTOLOGY_GENERATION_JSON_SCHEMA.properties.snippets.items.properties;
    const nodeFields = ONTOLOGY_GENERATION_JSON_SCHEMA.properties.nodes.items.properties;

    for (const field of ['evidence_level', 'outcome_family', 'outcome_type', 'outcome_state_ai', 'timing', 'pdm_stage', 'factor_scope', 'factor_class', 'output_type', 'institution_type'] as const) {
      const isSnippet = field === 'evidence_level';
      const allowsEmpty = !isSnippet;
      const values = [...VOCAB[field]];
      const schemaField = isSnippet ? snippetFields.evidence_level : nodeFields[field];
      const withValue = (value: string) => isSnippet
        ? { ...response, snippets: [{ ...snippet, [field]: value }] }
        : { ...response, nodes: [{ ...node, [field]: value }] };

      expect(schemaField.enum).toEqual(allowsEmpty ? ['', ...values] : values);
      expect(buildOntologyPrompt()).toContain(values.join('·'));
      for (const value of values) expect(OntologyGenerationResponseSchema.safeParse(withValue(value)).success).toBe(true);
      expect(OntologyGenerationResponseSchema.safeParse(withValue('허용 밖')).success).toBe(false);
      expect(OntologyGenerationResponseSchema.safeParse(withValue('')).success).toBe(allowsEmpty);
    }
    for (const type of ['implementer', 'policy-area']) expect(OntologyGenerationResponseSchema.safeParse({ ...response, nodes: [{ ...node, type }] }).success).toBe(true);
    expect(ONTOLOGY_GENERATION_JSON_SCHEMA.properties.edges.items.properties.relation.enum).toContain('verified_by');
    expect(OntologyGenerationResponseSchema.safeParse({ ...response, nodes: [{ ...node, response: '행정 절차를 단축했다' }] }).success).toBe(true);
    for (const field of ['status', 'level', 'score', 'rating', 'approval', 'approved', 'hitl_approved'] as const) {
      expect(OntologyGenerationResponseSchema.safeParse({ ...response, nodes: [{ ...node, [field]: 'approved' }] }).success).toBe(false);
    }
  });
});
