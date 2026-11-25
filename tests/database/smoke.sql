do $$
declare
  demo_vector text := ((array[1.0] || array_fill(0.0, array[1535]))::vector)::text;
  result_count integer;
begin
  select count(*) into result_count from quorum_match_corpus_fragments('00000000-0000-4000-8000-000000000001', demo_vector, 2);
  assert result_count = 1, 'Original demo evidence must be retrievable';
  select count(*) into result_count from quorum_select_advisors_for_question(demo_vector, 0.3, 5);
  assert result_count = 1, 'Original demo advisor must be selectable';
  assert not has_table_privilege('anon', 'public.chat_messages', 'select'), 'Anonymous role must not read chat data';
  assert not has_table_privilege('authenticated', 'public.corpus_fragments', 'select'), 'Browser role must not read source data';
  assert not has_function_privilege('anon', 'public.quorum_prepare_chat_turn(uuid,uuid,text,text)', 'execute'), 'Anonymous role must not execute chat RPCs';
  assert has_function_privilege('service_role', 'public.quorum_match_corpus_fragments(uuid,text,integer)', 'execute'), 'Backend retrieval RPC must remain available';
  assert has_table_privilege('service_role', 'public.advisor_dossiers', 'select'), 'Backend dossier access must remain available';
end;
$$;

-- Exercise the same retrieval RPC under the backend role, not only as database owner.
set role service_role;
do $$
declare
  demo_user uuid := '00000000-0000-4000-8000-000000000006';
  demo_chat uuid := '00000000-0000-4000-8000-000000000007';
  prepared_turn uuid;
  result_count integer;
begin
  insert into app_users(id, telegram_user_id, first_name) values(demo_user, 1, 'Fictional Demo User');
  insert into chats(id, user_id, advisor_id, locale, telegram_chat_id)
    values(demo_chat, demo_user, '00000000-0000-4000-8000-000000000001', 'en', 1);
  select prepared.turn_id into prepared_turn
    from quorum_prepare_chat_turn(demo_chat, '00000000-0000-4000-8000-000000000008', 'How should I learn?', 'en') prepared;
  select count(*) into result_count
    from quorum_finalize_chat_turn(demo_chat, prepared_turn, 'Choose a small reversible experiment.', 'en', 'deterministic-demo-adapter', 'demo-v1',
      '[{"corpusFragmentId":"00000000-0000-4000-8000-000000000004","rankOrder":1,"similarityScore":1}]');
  assert result_count = 1, 'Backend chat turn must finalize with its original grounding';
end;
$$;
select corpus_fragment_id, source_key
from quorum_match_corpus_fragments(
  '00000000-0000-4000-8000-000000000001',
  ((array[1.0] || array_fill(0.0, array[1535]))::vector)::text,
  2
);
reset role;
