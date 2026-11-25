-- Exercise the migration owner's default permissions for a newly created RPC.
begin;
create function public.quorum_default_execute_probe() returns integer
language sql as $$ select 1 $$;
do $$
begin
  assert not has_function_privilege('anon', 'public.quorum_default_execute_probe()', 'execute');
  assert not has_function_privilege('authenticated', 'public.quorum_default_execute_probe()', 'execute');
end;
$$;
grant execute on function public.quorum_default_execute_probe() to service_role;
set local role service_role;
select public.quorum_default_execute_probe();
rollback;

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

begin;
insert into advisors(id, slug, display_name, short_bio, era_label, domain_label, disclaimer_text, supported_locales, telegram_command)
values ('00000000-0000-4000-8000-000000000010', 'marcus-aurelius', 'Marcus Aurelius', 'Dialogue-policy test metadata only.', 'Test', 'Test', 'AI-generated test persona metadata, not a historical representation.', array['en','ru'], 'marcus_aurelius');
do $$
declare
  marcus uuid := '00000000-0000-4000-8000-000000000010';
  demo_user uuid := '00000000-0000-4000-8000-000000000006';
  first_turn uuid := gen_random_uuid();
  second_turn uuid := gen_random_uuid();
  initial_chat uuid := gen_random_uuid();
  bare_chat uuid := gen_random_uuid();
  resumed_chat uuid := gen_random_uuid();
  resumed_turn uuid := gen_random_uuid();
begin
  insert into chats(id,user_id,advisor_id,locale) values(initial_chat,demo_user,marcus,'en');
  insert into chat_messages(chat_id,turn_id,client_message_id,role,body_text,locale) values(initial_chat,first_turn,gen_random_uuid(),'user','A substantive first question.','en');
  assert not quorum_claim_marcus_dialogue_opening(initial_chat,first_turn,'00000000-0000-4000-8000-000000000001'), 'Other advisors must not receive Marcus opening';
  assert quorum_claim_marcus_dialogue_opening(initial_chat,first_turn,marcus), 'First substantive turn must open dialogue';
  assert quorum_claim_marcus_dialogue_opening(initial_chat,first_turn,marcus), 'Retry of the same opening turn must be idempotent';
  assert not quorum_claim_marcus_dialogue_opening(initial_chat,second_turn,marcus), 'Later turns must not open the same dialogue';

  insert into chats(id,user_id,advisor_id,locale) values(bare_chat,demo_user,marcus,'ru');
  assert quorum_claim_marcus_dialogue_opening(bare_chat,first_turn,marcus), 'Bare advisor command opens a new dialogue';
  insert into chat_messages(chat_id,turn_id,client_message_id,role,body_text,locale) values(bare_chat,second_turn,gen_random_uuid(),'user','Привет','ru');
  assert not quorum_claim_marcus_dialogue_opening(bare_chat,second_turn,marcus), 'First answer must not duplicate the bare-command opening';

  insert into chats(id,user_id,advisor_id,locale) values(resumed_chat,demo_user,marcus,'en');
  insert into chat_messages(chat_id,turn_id,client_message_id,role,body_text,locale,created_at)
    select resumed_chat,gen_random_uuid(),gen_random_uuid(),'user','Historical turn ' || n,'en', now() - interval '1 day' from generate_series(1,1005) n;
  insert into chat_messages(chat_id,turn_id,client_message_id,role,body_text,locale) values(resumed_chat,resumed_turn,gen_random_uuid(),'user','Hello after a resumed or trimmed context.','en');
  assert not quorum_claim_marcus_dialogue_opening(resumed_chat,resumed_turn,marcus), 'Resumed legacy history beyond the model window must not restart a dialogue';
  assert not has_function_privilege('anon','public.quorum_claim_marcus_dialogue_opening(uuid,uuid,uuid)','execute'), 'Browser roles must not claim openings';
  assert has_function_privilege('service_role','public.quorum_claim_marcus_dialogue_opening(uuid,uuid,uuid)','execute'), 'Backend claim must remain available';
end;
$$;
rollback;
