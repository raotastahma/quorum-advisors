begin;

create type advisor_persona_status as enum ('draft', 'active', 'archived');

create type advisor_readiness_status as enum (
  'not_ready',
  'source_catalog_approved',
  'corpus_approved_pending_benchmark',
  'advisor_ready'
);

create type source_type as enum (
  'book',
  'essay',
  'letter',
  'speech',
  'interview',
  'podcast',
  'video',
  'article',
  'biography',
  'lecture',
  'other'
);

create type source_origin_class as enum ('primary', 'secondary');

create type source_access_model as enum ('free', 'paid', 'human_supplied');

create type source_acquisition_status as enum (
  'discovered',
  'screened',
  'approved',
  'blocked',
  'rejected',
  'ingested'
);

create type source_priority as enum ('high', 'medium', 'low');

create type document_kind as enum (
  'source_text',
  'subtitle_transcript',
  'manual_transcript',
  'human_supplied_text',
  'translation',
  'note'
);

create type document_state as enum (
  'pending',
  'normalized',
  'chunked',
  'embedded',
  'approved',
  'rejected'
);

create type fragment_kind as enum ('body', 'quote');
create type fragment_state as enum ('draft', 'approved', 'rejected');
create type review_gate_type as enum ('source_catalog', 'advisor_corpus');
create type review_status as enum ('pending', 'approved', 'rejected');

commit;
