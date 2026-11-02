// Evidence verification is independent of ontology snippet verification. A
// missing row means preparation is required, never that a quote was rejected.
export const EVIDENCE_QUOTE_CACHE_SQL = `
CREATE TABLE IF NOT EXISTS evidence_quote_verification_cache (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  evidence_id TEXT NOT NULL REFERENCES evidences(id) ON DELETE CASCADE,
  verified INTEGER NOT NULL CHECK(verified IN (0, 1)),
  algorithm_version INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (project_id, evidence_id)
);
CREATE INDEX IF NOT EXISTS idx_evidence_quote_cache_evidence ON evidence_quote_verification_cache(evidence_id);
CREATE INDEX IF NOT EXISTS idx_evquote_evidence_document ON evidences(document_id);

CREATE TRIGGER IF NOT EXISTS trg_evquote_evidence_insert AFTER INSERT ON evidences BEGIN
  DELETE FROM evidence_quote_verification_cache WHERE evidence_id = NEW.id;
END;
CREATE TRIGGER IF NOT EXISTS trg_evquote_evidence_update AFTER UPDATE ON evidences BEGIN
  DELETE FROM evidence_quote_verification_cache WHERE evidence_id IN (OLD.id, NEW.id);
END;
CREATE TRIGGER IF NOT EXISTS trg_evquote_evidence_delete BEFORE DELETE ON evidences BEGIN
  DELETE FROM evidence_quote_verification_cache WHERE evidence_id = OLD.id;
END;

-- Paragraphs can alter both the referenced original and the project that owns
-- a banned sentence. Invalidate all affected owners, including inconsistent
-- cross-project references instead of trusting them.
CREATE TRIGGER IF NOT EXISTS trg_evquote_paragraph_insert AFTER INSERT ON paragraphs BEGIN
  DELETE FROM evidence_quote_verification_cache
  WHERE project_id IN (SELECT project_id FROM documents WHERE id = NEW.document_id)
     OR evidence_id IN (SELECT id FROM evidences WHERE document_id = NEW.document_id);
END;
CREATE TRIGGER IF NOT EXISTS trg_evquote_paragraph_update AFTER UPDATE ON paragraphs BEGIN
  DELETE FROM evidence_quote_verification_cache
  WHERE project_id IN (SELECT project_id FROM documents WHERE id IN (OLD.document_id, NEW.document_id))
     OR evidence_id IN (SELECT id FROM evidences WHERE document_id IN (OLD.document_id, NEW.document_id));
END;
CREATE TRIGGER IF NOT EXISTS trg_evquote_paragraph_delete BEFORE DELETE ON paragraphs BEGIN
  DELETE FROM evidence_quote_verification_cache
  WHERE project_id IN (SELECT project_id FROM documents WHERE id = OLD.document_id)
     OR evidence_id IN (SELECT id FROM evidences WHERE document_id = OLD.document_id);
END;

-- Sentence ownership is determined through its paragraph, not its own
-- document_id, matching getBannedSentencesByProject.
CREATE TRIGGER IF NOT EXISTS trg_evquote_sentence_insert AFTER INSERT ON sentences WHEN NEW.is_citation_banned = 1 BEGIN
  DELETE FROM evidence_quote_verification_cache WHERE project_id IN
    (SELECT d.project_id FROM paragraphs p JOIN documents d ON d.id = p.document_id WHERE p.id = NEW.paragraph_id);
END;
CREATE TRIGGER IF NOT EXISTS trg_evquote_sentence_update AFTER UPDATE ON sentences WHEN OLD.is_citation_banned = 1 OR NEW.is_citation_banned = 1 BEGIN
  DELETE FROM evidence_quote_verification_cache WHERE project_id IN
    (SELECT d.project_id FROM paragraphs p JOIN documents d ON d.id = p.document_id WHERE p.id IN (OLD.paragraph_id, NEW.paragraph_id));
END;
CREATE TRIGGER IF NOT EXISTS trg_evquote_sentence_delete BEFORE DELETE ON sentences WHEN OLD.is_citation_banned = 1 BEGIN
  DELETE FROM evidence_quote_verification_cache WHERE project_id IN
    (SELECT d.project_id FROM paragraphs p JOIN documents d ON d.id = p.document_id WHERE p.id = OLD.paragraph_id);
END;

CREATE TRIGGER IF NOT EXISTS trg_evquote_document_insert AFTER INSERT ON documents BEGIN
  DELETE FROM evidence_quote_verification_cache WHERE
    (project_id = NEW.project_id AND EXISTS (SELECT 1 FROM paragraphs WHERE document_id = NEW.id))
     OR evidence_id IN (SELECT id FROM evidences WHERE document_id = NEW.id);
END;
CREATE TRIGGER IF NOT EXISTS trg_evquote_document_update AFTER UPDATE OF project_id ON documents WHEN OLD.project_id IS NOT NEW.project_id BEGIN
  DELETE FROM evidence_quote_verification_cache WHERE project_id IN (OLD.project_id, NEW.project_id)
     OR evidence_id IN (SELECT id FROM evidences WHERE document_id IN (OLD.id, NEW.id));
END;
CREATE TRIGGER IF NOT EXISTS trg_evquote_document_delete BEFORE DELETE ON documents BEGIN
  DELETE FROM evidence_quote_verification_cache WHERE project_id = OLD.project_id
     OR evidence_id IN (SELECT id FROM evidences WHERE document_id = OLD.id);
END;
CREATE TRIGGER IF NOT EXISTS trg_evquote_suggestion_update AFTER UPDATE OF indicator_id ON suggestions WHEN OLD.indicator_id IS NOT NEW.indicator_id BEGIN
  DELETE FROM evidence_quote_verification_cache WHERE evidence_id IN (SELECT id FROM evidences WHERE suggestion_id = NEW.id);
END;
CREATE TRIGGER IF NOT EXISTS trg_evquote_indicator_update AFTER UPDATE OF project_id ON indicators WHEN OLD.project_id IS NOT NEW.project_id BEGIN
  DELETE FROM evidence_quote_verification_cache WHERE evidence_id IN
    (SELECT e.id FROM evidences e JOIN suggestions s ON s.id = e.suggestion_id WHERE s.indicator_id = NEW.id);
END;
`;

export const QUOTE_CACHE_V3_SQL = `
-- v2 entries predate source-change invalidation and cannot be trusted here.
CREATE TABLE IF NOT EXISTS ontology_quote_verification_cache_v3 (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  import_id TEXT NOT NULL,
  snippet_id TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  snippet_hash TEXT NOT NULL,
  verified INTEGER NOT NULL,
  coverage REAL NOT NULL,
  PRIMARY KEY (project_id, import_id, snippet_id)
);
-- The source may contain a very large JSON body. Invalidate on writes rather
-- than reading or hashing it on every cache hit. INSERT also covers REPLACE.
CREATE TRIGGER IF NOT EXISTS trg_quote_source_insert AFTER INSERT ON ontology_sources BEGIN
  DELETE FROM ontology_quote_verification_cache_v3 WHERE project_id = NEW.project_id AND import_id = NEW.import_id;
END;
CREATE TRIGGER IF NOT EXISTS trg_quote_source_update AFTER UPDATE ON ontology_sources BEGIN
  DELETE FROM ontology_quote_verification_cache_v3 WHERE (project_id = OLD.project_id AND import_id = OLD.import_id) OR (project_id = NEW.project_id AND import_id = NEW.import_id);
END;
CREATE TRIGGER IF NOT EXISTS trg_quote_source_delete AFTER DELETE ON ontology_sources BEGIN
  DELETE FROM ontology_quote_verification_cache_v3 WHERE project_id = OLD.project_id AND import_id = OLD.import_id;
END;
CREATE TRIGGER IF NOT EXISTS trg_quote_snippet_insert AFTER INSERT ON ontology_snippets BEGIN
  DELETE FROM ontology_quote_verification_cache_v3 WHERE project_id = NEW.project_id AND import_id = NEW.import_id AND snippet_id = NEW.id;
END;
CREATE TRIGGER IF NOT EXISTS trg_quote_snippet_update AFTER UPDATE ON ontology_snippets BEGIN
  DELETE FROM ontology_quote_verification_cache_v3 WHERE (project_id = OLD.project_id AND import_id = OLD.import_id AND snippet_id = OLD.id) OR (project_id = NEW.project_id AND import_id = NEW.import_id AND snippet_id = NEW.id);
END;
CREATE TRIGGER IF NOT EXISTS trg_quote_snippet_delete AFTER DELETE ON ontology_snippets BEGIN
  DELETE FROM ontology_quote_verification_cache_v3 WHERE project_id = OLD.project_id AND import_id = OLD.import_id AND snippet_id = OLD.id;
END;
`;

export const ONTOLOGY_SUMMARY_INDEX_SQL = `CREATE INDEX IF NOT EXISTS idx_ontology_sources_summary ON ontology_sources(project_id, import_id, id, json_extract(data_json, '$.document_id'), json_extract(data_json, '$.title'), json_extract(data_json, '$.doc_date'), json_type(data_json, '$.evidence_metadata'));`;
export const ONTOLOGY_SNIPPET_LOOKUP_INDEX_SQL = 'CREATE INDEX IF NOT EXISTS idx_ontology_snippets_project_id_id ON ontology_snippets(project_id, id);';

/** Monotonic, project-scoped change marker for report inputs. */
export const REPORT_INPUT_REVISION_SQL = `
CREATE TABLE IF NOT EXISTS report_input_revisions (
  project_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0)
);
INSERT OR IGNORE INTO report_input_revisions(project_id, revision) SELECT id, 0 FROM projects;
CREATE TRIGGER IF NOT EXISTS trg_report_revision_project_insert AFTER INSERT ON projects BEGIN
  INSERT INTO report_input_revisions(project_id, revision) VALUES (NEW.id, 1)
  ON CONFLICT(project_id) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER IF NOT EXISTS trg_report_revision_project_update AFTER UPDATE ON projects BEGIN
  INSERT INTO report_input_revisions(project_id, revision) VALUES (NEW.id, 1)
  ON CONFLICT(project_id) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER IF NOT EXISTS trg_report_revision_project_delete AFTER DELETE ON projects BEGIN
  DELETE FROM report_input_revisions WHERE project_id = OLD.id;
END;
CREATE TRIGGER IF NOT EXISTS trg_report_revision_document_insert AFTER INSERT ON documents BEGIN
  INSERT INTO report_input_revisions(project_id, revision) VALUES (NEW.project_id, 1)
  ON CONFLICT(project_id) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER IF NOT EXISTS trg_report_revision_document_update AFTER UPDATE ON documents BEGIN
  INSERT INTO report_input_revisions(project_id, revision) VALUES (OLD.project_id, 1)
  ON CONFLICT(project_id) DO UPDATE SET revision = revision + 1;
  INSERT INTO report_input_revisions(project_id, revision) VALUES (NEW.project_id, 1)
  ON CONFLICT(project_id) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER IF NOT EXISTS trg_report_revision_document_delete AFTER DELETE ON documents BEGIN
  INSERT INTO report_input_revisions(project_id, revision) VALUES (OLD.project_id, 1)
  ON CONFLICT(project_id) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER IF NOT EXISTS trg_report_revision_paragraph_insert AFTER INSERT ON paragraphs BEGIN
  INSERT INTO report_input_revisions(project_id, revision) SELECT project_id, 1 FROM documents WHERE id = NEW.document_id
  ON CONFLICT(project_id) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER IF NOT EXISTS trg_report_revision_paragraph_update AFTER UPDATE ON paragraphs BEGIN
  INSERT INTO report_input_revisions(project_id, revision) SELECT project_id, 1 FROM documents WHERE id = OLD.document_id
  ON CONFLICT(project_id) DO UPDATE SET revision = revision + 1;
  INSERT INTO report_input_revisions(project_id, revision) SELECT project_id, 1 FROM documents WHERE id = NEW.document_id
  ON CONFLICT(project_id) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER IF NOT EXISTS trg_report_revision_paragraph_delete AFTER DELETE ON paragraphs BEGIN
  INSERT INTO report_input_revisions(project_id, revision) SELECT project_id, 1 FROM documents WHERE id = OLD.document_id
  ON CONFLICT(project_id) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER IF NOT EXISTS trg_report_revision_sentence_insert AFTER INSERT ON sentences BEGIN
  INSERT INTO report_input_revisions(project_id, revision) SELECT project_id, 1 FROM documents WHERE id = NEW.document_id
  ON CONFLICT(project_id) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER IF NOT EXISTS trg_report_revision_sentence_update AFTER UPDATE ON sentences BEGIN
  INSERT INTO report_input_revisions(project_id, revision) SELECT project_id, 1 FROM documents WHERE id = OLD.document_id
  ON CONFLICT(project_id) DO UPDATE SET revision = revision + 1;
  INSERT INTO report_input_revisions(project_id, revision) SELECT project_id, 1 FROM documents WHERE id = NEW.document_id
  ON CONFLICT(project_id) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER IF NOT EXISTS trg_report_revision_sentence_delete AFTER DELETE ON sentences BEGIN
  INSERT INTO report_input_revisions(project_id, revision) SELECT project_id, 1 FROM documents WHERE id = OLD.document_id
  ON CONFLICT(project_id) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER IF NOT EXISTS trg_report_revision_indicator_insert AFTER INSERT ON indicators BEGIN
  INSERT INTO report_input_revisions(project_id, revision) VALUES (NEW.project_id, 1)
  ON CONFLICT(project_id) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER IF NOT EXISTS trg_report_revision_indicator_update AFTER UPDATE ON indicators BEGIN
  INSERT INTO report_input_revisions(project_id, revision) VALUES (OLD.project_id, 1)
  ON CONFLICT(project_id) DO UPDATE SET revision = revision + 1;
  INSERT INTO report_input_revisions(project_id, revision) VALUES (NEW.project_id, 1)
  ON CONFLICT(project_id) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER IF NOT EXISTS trg_report_revision_indicator_delete AFTER DELETE ON indicators BEGIN
  INSERT INTO report_input_revisions(project_id, revision) VALUES (OLD.project_id, 1)
  ON CONFLICT(project_id) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER IF NOT EXISTS trg_report_revision_suggestion_insert AFTER INSERT ON suggestions BEGIN
  INSERT INTO report_input_revisions(project_id, revision) SELECT project_id, 1 FROM indicators WHERE id = NEW.indicator_id
  ON CONFLICT(project_id) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER IF NOT EXISTS trg_report_revision_suggestion_update AFTER UPDATE ON suggestions BEGIN
  INSERT INTO report_input_revisions(project_id, revision) SELECT project_id, 1 FROM indicators WHERE id = OLD.indicator_id
  ON CONFLICT(project_id) DO UPDATE SET revision = revision + 1;
  INSERT INTO report_input_revisions(project_id, revision) SELECT project_id, 1 FROM indicators WHERE id = NEW.indicator_id
  ON CONFLICT(project_id) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER IF NOT EXISTS trg_report_revision_suggestion_delete AFTER DELETE ON suggestions BEGIN
  INSERT INTO report_input_revisions(project_id, revision) SELECT project_id, 1 FROM indicators WHERE id = OLD.indicator_id
  ON CONFLICT(project_id) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER IF NOT EXISTS trg_report_revision_evidence_insert AFTER INSERT ON evidences BEGIN
  INSERT INTO report_input_revisions(project_id, revision) SELECT i.project_id, 1 FROM suggestions s JOIN indicators i ON i.id = s.indicator_id WHERE s.id = NEW.suggestion_id
  ON CONFLICT(project_id) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER IF NOT EXISTS trg_report_revision_evidence_update AFTER UPDATE ON evidences BEGIN
  INSERT INTO report_input_revisions(project_id, revision) SELECT i.project_id, 1 FROM suggestions s JOIN indicators i ON i.id = s.indicator_id WHERE s.id = OLD.suggestion_id
  ON CONFLICT(project_id) DO UPDATE SET revision = revision + 1;
  INSERT INTO report_input_revisions(project_id, revision) SELECT i.project_id, 1 FROM suggestions s JOIN indicators i ON i.id = s.indicator_id WHERE s.id = NEW.suggestion_id
  ON CONFLICT(project_id) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER IF NOT EXISTS trg_report_revision_evidence_delete AFTER DELETE ON evidences BEGIN
  INSERT INTO report_input_revisions(project_id, revision) SELECT i.project_id, 1 FROM suggestions s JOIN indicators i ON i.id = s.indicator_id WHERE s.id = OLD.suggestion_id
  ON CONFLICT(project_id) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER IF NOT EXISTS trg_report_revision_confirmation_insert AFTER INSERT ON confirmations BEGIN
  INSERT INTO report_input_revisions(project_id, revision) SELECT project_id, 1 FROM indicators WHERE id = NEW.indicator_id
  ON CONFLICT(project_id) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER IF NOT EXISTS trg_report_revision_confirmation_delete AFTER DELETE ON confirmations BEGIN
  INSERT INTO report_input_revisions(project_id, revision) SELECT project_id, 1 FROM indicators WHERE id = OLD.indicator_id
  ON CONFLICT(project_id) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER IF NOT EXISTS trg_report_revision_attribution_insert AFTER INSERT ON indicator_attributions BEGIN
  INSERT INTO report_input_revisions(project_id, revision) VALUES (NEW.project_id, 1)
  ON CONFLICT(project_id) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER IF NOT EXISTS trg_report_revision_attribution_update AFTER UPDATE ON indicator_attributions BEGIN
  INSERT INTO report_input_revisions(project_id, revision) VALUES (OLD.project_id, 1)
  ON CONFLICT(project_id) DO UPDATE SET revision = revision + 1;
  INSERT INTO report_input_revisions(project_id, revision) VALUES (NEW.project_id, 1)
  ON CONFLICT(project_id) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER IF NOT EXISTS trg_report_revision_attribution_delete AFTER DELETE ON indicator_attributions BEGIN
  INSERT INTO report_input_revisions(project_id, revision) VALUES (OLD.project_id, 1)
  ON CONFLICT(project_id) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER IF NOT EXISTS trg_report_revision_import_insert AFTER INSERT ON ontology_imports BEGIN
  INSERT INTO report_input_revisions(project_id, revision) VALUES (NEW.project_id, 1)
  ON CONFLICT(project_id) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER IF NOT EXISTS trg_report_revision_import_update AFTER UPDATE ON ontology_imports BEGIN
  INSERT INTO report_input_revisions(project_id, revision) VALUES (OLD.project_id, 1)
  ON CONFLICT(project_id) DO UPDATE SET revision = revision + 1;
  INSERT INTO report_input_revisions(project_id, revision) VALUES (NEW.project_id, 1)
  ON CONFLICT(project_id) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER IF NOT EXISTS trg_report_revision_import_delete AFTER DELETE ON ontology_imports BEGIN
  INSERT INTO report_input_revisions(project_id, revision) VALUES (OLD.project_id, 1)
  ON CONFLICT(project_id) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER IF NOT EXISTS trg_report_revision_node_insert AFTER INSERT ON ontology_nodes BEGIN
  INSERT INTO report_input_revisions(project_id, revision) VALUES (NEW.project_id, 1)
  ON CONFLICT(project_id) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER IF NOT EXISTS trg_report_revision_node_update AFTER UPDATE ON ontology_nodes BEGIN
  INSERT INTO report_input_revisions(project_id, revision) VALUES (OLD.project_id, 1)
  ON CONFLICT(project_id) DO UPDATE SET revision = revision + 1;
  INSERT INTO report_input_revisions(project_id, revision) VALUES (NEW.project_id, 1)
  ON CONFLICT(project_id) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER IF NOT EXISTS trg_report_revision_node_delete AFTER DELETE ON ontology_nodes BEGIN
  INSERT INTO report_input_revisions(project_id, revision) VALUES (OLD.project_id, 1)
  ON CONFLICT(project_id) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER IF NOT EXISTS trg_report_revision_edge_insert AFTER INSERT ON ontology_edges BEGIN
  INSERT INTO report_input_revisions(project_id, revision) VALUES (NEW.project_id, 1)
  ON CONFLICT(project_id) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER IF NOT EXISTS trg_report_revision_edge_update AFTER UPDATE ON ontology_edges BEGIN
  INSERT INTO report_input_revisions(project_id, revision) VALUES (OLD.project_id, 1)
  ON CONFLICT(project_id) DO UPDATE SET revision = revision + 1;
  INSERT INTO report_input_revisions(project_id, revision) VALUES (NEW.project_id, 1)
  ON CONFLICT(project_id) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER IF NOT EXISTS trg_report_revision_edge_delete AFTER DELETE ON ontology_edges BEGIN
  INSERT INTO report_input_revisions(project_id, revision) VALUES (OLD.project_id, 1)
  ON CONFLICT(project_id) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER IF NOT EXISTS trg_report_revision_source_insert AFTER INSERT ON ontology_sources BEGIN
  INSERT INTO report_input_revisions(project_id, revision) VALUES (NEW.project_id, 1)
  ON CONFLICT(project_id) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER IF NOT EXISTS trg_report_revision_source_update AFTER UPDATE ON ontology_sources BEGIN
  INSERT INTO report_input_revisions(project_id, revision) VALUES (OLD.project_id, 1)
  ON CONFLICT(project_id) DO UPDATE SET revision = revision + 1;
  INSERT INTO report_input_revisions(project_id, revision) VALUES (NEW.project_id, 1)
  ON CONFLICT(project_id) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER IF NOT EXISTS trg_report_revision_source_delete AFTER DELETE ON ontology_sources BEGIN
  INSERT INTO report_input_revisions(project_id, revision) VALUES (OLD.project_id, 1)
  ON CONFLICT(project_id) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER IF NOT EXISTS trg_report_revision_snippet_insert AFTER INSERT ON ontology_snippets BEGIN
  INSERT INTO report_input_revisions(project_id, revision) VALUES (NEW.project_id, 1)
  ON CONFLICT(project_id) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER IF NOT EXISTS trg_report_revision_snippet_update AFTER UPDATE ON ontology_snippets BEGIN
  INSERT INTO report_input_revisions(project_id, revision) VALUES (OLD.project_id, 1)
  ON CONFLICT(project_id) DO UPDATE SET revision = revision + 1;
  INSERT INTO report_input_revisions(project_id, revision) VALUES (NEW.project_id, 1)
  ON CONFLICT(project_id) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER IF NOT EXISTS trg_report_revision_snippet_delete AFTER DELETE ON ontology_snippets BEGIN
  INSERT INTO report_input_revisions(project_id, revision) VALUES (OLD.project_id, 1)
  ON CONFLICT(project_id) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER IF NOT EXISTS trg_report_revision_note_review_insert AFTER INSERT ON ontology_note_reviews BEGIN
  INSERT INTO report_input_revisions(project_id, revision) VALUES (NEW.project_id, 1)
  ON CONFLICT(project_id) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER IF NOT EXISTS trg_report_revision_note_review_delete AFTER DELETE ON ontology_note_reviews BEGIN
  INSERT INTO report_input_revisions(project_id, revision) VALUES (OLD.project_id, 1)
  ON CONFLICT(project_id) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER IF NOT EXISTS trg_report_revision_link_candidate_insert AFTER INSERT ON ontology_relation_candidates BEGIN
  INSERT INTO report_input_revisions(project_id, revision) VALUES (NEW.project_id, 1)
  ON CONFLICT(project_id) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER IF NOT EXISTS trg_report_revision_review_node_key_insert AFTER INSERT ON ontology_review_node_keys BEGIN
  INSERT INTO report_input_revisions(project_id, revision) VALUES (NEW.project_id, 1)
  ON CONFLICT(project_id) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER IF NOT EXISTS trg_report_revision_review_node_alias_insert AFTER INSERT ON ontology_review_node_aliases BEGIN
  INSERT INTO report_input_revisions(project_id, revision) VALUES (NEW.project_id, 1)
  ON CONFLICT(project_id) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER IF NOT EXISTS trg_report_revision_review_node_title_insert AFTER INSERT ON ontology_review_node_titles BEGIN
  INSERT INTO report_input_revisions(project_id, revision) VALUES (NEW.project_id, 1)
  ON CONFLICT(project_id) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER IF NOT EXISTS trg_report_revision_review_evidence_key_insert AFTER INSERT ON ontology_review_evidence_keys BEGIN
  INSERT INTO report_input_revisions(project_id, revision) VALUES (NEW.project_id, 1)
  ON CONFLICT(project_id) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER IF NOT EXISTS trg_report_revision_link_review_insert AFTER INSERT ON ontology_link_reviews BEGIN
  INSERT INTO report_input_revisions(project_id, revision) VALUES (NEW.project_id, 1)
  ON CONFLICT(project_id) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER IF NOT EXISTS trg_report_revision_link_review_delete AFTER DELETE ON ontology_link_reviews BEGIN
  INSERT INTO report_input_revisions(project_id, revision) VALUES (OLD.project_id, 1)
  ON CONFLICT(project_id) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER IF NOT EXISTS trg_report_revision_link_details_insert AFTER INSERT ON ontology_link_review_details BEGIN
  INSERT INTO report_input_revisions(project_id, revision) SELECT project_id, 1 FROM ontology_link_reviews WHERE id = NEW.review_id
  ON CONFLICT(project_id) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER IF NOT EXISTS trg_report_revision_link_details_update AFTER UPDATE ON ontology_link_review_details BEGIN
  INSERT INTO report_input_revisions(project_id, revision) SELECT project_id, 1 FROM ontology_link_reviews WHERE id = OLD.review_id
  ON CONFLICT(project_id) DO UPDATE SET revision = revision + 1;
  INSERT INTO report_input_revisions(project_id, revision) SELECT project_id, 1 FROM ontology_link_reviews WHERE id = NEW.review_id
  ON CONFLICT(project_id) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER IF NOT EXISTS trg_report_revision_link_details_delete AFTER DELETE ON ontology_link_review_details BEGIN
  INSERT INTO report_input_revisions(project_id, revision) SELECT project_id, 1 FROM ontology_link_reviews WHERE id = OLD.review_id
  ON CONFLICT(project_id) DO UPDATE SET revision = revision + 1;
END;
`;

export const CONFIRMATIONS_SUGGESTION_INDEX_SQL = 'CREATE INDEX IF NOT EXISTS idx_confirmations_suggestion_id ON confirmations(suggestion_id)';

export const PORTFOLIO_LEVEL_REVIEWS_SQL = `
CREATE TABLE IF NOT EXISTS ontology_portfolio_level_reviews (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  import_id TEXT NOT NULL REFERENCES ontology_imports(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL,
  node_type TEXT NOT NULL CHECK(node_type IN ('outcome-short', 'outcome-mid')),
  outcome_family TEXT NOT NULL CHECK(outcome_family IN ('협력국 정책 반영', '개발협력 촉진', '경제협력 촉진', '지식 네트워킹')),
  ai_level TEXT NOT NULL,
  team_level TEXT,
  reviewer TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK(team_level IS NULL OR
    (outcome_family = '협력국 정책 반영' AND team_level IN ('K0', 'K1', 'K2', 'K3', 'K4', 'K5', 'K6')) OR
    (outcome_family != '협력국 정책 반영' AND team_level IN ('Lv1', 'Lv2', 'Lv3', 'Lv4', 'Lv5')))
);
CREATE INDEX IF NOT EXISTS idx_ontology_portfolio_level_reviews_node
  ON ontology_portfolio_level_reviews(project_id, node_id, created_at);
CREATE TRIGGER IF NOT EXISTS trg_ontology_portfolio_level_reviews_no_update BEFORE UPDATE ON ontology_portfolio_level_reviews BEGIN SELECT RAISE(ABORT, '포트폴리오 레벨 이력은 추가만 허용합니다.'); END;
CREATE TRIGGER IF NOT EXISTS trg_ontology_portfolio_level_reviews_no_delete BEFORE DELETE ON ontology_portfolio_level_reviews WHEN EXISTS (SELECT 1 FROM projects WHERE id = OLD.project_id) BEGIN SELECT RAISE(ABORT, '포트폴리오 레벨 이력은 추가만 허용합니다.'); END;
CREATE TRIGGER IF NOT EXISTS trg_portfolio_level_revision_insert AFTER INSERT ON ontology_portfolio_level_reviews BEGIN
  INSERT INTO report_input_revisions(project_id, revision) VALUES (NEW.project_id, 1)
  ON CONFLICT(project_id) DO UPDATE SET revision = revision + 1;
END;
`;

export const PORTFOLIO_SNAPSHOTS_SQL = `
CREATE TABLE IF NOT EXISTS ontology_portfolio_snapshots (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  knowledge_level TEXT,
  cooperation_level TEXT,
  quadrant TEXT,
  knowledge_empty_reason TEXT,
  cooperation_empty_reason TEXT,
  calculated_at TEXT NOT NULL,
  input_revision INTEGER NOT NULL,
  calculation_version INTEGER NOT NULL DEFAULT 1
);
`;

export const ONTOLOGY_SYNTHESIS_SQL = `
CREATE TABLE IF NOT EXISTS ontology_synthesis_runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK(state IN ('queued', 'running', 'completed', 'failed')),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  error_message TEXT,
  input_node_count INTEGER NOT NULL DEFAULT 0,
  item_count INTEGER NOT NULL DEFAULT 0,
  discarded_count INTEGER NOT NULL DEFAULT 0,
  result_json TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ontology_synthesis_one_active ON ontology_synthesis_runs(project_id) WHERE state IN ('queued', 'running');
CREATE INDEX IF NOT EXISTS idx_ontology_synthesis_project ON ontology_synthesis_runs(project_id, started_at DESC);
CREATE TABLE IF NOT EXISTS ontology_synthesis_eligibility (
  run_id TEXT PRIMARY KEY REFERENCES ontology_synthesis_runs(id) ON DELETE CASCADE,
  fingerprint TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ontology_synthesis_diagnostics (
  run_id TEXT PRIMARY KEY REFERENCES ontology_synthesis_runs(id) ON DELETE CASCADE,
  diagnostics_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ontology_synthesis_partial_runs (
  run_id TEXT PRIMARY KEY REFERENCES ontology_synthesis_runs(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK(state = 'partial_completed')
);
`;

export const CREATE_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  project_year INTEGER,
  country TEXT,
  region TEXT,
  partner_ministry TEXT,
  project_type TEXT,
  kdi_cid TEXT,
  implementing_org TEXT,
  partner_government_org TEXT,
  is_ended INTEGER,
  pilot_label TEXT,
  metadata_source TEXT
);

CREATE TABLE IF NOT EXISTS user_role_assignments (
  login TEXT PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('Admin', '평가팀', 'PO', '기획팀')),
  assigned_by TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  file_type TEXT NOT NULL,
  status TEXT NOT NULL,
  doc_type TEXT,
  is_included INTEGER NOT NULL DEFAULT 1,
  excluded_reason TEXT,
  masked INTEGER,
  approved_ai TEXT NOT NULL DEFAULT 'solar',
  is_past_final_report INTEGER,
  inclusion_source TEXT NOT NULL DEFAULT 'auto',
  doctype_source TEXT NOT NULL DEFAULT 'auto',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS paragraphs (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  sequence_no INTEGER NOT NULL,
  location TEXT NOT NULL,
  content TEXT NOT NULL,
  table_index INTEGER,
  table_cols INTEGER,
  table_row INTEGER,
  table_col INTEGER,
  grid_coord_version INTEGER
);

CREATE TABLE IF NOT EXISTS indicators (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  level TEXT NOT NULL,
  name TEXT NOT NULL,
  ovi TEXT NOT NULL,
  mov TEXT,
  target_value TEXT,
  parent_id TEXT REFERENCES indicators(id) ON DELETE SET NULL,
  source_doc_id TEXT REFERENCES documents(id) ON DELETE SET NULL,
  source_location TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_baseline INTEGER NOT NULL DEFAULT 0,
  is_unknown_level INTEGER NOT NULL DEFAULT 0,
  is_orphaned INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS indicator_conflicts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  indicator_id TEXT NOT NULL REFERENCES indicators(id) ON DELETE CASCADE,
  doc_a_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  doc_a_name TEXT NOT NULL,
  doc_a_value TEXT NOT NULL,
  doc_a_location TEXT,
  doc_b_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  doc_b_name TEXT NOT NULL,
  doc_b_value TEXT NOT NULL,
  doc_b_location TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS indicator_baselines (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  indicator_id TEXT NOT NULL REFERENCES indicators(id) ON DELETE CASCADE,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  document_name TEXT NOT NULL,
  target_value TEXT NOT NULL,
  selected_at TEXT NOT NULL,
  conflict_id TEXT,
  other_doc_id TEXT
);

CREATE TABLE IF NOT EXISTS suggestions (
  id TEXT PRIMARY KEY,
  indicator_id TEXT NOT NULL REFERENCES indicators(id) ON DELETE CASCADE,
  verdict_status TEXT NOT NULL CHECK(verdict_status IN ('실현', '추진 중', '기대', '미확인', '근거 충돌')),
  error_reason TEXT,
  proposal_text TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS evidences (
  id TEXT PRIMARY KEY,
  suggestion_id TEXT NOT NULL REFERENCES suggestions(id) ON DELETE CASCADE,
  quote TEXT NOT NULL CHECK(length(trim(quote, ' '||char(9)||char(10)||char(13))) > 0),
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE CHECK(length(trim(document_id, ' '||char(9)||char(10)||char(13))) > 0),
  location TEXT NOT NULL CHECK(length(trim(location, ' '||char(9)||char(10)||char(13))) > 0),
  speaker TEXT NOT NULL CHECK(length(trim(speaker, ' '||char(9)||char(10)||char(13))) > 0),
  is_citation_banned INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sentences (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  paragraph_id TEXT NOT NULL REFERENCES paragraphs(id) ON DELETE CASCADE,
  sequence_no INTEGER NOT NULL,
  location TEXT NOT NULL,
  content TEXT NOT NULL,
  is_citation_banned INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS indicator_attributions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  indicator_id TEXT NOT NULL UNIQUE REFERENCES indicators(id) ON DELETE CASCADE,
  attribution_text TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS confirmations (
  id TEXT PRIMARY KEY,
  indicator_id TEXT NOT NULL REFERENCES indicators(id) ON DELETE CASCADE,
  suggestion_id TEXT REFERENCES suggestions(id),
  confirmation_type TEXT NOT NULL CHECK(confirmation_type IN ('확정', '수정 후 확정', '보완 필요', '채택 제외')),
  initial_proposal TEXT,
  edited_text TEXT,
  edited_verdict_status TEXT CHECK(edited_verdict_status IS NULL OR edited_verdict_status IN ('실현', '추진 중', '기대', '미확인', '근거 충돌')),
  reason TEXT,
  confirmer_name TEXT NOT NULL CHECK(length(trim(confirmer_name, ' '||char(9)||char(10)||char(13))) > 0),
  created_at TEXT NOT NULL,
  CHECK (
    confirmation_type != '수정 후 확정' OR (
      edited_text IS NOT NULL AND length(trim(edited_text, ' '||char(9)||char(10)||char(13))) > 0 AND
      reason IS NOT NULL AND length(trim(reason, ' '||char(9)||char(10)||char(13))) > 0
    )
  )
);

CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  content_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- W-17 ontology snapshots are scoped to the owning app project. Import rows are
-- retained as history; the graph tables below describe each immutable run.
CREATE TABLE IF NOT EXISTS ontology_imports (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  vault_code TEXT NOT NULL,
  imported_at TEXT NOT NULL,
  node_count INTEGER NOT NULL,
  edge_count INTEGER NOT NULL,
  source_count INTEGER NOT NULL,
  snippet_count INTEGER NOT NULL,
  error_count INTEGER NOT NULL,
  warning_count INTEGER NOT NULL,
  executor TEXT NOT NULL,
  source_kind TEXT NOT NULL DEFAULT 'vault',
  model_name TEXT,
  document_success_count INTEGER NOT NULL DEFAULT 0,
  document_failure_count INTEGER NOT NULL DEFAULT 0,
  discarded_quote_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS ontology_generation_runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK(state IN ('queued', 'running', 'completed', 'failed')),
  completed_count INTEGER NOT NULL DEFAULT 0,
  total_count INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  result_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ontology_generation_one_active ON ontology_generation_runs(project_id) WHERE state IN ('queued', 'running');

CREATE TABLE IF NOT EXISTS ontology_nodes (
  id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  import_id TEXT NOT NULL REFERENCES ontology_imports(id) ON DELETE CASCADE,
  node_type TEXT NOT NULL,
  title TEXT NOT NULL,
  data_json TEXT NOT NULL,
  PRIMARY KEY (project_id, import_id, id)
);

CREATE TABLE IF NOT EXISTS ontology_edges (
  id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  import_id TEXT NOT NULL REFERENCES ontology_imports(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  relation_field TEXT NOT NULL,
  PRIMARY KEY (project_id, import_id, id)
);

CREATE TABLE IF NOT EXISTS ontology_sources (
  id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  import_id TEXT NOT NULL REFERENCES ontology_imports(id) ON DELETE CASCADE,
  data_json TEXT NOT NULL,
  PRIMARY KEY (project_id, import_id, id)
);

CREATE TABLE IF NOT EXISTS ontology_snippets (
  id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  import_id TEXT NOT NULL REFERENCES ontology_imports(id) ON DELETE CASCADE,
  data_json TEXT NOT NULL,
  PRIMARY KEY (project_id, import_id, id)
);

CREATE TABLE IF NOT EXISTS ontology_relation_candidates (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  import_id TEXT NOT NULL REFERENCES ontology_imports(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  relation TEXT NOT NULL,
  PRIMARY KEY (project_id, import_id, source_id, target_id, relation)
);

-- Retain the node type when old graph snapshots are removed.
CREATE TABLE IF NOT EXISTS ontology_review_node_keys (
  project_id TEXT NOT NULL,
  import_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  node_type TEXT NOT NULL,
  PRIMARY KEY (project_id, import_id, node_id)
);

-- Migration receipts are separate from the preserved review data.
CREATE TABLE IF NOT EXISTS ontology_graph_migration_receipts (
  project_id TEXT NOT NULL, import_id TEXT NOT NULL,
  PRIMARY KEY (project_id, import_id)
);
CREATE TABLE IF NOT EXISTS ontology_review_migration_watermarks (
  kind TEXT NOT NULL, last_rowid INTEGER NOT NULL,
  PRIMARY KEY (kind, last_rowid)
);
CREATE INDEX IF NOT EXISTS idx_review_node_keys_project_node_type ON ontology_review_node_keys(project_id, node_id, node_type);

CREATE TABLE IF NOT EXISTS ontology_review_node_aliases (
  project_id TEXT NOT NULL, import_id TEXT NOT NULL, old_node_id TEXT NOT NULL, new_node_id TEXT NOT NULL,
  PRIMARY KEY (project_id, import_id, old_node_id)
);
CREATE TABLE IF NOT EXISTS ontology_review_node_titles (
  project_id TEXT NOT NULL, import_id TEXT NOT NULL, node_id TEXT NOT NULL, title TEXT NOT NULL,
  PRIMARY KEY (project_id, import_id, node_id)
);
CREATE TABLE IF NOT EXISTS ontology_link_reviews (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  import_id TEXT NOT NULL REFERENCES ontology_imports(id),
  source_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  status TEXT NOT NULL,
  reviewer TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ontology_link_review_details (
  review_id TEXT PRIMARY KEY REFERENCES ontology_link_reviews(id),
  relation TEXT NOT NULL,
  reason TEXT NOT NULL,
  error_type TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ontology_review_evidence_keys (
  project_id TEXT NOT NULL, import_id TEXT NOT NULL, node_id TEXT NOT NULL,
  source_id TEXT NOT NULL, locator TEXT NOT NULL, quote TEXT NOT NULL,
  PRIMARY KEY (project_id, import_id, node_id, source_id, locator, quote)
);
CREATE TRIGGER IF NOT EXISTS trg_ontology_relation_candidates_no_update BEFORE UPDATE ON ontology_relation_candidates BEGIN SELECT RAISE(ABORT, '검토 자료는 추가만 허용합니다.'); END;
CREATE TRIGGER IF NOT EXISTS trg_ontology_relation_candidates_no_delete BEFORE DELETE ON ontology_relation_candidates BEGIN SELECT RAISE(ABORT, '검토 자료는 추가만 허용합니다.'); END;
CREATE TRIGGER IF NOT EXISTS trg_ontology_review_node_keys_no_update BEFORE UPDATE ON ontology_review_node_keys BEGIN SELECT RAISE(ABORT, '검토 자료는 추가만 허용합니다.'); END;
CREATE TRIGGER IF NOT EXISTS trg_ontology_review_node_keys_no_delete BEFORE DELETE ON ontology_review_node_keys BEGIN SELECT RAISE(ABORT, '검토 자료는 추가만 허용합니다.'); END;
CREATE TRIGGER IF NOT EXISTS trg_ontology_review_evidence_keys_no_update BEFORE UPDATE ON ontology_review_evidence_keys BEGIN SELECT RAISE(ABORT, '검토 자료는 추가만 허용합니다.'); END;
CREATE TRIGGER IF NOT EXISTS trg_ontology_review_evidence_keys_no_delete BEFORE DELETE ON ontology_review_evidence_keys BEGIN SELECT RAISE(ABORT, '검토 자료는 추가만 허용합니다.'); END;
CREATE TRIGGER IF NOT EXISTS trg_ontology_review_node_aliases_no_update BEFORE UPDATE ON ontology_review_node_aliases BEGIN SELECT RAISE(ABORT, '검토 자료는 추가만 허용합니다.'); END;
CREATE TRIGGER IF NOT EXISTS trg_ontology_review_node_aliases_no_delete BEFORE DELETE ON ontology_review_node_aliases BEGIN SELECT RAISE(ABORT, '검토 자료는 추가만 허용합니다.'); END;
CREATE TRIGGER IF NOT EXISTS trg_ontology_review_node_titles_no_update BEFORE UPDATE ON ontology_review_node_titles BEGIN SELECT RAISE(ABORT, '검토 자료는 추가만 허용합니다.'); END;
CREATE TRIGGER IF NOT EXISTS trg_ontology_review_node_titles_no_delete BEFORE DELETE ON ontology_review_node_titles BEGIN SELECT RAISE(ABORT, '검토 자료는 추가만 허용합니다.'); END;
CREATE TRIGGER IF NOT EXISTS trg_link_details_no_update BEFORE UPDATE ON ontology_link_review_details BEGIN SELECT RAISE(ABORT, '연결 이력은 추가만 허용합니다.'); END;
CREATE TRIGGER IF NOT EXISTS trg_link_details_no_delete BEFORE DELETE ON ontology_link_review_details BEGIN SELECT RAISE(ABORT, '연결 이력은 추가만 허용합니다.'); END;

CREATE TABLE IF NOT EXISTS ontology_note_reviews (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  import_id TEXT NOT NULL REFERENCES ontology_imports(id),
  node_id TEXT NOT NULL,
  status TEXT NOT NULL,
  text TEXT NOT NULL,
  original_text TEXT NOT NULL,
  outcome_state TEXT NOT NULL,
  reason TEXT NOT NULL,
  error_type TEXT NOT NULL,
  reviewer TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ontology_note_reviews ON ontology_note_reviews(project_id, import_id, node_id, created_at);
CREATE INDEX IF NOT EXISTS idx_ontology_note_reviews_project_node ON ontology_note_reviews(project_id, node_id);
${PORTFOLIO_LEVEL_REVIEWS_SQL}
${PORTFOLIO_SNAPSHOTS_SQL}

CREATE TABLE IF NOT EXISTS ontology_check_issues (
  id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  import_id TEXT NOT NULL REFERENCES ontology_imports(id) ON DELETE CASCADE,
  rule_number TEXT NOT NULL,
  severity TEXT NOT NULL CHECK(severity IN ('error', 'warning')),
  file TEXT NOT NULL,
  field TEXT NOT NULL,
  message TEXT NOT NULL,
  PRIMARY KEY (project_id, import_id, id)
);

CREATE INDEX IF NOT EXISTS idx_documents_project_id ON documents(project_id);
CREATE INDEX IF NOT EXISTS idx_documents_project_type_included_created ON documents(project_id, doc_type, is_included, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_paragraphs_document_id ON paragraphs(document_id);
CREATE INDEX IF NOT EXISTS idx_paragraphs_document_location ON paragraphs(document_id, location);
CREATE INDEX IF NOT EXISTS idx_paragraphs_document_sequence ON paragraphs(document_id, sequence_no);
CREATE TABLE IF NOT EXISTS ontology_quote_verification_cache (
  project_id TEXT NOT NULL,
  import_id TEXT NOT NULL,
  snippet_id TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  verified INTEGER NOT NULL,
  coverage REAL NOT NULL,
  PRIMARY KEY (project_id, import_id, snippet_id)
);
-- The original cache had no foreign key. Keep its table for old binaries,
-- discard its disposable contents, and use a cascade-owned cache going forward.
CREATE TABLE IF NOT EXISTS ontology_quote_verification_cache_v2 (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  import_id TEXT NOT NULL,
  snippet_id TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  verified INTEGER NOT NULL,
  coverage REAL NOT NULL,
  PRIMARY KEY (project_id, import_id, snippet_id)
);
${QUOTE_CACHE_V3_SQL}
${EVIDENCE_QUOTE_CACHE_SQL}
DELETE FROM ontology_quote_verification_cache;
CREATE INDEX IF NOT EXISTS idx_sentences_document_id ON sentences(document_id);
CREATE INDEX IF NOT EXISTS idx_sentences_paragraph_id ON sentences(paragraph_id);
CREATE INDEX IF NOT EXISTS idx_sentences_banned ON sentences(is_citation_banned);
CREATE INDEX IF NOT EXISTS idx_indicators_project_id ON indicators(project_id);
CREATE INDEX IF NOT EXISTS idx_conflicts_project_id ON indicator_conflicts(project_id);
CREATE INDEX IF NOT EXISTS idx_conflicts_indicator_id ON indicator_conflicts(indicator_id);
CREATE INDEX IF NOT EXISTS idx_baselines_project_id ON indicator_baselines(project_id);
CREATE INDEX IF NOT EXISTS idx_baselines_indicator_id ON indicator_baselines(indicator_id);
CREATE INDEX IF NOT EXISTS idx_suggestions_indicator_id ON suggestions(indicator_id);
CREATE INDEX IF NOT EXISTS idx_suggestions_indicator_created ON suggestions(indicator_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_evidences_suggestion_id ON evidences(suggestion_id);
CREATE INDEX IF NOT EXISTS idx_indicator_attributions_project ON indicator_attributions(project_id);
CREATE INDEX IF NOT EXISTS idx_indicator_attributions_indicator ON indicator_attributions(indicator_id);
CREATE INDEX IF NOT EXISTS idx_confirmations_indicator_id ON confirmations(indicator_id);
CREATE INDEX IF NOT EXISTS idx_confirmations_indicator_suggestion_created ON confirmations(indicator_id, suggestion_id, created_at DESC);
${CONFIRMATIONS_SUGGESTION_INDEX_SQL};
CREATE INDEX IF NOT EXISTS idx_confirmations_created_at ON confirmations(created_at);
CREATE INDEX IF NOT EXISTS idx_reports_project_id ON reports(project_id);
CREATE INDEX IF NOT EXISTS idx_ontology_imports_project ON ontology_imports(project_id, imported_at DESC);
CREATE INDEX IF NOT EXISTS idx_ontology_nodes_latest ON ontology_nodes(project_id, import_id, node_type);
CREATE INDEX IF NOT EXISTS idx_ontology_nodes_import ON ontology_nodes(import_id);
CREATE INDEX IF NOT EXISTS idx_ontology_edges_latest ON ontology_edges(project_id, import_id, relation_field);
CREATE INDEX IF NOT EXISTS idx_ontology_edges_import ON ontology_edges(import_id);
CREATE INDEX IF NOT EXISTS idx_ontology_issues_latest ON ontology_check_issues(project_id, import_id, severity);
${ONTOLOGY_SUMMARY_INDEX_SQL}
${ONTOLOGY_SNIPPET_LOOKUP_INDEX_SQL}

CREATE TRIGGER IF NOT EXISTS trg_prevent_note_reviews_update
BEFORE UPDATE ON ontology_note_reviews BEGIN SELECT RAISE(ABORT, '검토 이력은 추가만 허용합니다.'); END;
CREATE TRIGGER IF NOT EXISTS trg_prevent_note_reviews_delete
BEFORE DELETE ON ontology_note_reviews BEGIN SELECT RAISE(ABORT, '검토 이력은 추가만 허용합니다.'); END;
CREATE TRIGGER IF NOT EXISTS trg_prevent_link_reviews_update
BEFORE UPDATE ON ontology_link_reviews BEGIN SELECT RAISE(ABORT, '연결 이력은 추가만 허용합니다.'); END;
CREATE TRIGGER IF NOT EXISTS trg_prevent_link_reviews_delete
BEFORE DELETE ON ontology_link_reviews BEGIN SELECT RAISE(ABORT, '연결 이력은 추가만 허용합니다.'); END;

CREATE TRIGGER IF NOT EXISTS trg_prevent_confirmations_update
BEFORE UPDATE ON confirmations
BEGIN
  SELECT RAISE(ABORT, '확정 이력은 수정할 수 없습니다 (추가만 허용).');
END;

CREATE TRIGGER IF NOT EXISTS trg_prevent_confirmations_delete
BEFORE DELETE ON confirmations
BEGIN
  SELECT RAISE(ABORT, '확정 이력은 삭제할 수 없습니다 (추가만 허용).');
END;
${REPORT_INPUT_REVISION_SQL}
${ONTOLOGY_SYNTHESIS_SQL}
`;

