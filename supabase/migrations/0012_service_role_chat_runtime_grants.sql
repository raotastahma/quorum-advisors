begin;

grant select, insert, update on table public.chats to service_role;
grant select, insert, update on table public.chat_messages to service_role;
grant select, insert, update on table public.chat_message_groundings to service_role;
grant select on table public.advisor_dossiers to service_role;
grant select on table public.advisor_sources to service_role;
grant select on table public.corpus_documents to service_role;
grant select on table public.corpus_fragments to service_role;

grant execute on function public.quorum_prepare_chat_turn(uuid, uuid, text, text) to service_role;
grant execute on function public.quorum_finalize_chat_turn(uuid, uuid, text, text, text, text, jsonb) to service_role;
grant execute on function public.quorum_match_corpus_fragments(uuid, text, integer) to service_role;

commit;
