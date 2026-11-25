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
  v_grounding jsonb;
  v_fragment_id uuid;
  v_rank_order smallint;
  v_similarity_score numeric(6, 5);
  v_ordinality smallint := 0;
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

  for v_grounding in
    select grounding.value
    from jsonb_array_elements(coalesce(p_groundings, '[]'::jsonb)) as grounding(value)
  loop
    v_ordinality := v_ordinality + 1;
    v_fragment_id := (v_grounding ->> 'corpusFragmentId')::uuid;
    v_rank_order := coalesce((v_grounding ->> 'rankOrder')::smallint, v_ordinality);
    v_similarity_score := case
      when v_grounding ->> 'similarityScore' is null
        then null
      else (v_grounding ->> 'similarityScore')::numeric(6, 5)
    end;

    begin
      insert into chat_message_groundings (
        assistant_message_id,
        message_role,
        corpus_fragment_id,
        rank_order,
        similarity_score
      )
      values (
        v_message.id,
        'assistant',
        v_fragment_id,
        v_rank_order,
        v_similarity_score
      );
    exception
      when unique_violation then
        update chat_message_groundings as existing_grounding
        set rank_order = v_rank_order,
            similarity_score = v_similarity_score
        where existing_grounding.assistant_message_id = v_message.id
          and existing_grounding.corpus_fragment_id = v_fragment_id;
    end;
  end loop;

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
