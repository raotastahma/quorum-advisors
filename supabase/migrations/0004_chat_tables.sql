begin;

do $$
begin
  create type chat_status as enum ('active', 'closed');
exception
  when duplicate_object then
    null;
end;
$$;

do $$
begin
  create type message_role as enum ('user', 'assistant');
exception
  when duplicate_object then
    null;
end;
$$;

create table app_users (
  id uuid primary key default gen_random_uuid(),
  telegram_user_id bigint not null unique,
  telegram_username text,
  first_name text not null,
  last_name text,
  language_code text,
  is_premium boolean not null default false,
  photo_url text,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  check (first_name <> '')
);

create table app_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app_users(id) on delete cascade,
  session_token_hash char(64) not null unique,
  init_data_hash_sha256 char(64) not null,
  telegram_auth_date timestamptz not null,
  telegram_query_id text,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  check (session_token_hash ~ '^[0-9a-f]{64}$'),
  check (init_data_hash_sha256 ~ '^[0-9a-f]{64}$'),
  check (expires_at > created_at),
  check (revoked_at is null or revoked_at >= created_at)
);

create index app_sessions_user_id_idx on app_sessions(user_id);
create index app_sessions_expires_at_idx on app_sessions(expires_at);

create table chats (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app_users(id) on delete cascade,
  advisor_id uuid not null references advisors(id) on delete restrict,
  locale text not null,
  status chat_status not null default 'active',
  created_at timestamptz not null default now(),
  last_message_at timestamptz not null default now(),
  check (locale in ('ru', 'en'))
);

create index chats_user_created_idx on chats(user_id, created_at desc);
create index chats_advisor_idx on chats(advisor_id);

create table chat_messages (
  id uuid primary key default gen_random_uuid(),
  chat_id uuid not null references chats(id) on delete cascade,
  turn_id uuid not null,
  role message_role not null,
  client_message_id uuid,
  body_text text not null,
  locale text not null,
  model_name text,
  prompt_version text,
  created_at timestamptz not null default now(),
  user_turn_id uuid generated always as (
    case when role = 'user' then turn_id end
  ) stored,
  assistant_turn_id uuid generated always as (
    case when role = 'assistant' then turn_id end
  ) stored,
  check (locale in ('ru', 'en')),
  check (btrim(body_text) <> ''),
  check (
    (role = 'user' and client_message_id is not null and model_name is null and prompt_version is null)
    or (role = 'assistant' and client_message_id is null and model_name is not null and prompt_version is not null)
  )
);

create index chat_messages_chat_created_idx
  on chat_messages(chat_id, created_at asc);

create unique index chat_messages_user_idempotency_uidx
  on chat_messages(chat_id, client_message_id)
  where client_message_id is not null;

create unique index chat_messages_turn_role_uidx
  on chat_messages(chat_id, turn_id, role);

create unique index chat_messages_id_role_uidx
  on chat_messages(id, role);

create unique index chat_messages_user_turn_uidx
  on chat_messages(chat_id, user_turn_id);

alter table chat_messages
  add constraint chat_messages_assistant_turn_user_fk
  foreign key (chat_id, assistant_turn_id)
  references chat_messages(chat_id, user_turn_id)
  on delete cascade;

create table chat_message_groundings (
  id uuid primary key default gen_random_uuid(),
  assistant_message_id uuid not null,
  message_role message_role not null default 'assistant',
  corpus_fragment_id uuid not null references corpus_fragments(id) on delete restrict,
  rank_order smallint not null,
  similarity_score numeric(6,5),
  created_at timestamptz not null default now(),
  unique (assistant_message_id, corpus_fragment_id),
  check (message_role = 'assistant'),
  check (rank_order >= 1)
);

create index chat_message_groundings_message_idx
  on chat_message_groundings(assistant_message_id, rank_order);

alter table chat_message_groundings
  add constraint chat_message_groundings_assistant_fk
  foreign key (assistant_message_id, message_role)
  references chat_messages(id, role)
  on delete cascade;

commit;
