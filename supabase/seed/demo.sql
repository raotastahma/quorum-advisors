-- Original fictional data for a disposable local database, never a production launch approval.
begin;
do $$
declare
  advisor uuid := '00000000-0000-4000-8000-000000000001';
  source uuid := '00000000-0000-4000-8000-000000000002';
  document uuid := '00000000-0000-4000-8000-000000000003';
  fragment uuid := '00000000-0000-4000-8000-000000000004';
  dossier uuid := '00000000-0000-4000-8000-000000000005';
  demo_vector vector(1536) := (array[1.0] || array_fill(0.0, array[1535]))::vector;
  demo_text text := 'Choose a small reversible experiment. Record what happened before deciding what to change.';
begin
  insert into advisors(id, slug, display_name, short_bio, era_label, domain_label, disclaimer_text, supported_locales, telegram_command)
  values(advisor, 'demo-mentor', 'Demo Mentor', 'Original fictional learning advisor.', 'Fictional', 'Learning',
    'Demo Mentor is a fictional AI demonstration persona. Responses are generated and are not professional advice.', array['en'], 'demo_mentor');
  insert into advisor_sources(id, advisor_id, source_key, title, creator, source_type, origin_class, language_code, access_model, acquisition_status, priority)
  values(source, advisor, 'original-demo-notes', 'Original Demo Notes', 'Quorum demo contributors', 'article', 'primary', 'en', 'free', 'approved', 'high');
  insert into corpus_documents(id, advisor_id, source_id, document_kind, title, original_language_code, normalized_text, retrieval_text_en, document_state, fragment_count)
  values(document, advisor, source, 'source_text', 'Original Demo Notes', 'en', demo_text, demo_text, 'approved', 1);
  insert into corpus_fragments(id, advisor_id, document_id, fragment_index, original_text, retrieval_text_en, original_language_code, provenance_locator, embedding, embedding_model, fragment_state)
  values(fragment, advisor, document, 0, demo_text, demo_text, 'en', '{"kind":"original_demo","paragraph":1}', demo_vector, 'deterministic-demo-vector', 'approved');
  insert into advisor_dossiers(id, advisor_id, version, artifact_state, is_current, approved_at, payload)
  values(dossier, advisor, 1, 'approved', true, now(), jsonb_build_object(
    'tone', jsonb_build_object('voice', 'clear', 'cadence', 'brief', 'do', jsonb_build_array('greet with "Welcome"'), 'avoid', jsonb_build_array()),
    'core_ideas', jsonb_build_array(jsonb_build_object('statement', demo_text)),
    'red_lines', jsonb_build_array('Do not claim to be a real person.'),
    'argument_patterns', jsonb_build_array(), 'secondary_context_notes', jsonb_build_array()));
  perform quorum_apply_review_gate_decision(advisor, 'source_catalog', 'approved', 'local-demo-fixture', 'Original fixture only.', null, null);
  perform quorum_apply_review_gate_decision(advisor, 'advisor_corpus', 'approved', 'local-demo-fixture', 'Original fixture only.', dossier, 1);
  update advisors set benchmark_passed_at = '2000-01-01T00:00:00Z' where id = advisor;
  update advisors set persona_status = 'active', is_launch_enabled = true where id = advisor;
  insert into advisor_topic_tags(advisor_id, tag_key, label, description, tag_state, embedding, embedding_model, approved_at)
  values(advisor, 'learning', 'Learning', 'Original demo learning experiments.', 'approved', demo_vector, 'deterministic-demo-vector', now());
  insert into advisor_selection_profiles(advisor_id, dossier_id, profile_text_en, embedding, embedding_model, input_checksum_sha256)
  values(advisor, dossier, 'Learn through small experiments.', demo_vector, 'deterministic-demo-vector', repeat('0',64));
end;
$$;
commit;
