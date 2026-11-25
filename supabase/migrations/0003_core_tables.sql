begin;

create or replace function quorum_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create table advisors (
  id uuid primary key default gen_random_uuid(),
  slug citext not null unique,
  display_name text not null,
  short_bio text not null,
  era_label text not null,
  domain_label text not null,
  disclaimer_text text not null,
  persona_status advisor_persona_status not null default 'draft',
  readiness_status advisor_readiness_status not null default 'not_ready',
  benchmark_passed_at timestamptz,
  supported_locales text[] not null default array['en', 'ru'],
  is_launch_enabled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (slug <> ''),
  check (coalesce(array_length(supported_locales, 1), 0) >= 1),
  check (
    readiness_status <> 'advisor_ready'
    or benchmark_passed_at is not null
  )
);

create table advisor_sources (
  id uuid primary key default gen_random_uuid(),
  advisor_id uuid not null references advisors(id) on delete cascade,
  source_key text not null,
  title text not null,
  creator text,
  source_type source_type not null,
  origin_class source_origin_class not null,
  language_code text not null,
  access_model source_access_model not null,
  acquisition_status source_acquisition_status not null default 'discovered',
  priority source_priority not null default 'medium',
  provenance_url text,
  provenance_citation text,
  storage_path text,
  blocked_reason text,
  curator_notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (advisor_id, source_key)
);

create table corpus_documents (
  id uuid primary key default gen_random_uuid(),
  advisor_id uuid not null references advisors(id) on delete cascade,
  source_id uuid not null,
  document_kind document_kind not null,
  title text not null,
  original_language_code text not null,
  retrieval_language_code text not null default 'en',
  raw_storage_path text,
  normalized_text text not null,
  retrieval_text_en text not null,
  source_checksum_sha256 char(64),
  document_state document_state not null default 'pending',
  fragment_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (title <> ''),
  check (retrieval_language_code = 'en'),
  check (fragment_count >= 0)
);

create table corpus_fragments (
  id uuid primary key default gen_random_uuid(),
  advisor_id uuid not null references advisors(id) on delete cascade,
  document_id uuid not null,
  fragment_index integer not null,
  fragment_kind fragment_kind not null default 'body',
  original_text text not null,
  retrieval_text_en text not null,
  original_language_code text not null,
  provenance_locator jsonb not null,
  embedding vector(1536) not null,
  embedding_model text not null,
  fragment_state fragment_state not null default 'draft',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (document_id, fragment_index),
  check (fragment_index >= 0)
);

create table advisor_dossiers (
  id uuid primary key default gen_random_uuid(),
  advisor_id uuid not null references advisors(id) on delete cascade,
  version integer not null,
  schema_version integer not null default 1,
  artifact_state review_status not null default 'pending',
  is_current boolean not null default false,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  approved_at timestamptz,
  unique (advisor_id, version),
  check (
    (artifact_state = 'approved' and approved_at is not null)
    or (artifact_state <> 'approved' and approved_at is null)
  ),
  check (
    is_current = false
    or (artifact_state = 'approved' and approved_at is not null)
  )
);

create table advisor_review_gates (
  id uuid primary key default gen_random_uuid(),
  advisor_id uuid not null references advisors(id) on delete cascade,
  gate_type review_gate_type not null,
  status review_status not null default 'pending',
  reviewed_by text,
  review_notes text,
  dossier_id uuid,
  approved_fragment_count integer,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (advisor_id, gate_type),
  check (
    (gate_type = 'source_catalog' and dossier_id is null)
    or (gate_type = 'advisor_corpus' and dossier_id is not null)
  ),
  check (approved_fragment_count is null or approved_fragment_count >= 0)
);

create trigger quorum_touch_advisors_updated_at
before update on advisors
for each row
execute function quorum_set_updated_at();

create trigger quorum_touch_advisor_sources_updated_at
before update on advisor_sources
for each row
execute function quorum_set_updated_at();

create trigger quorum_touch_corpus_documents_updated_at
before update on corpus_documents
for each row
execute function quorum_set_updated_at();

create trigger quorum_touch_corpus_fragments_updated_at
before update on corpus_fragments
for each row
execute function quorum_set_updated_at();

create trigger quorum_touch_advisor_dossiers_updated_at
before update on advisor_dossiers
for each row
execute function quorum_set_updated_at();

create trigger quorum_touch_advisor_review_gates_updated_at
before update on advisor_review_gates
for each row
execute function quorum_set_updated_at();

commit;
