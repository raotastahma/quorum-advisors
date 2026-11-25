begin;

create or replace function quorum_prepare_chat_turn(
  p_chat_id uuid,
  p_client_message_id uuid,
  p_body_text text,
  p_locale text
)
returns table (
  user_message_id uuid,
  turn_id uuid,
  user_body_text text,
  user_locale text,
  user_created_at timestamptz,
  assistant_message_id uuid,
  assistant_body_text text,
  assistant_locale text,
  assistant_created_at timestamptz
)
language plpgsql
as $$
declare
  v_turn_id uuid := gen_random_uuid();
begin
  begin
    insert into chat_messages (
      chat_id,
      turn_id,
      role,
      client_message_id,
      body_text,
      locale
    )
    values (
      p_chat_id,
      v_turn_id,
      'user',
      p_client_message_id,
      p_body_text,
      p_locale
    );
  exception
    when unique_violation then
      null;
  end;

  update chats
  set last_message_at = greatest(last_message_at, now())
  where id = p_chat_id;

  return query
  select
    user_message.id,
    user_message.turn_id,
    user_message.body_text,
    user_message.locale,
    user_message.created_at,
    assistant_message.id,
    assistant_message.body_text,
    assistant_message.locale,
    assistant_message.created_at
  from chat_messages as user_message
  left join chat_messages as assistant_message
    on assistant_message.chat_id = user_message.chat_id
   and assistant_message.turn_id = user_message.turn_id
   and assistant_message.role = 'assistant'
  where user_message.chat_id = p_chat_id
    and user_message.client_message_id = p_client_message_id
    and user_message.role = 'user'
  limit 1;
end;
$$;

create or replace function quorum_finalize_chat_turn(
  p_chat_id uuid,
  p_turn_id uuid,
  p_body_text text,
  p_locale text,
  p_model_name text,
  p_prompt_version text,
  p_groundings jsonb default '[]'::jsonb
)
returns table (
  assistant_message_id uuid,
  turn_id uuid,
  body_text text,
  locale text,
  created_at timestamptz
)
language plpgsql
as $$
declare
  v_message chat_messages%rowtype;
begin
  insert into chat_messages (
    chat_id,
    turn_id,
    role,
    body_text,
    locale,
    model_name,
    prompt_version
  )
  values (
    p_chat_id,
    p_turn_id,
    'assistant',
    p_body_text,
    p_locale,
    p_model_name,
    p_prompt_version
  )
  on conflict (chat_id, turn_id, role)
  do update set
    body_text = chat_messages.body_text
  returning * into v_message;

  insert into chat_message_groundings (
    assistant_message_id,
    message_role,
    corpus_fragment_id,
    rank_order,
    similarity_score
  )
  select
    v_message.id,
    'assistant',
    (grounding.value ->> 'corpusFragmentId')::uuid,
    coalesce((grounding.value ->> 'rankOrder')::smallint, grounding.ordinality::smallint),
    case
      when grounding.value ->> 'similarityScore' is null
        then null
      else (grounding.value ->> 'similarityScore')::numeric(6, 5)
    end
  from jsonb_array_elements(coalesce(p_groundings, '[]'::jsonb)) with ordinality
    as grounding(value, ordinality)
  on conflict (assistant_message_id, corpus_fragment_id)
  do update set
    rank_order = excluded.rank_order,
    similarity_score = excluded.similarity_score;

  update chats
  set last_message_at = greatest(last_message_at, v_message.created_at)
  where id = p_chat_id;

  return query
  select
    v_message.id,
    v_message.turn_id,
    v_message.body_text,
    v_message.locale,
    v_message.created_at;
end;
$$;

create or replace function quorum_match_corpus_fragments(
  p_advisor_id uuid,
  p_query_embedding text,
  p_match_count integer default 6
)
returns table (
  corpus_fragment_id uuid,
  fragment_index integer,
  original_text text,
  retrieval_text_en text,
  original_language_code text,
  source_key text,
  document_title text,
  similarity_score numeric
)
language sql
stable
as $$
  select
    fragment.id as corpus_fragment_id,
    fragment.fragment_index,
    fragment.original_text,
    fragment.retrieval_text_en,
    fragment.original_language_code,
    source.source_key,
    document.title as document_title,
    round((1 - (fragment.embedding <=> (p_query_embedding::vector)))::numeric, 5) as similarity_score
  from corpus_fragments as fragment
  join corpus_documents as document
    on document.id = fragment.document_id
   and document.advisor_id = fragment.advisor_id
  join advisor_sources as source
    on source.id = document.source_id
   and source.advisor_id = document.advisor_id
  where fragment.advisor_id = p_advisor_id
    and fragment.fragment_state = 'approved'
    and document.document_state = 'approved'
    and source.acquisition_status in ('approved', 'ingested')
  order by fragment.embedding <=> (p_query_embedding::vector), fragment.id
  limit greatest(least(coalesce(p_match_count, 6), 12), 1);
$$;

commit;
