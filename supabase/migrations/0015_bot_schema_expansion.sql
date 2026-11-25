begin;

do $$
begin
  create type chat_kind as enum ('single_advisor', 'multi_advisor');
exception
  when duplicate_object then
    null;
end;
$$;

do $$
begin
  create type telegram_update_status as enum ('processing', 'processed', 'ignored', 'failed');
exception
  when duplicate_object then
    null;
end;
$$;

create or replace function quorum_normalize_display_name_key(p_value text)
returns text
language sql
immutable
as $$
  select lower(regexp_replace(btrim(coalesce(p_value, '')), '\s+', ' ', 'g'));
$$;

alter table advisors
  add column display_name_key citext;

update advisors
set display_name_key = quorum_normalize_display_name_key(display_name)
where display_name_key is null;

alter table advisors
  alter column display_name_key set not null,
  add constraint advisors_display_name_not_empty_check
    check (display_name <> ''),
  add constraint advisors_display_name_key_not_empty_check
    check (display_name_key <> ''),
  add constraint advisors_display_name_key_not_reserved_check
    check (display_name_key <> 'any'),
  add constraint advisors_display_name_key_key
    unique (display_name_key);

create or replace function quorum_set_advisor_display_name_key()
returns trigger
language plpgsql
as $$
begin
  new.display_name_key := quorum_normalize_display_name_key(
    coalesce(new.display_name_key::text, new.display_name)
  )::citext;

  return new;
end;
$$;

create trigger quorum_normalize_advisors_display_name_key
before insert or update of display_name, display_name_key on advisors
for each row
execute function quorum_set_advisor_display_name_key();

alter table advisor_sources
  add column input_checksum_sha256 char(64),
  add constraint advisor_sources_input_checksum_sha256_check
    check (
      input_checksum_sha256 is null
      or input_checksum_sha256 ~ '^[0-9a-f]{64}$'
    );

alter table corpus_documents
  add constraint corpus_documents_source_checksum_sha256_check
    check (
      source_checksum_sha256 is null
      or source_checksum_sha256 ~ '^[0-9a-f]{64}$'
    );

alter table advisor_dossiers
  add column input_checksum_sha256 char(64),
  add constraint advisor_dossiers_input_checksum_sha256_check
    check (
      input_checksum_sha256 is null
      or input_checksum_sha256 ~ '^[0-9a-f]{64}$'
    );

create table advisor_topic_tags (
  id uuid primary key default gen_random_uuid(),
  advisor_id uuid not null references advisors(id) on delete cascade,
  tag_key citext not null,
  label text not null,
  description text,
  tag_state review_status not null default 'pending',
  embedding vector(1536),
  embedding_model text,
  curator_notes text,
  input_checksum_sha256 char(64),
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (advisor_id, tag_key),
  check (tag_key <> ''),
  check (label <> ''),
  check (
    (embedding is null and embedding_model is null)
    or (embedding is not null and embedding_model is not null)
  ),
  check (
    (tag_state = 'approved' and approved_at is not null and embedding is not null)
    or (tag_state <> 'approved' and approved_at is null)
  ),
  check (
    input_checksum_sha256 is null
    or input_checksum_sha256 ~ '^[0-9a-f]{64}$'
  )
);

create index advisor_topic_tags_advisor_state_idx
  on advisor_topic_tags(advisor_id, tag_state);

create trigger quorum_touch_advisor_topic_tags_updated_at
before update on advisor_topic_tags
for each row
execute function quorum_set_updated_at();

create table advisor_selection_profiles (
  advisor_id uuid primary key references advisors(id) on delete cascade,
  dossier_id uuid not null,
  profile_text_en text not null,
  embedding vector(1536) not null,
  embedding_model text not null,
  input_checksum_sha256 char(64) not null,
  updated_at timestamptz not null default now(),
  constraint advisor_selection_profiles_dossier_fk
    foreign key (advisor_id, dossier_id)
    references advisor_dossiers(advisor_id, id)
    on delete restrict,
  check (profile_text_en <> ''),
  check (input_checksum_sha256 ~ '^[0-9a-f]{64}$')
);

create trigger quorum_touch_advisor_selection_profiles_updated_at
before update on advisor_selection_profiles
for each row
execute function quorum_set_updated_at();

alter table chats
  add column telegram_chat_id bigint,
  add column chat_kind chat_kind;

update chats
set telegram_chat_id = 0,
    chat_kind = 'single_advisor'
where telegram_chat_id is null
   or chat_kind is null;

alter table chats
  alter column telegram_chat_id set default 0,
  alter column telegram_chat_id set not null,
  alter column chat_kind set default 'single_advisor',
  alter column chat_kind set not null,
  alter column advisor_id drop not null;

create index chats_telegram_chat_created_idx
  on chats(telegram_chat_id, created_at desc);

create unique index chats_user_id_id_uidx
  on chats(user_id, id);

create table telegram_chat_states (
  telegram_chat_id bigint primary key,
  user_id uuid not null references app_users(id) on delete cascade,
  current_chat_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id),
  constraint telegram_chat_states_current_chat_fk
    foreign key (current_chat_id)
    references chats(id)
    on delete set null
);

create trigger quorum_touch_telegram_chat_states_updated_at
before update on telegram_chat_states
for each row
execute function quorum_set_updated_at();

create table chat_advisors (
  chat_id uuid not null references chats(id) on delete cascade,
  advisor_id uuid not null references advisors(id) on delete restrict,
  selection_rank smallint not null,
  specialist_fit_score numeric(6,5),
  selection_basis jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  primary key (chat_id, advisor_id),
  unique (chat_id, selection_rank),
  check (selection_rank between 1 and 5),
  check (
    specialist_fit_score is null
    or (specialist_fit_score >= 0 and specialist_fit_score <= 1)
  )
);

insert into chat_advisors (
  chat_id,
  advisor_id,
  selection_rank,
  selection_basis
)
select
  id,
  advisor_id,
  1,
  '{"migration":"legacy_single_advisor"}'::jsonb
from chats
where advisor_id is not null
on conflict do nothing;

create or replace function quorum_backfill_single_chat_advisor()
returns trigger
language plpgsql
as $$
begin
  if new.advisor_id is not null then
    insert into chat_advisors (
      chat_id,
      advisor_id,
      selection_rank,
      selection_basis
    )
    values (
      new.id,
      new.advisor_id,
      1,
      '{"source":"legacy_chats_advisor_id"}'::jsonb
    )
    on conflict do nothing;
  end if;

  return new;
end;
$$;

create trigger quorum_backfill_single_chat_advisor
after insert or update of advisor_id on chats
for each row
execute function quorum_backfill_single_chat_advisor();

alter table chat_messages
  add column advisor_id uuid,
  add column telegram_message_id bigint;

update chat_messages as message
set advisor_id = chat.advisor_id
from chats as chat
where chat.id = message.chat_id
  and message.role = 'assistant'
  and message.advisor_id is null;

drop index if exists chat_messages_turn_role_uidx;

do $$
declare
  v_constraint_name text;
begin
  select conname
  into v_constraint_name
  from pg_constraint
  where conrelid = 'public.chat_messages'::regclass
    and contype = 'c'
    and pg_get_constraintdef(oid) like '%client_message_id%'
    and pg_get_constraintdef(oid) like '%prompt_version%'
  limit 1;

  if v_constraint_name is not null then
    execute format('alter table chat_messages drop constraint %I', v_constraint_name);
  end if;
end;
$$;

alter table chat_messages
  add constraint chat_messages_advisor_fk
    foreign key (chat_id, advisor_id)
    references chat_advisors(chat_id, advisor_id)
    on delete restrict,
  add constraint chat_messages_role_payload_check
    check (
      (
        role = 'user'
        and advisor_id is null
        and model_name is null
        and prompt_version is null
        and (client_message_id is not null or telegram_message_id is not null)
      )
      or (
        role = 'assistant'
        and advisor_id is not null
        and client_message_id is null
        and model_name is not null
        and prompt_version is not null
      )
    );

create unique index chat_messages_assistant_turn_advisor_uidx
  on chat_messages(chat_id, turn_id, advisor_id)
  where role = 'assistant';

create unique index chat_messages_inbound_telegram_uidx
  on chat_messages(chat_id, telegram_message_id)
  where role = 'user' and telegram_message_id is not null;

create or replace function quorum_set_legacy_assistant_advisor_id()
returns trigger
language plpgsql
as $$
begin
  if new.role = 'assistant' and new.advisor_id is null then
    select chat_advisors.advisor_id
    into new.advisor_id
    from chat_advisors
    where chat_advisors.chat_id = new.chat_id
    order by chat_advisors.selection_rank
    limit 1;
  end if;

  return new;
end;
$$;

create trigger quorum_set_legacy_assistant_advisor_id
before insert or update of role, advisor_id, chat_id on chat_messages
for each row
execute function quorum_set_legacy_assistant_advisor_id();

create table telegram_update_receipts (
  update_id bigint primary key,
  telegram_chat_id bigint,
  telegram_message_id bigint,
  user_id uuid references app_users(id) on delete set null,
  status telegram_update_status not null default 'processing',
  processed_chat_id uuid,
  processed_turn_id uuid,
  error_code text,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  constraint telegram_update_receipts_processed_chat_fk
    foreign key (processed_chat_id)
    references chats(id)
    on delete set null,
  constraint telegram_update_receipts_processed_turn_fk
    foreign key (processed_chat_id, processed_turn_id)
    references chat_messages(chat_id, user_turn_id)
    on delete set null,
  check (
    (status in ('processed', 'ignored', 'failed') and processed_at is not null)
    or (status = 'processing' and processed_at is null)
  )
);

create index telegram_update_receipts_user_received_idx
  on telegram_update_receipts(user_id, received_at desc);

grant select, insert, update on table public.advisor_topic_tags to service_role;
grant select, insert, update on table public.advisor_selection_profiles to service_role;
grant select, insert, update on table public.telegram_chat_states to service_role;
grant select, insert, update on table public.telegram_update_receipts to service_role;
grant select, insert, update on table public.chat_advisors to service_role;

commit;
