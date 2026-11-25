begin;

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
    returning * into v_message;
  exception
    when unique_violation then
      select *
      into v_message
      from chat_messages as existing_message
      where existing_message.chat_id = p_chat_id
        and existing_message.turn_id = p_turn_id
        and existing_message.role = 'assistant'
      limit 1;
  end;

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

commit;
