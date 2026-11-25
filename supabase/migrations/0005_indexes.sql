begin;

create index advisor_sources_advisor_status_idx
  on advisor_sources(advisor_id, acquisition_status, priority);

create unique index advisor_sources_advisor_id_id_uidx
  on advisor_sources(advisor_id, id);

create index corpus_documents_advisor_state_idx
  on corpus_documents(advisor_id, document_state);

create unique index corpus_documents_advisor_id_id_uidx
  on corpus_documents(advisor_id, id);

create unique index corpus_documents_checksum_uidx
  on corpus_documents(source_checksum_sha256)
  where source_checksum_sha256 is not null;

create index corpus_fragments_advisor_state_idx
  on corpus_fragments(advisor_id, fragment_state);

create unique index advisor_dossiers_current_uidx
  on advisor_dossiers(advisor_id)
  where is_current = true;

create unique index advisor_dossiers_advisor_id_id_uidx
  on advisor_dossiers(advisor_id, id);

alter table corpus_documents
  add constraint corpus_documents_source_fk
  foreign key (advisor_id, source_id)
  references advisor_sources(advisor_id, id)
  on delete restrict;

alter table corpus_fragments
  add constraint corpus_fragments_document_fk
  foreign key (advisor_id, document_id)
  references corpus_documents(advisor_id, id)
  on delete cascade;

alter table advisor_review_gates
  add constraint advisor_review_gates_dossier_fk
  foreign key (advisor_id, dossier_id)
  references advisor_dossiers(advisor_id, id)
  on delete restrict;

commit;
