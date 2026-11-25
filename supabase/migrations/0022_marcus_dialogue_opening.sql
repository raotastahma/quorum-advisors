begin;

alter table public.chats add column marcus_opening_turn_id uuid;

-- A persisted claim survives process restarts and context-window truncation.
-- Historical messages are inspected in SQL, never inferred from a model window.
create or replace function public.quorum_claim_marcus_dialogue_opening(
  p_chat_id uuid, p_turn_id uuid, p_advisor_id uuid
)
returns boolean
language plpgsql
as $$
declare
  v_opening_turn_id uuid;
  v_first_user_turn_id uuid;
begin
  if not exists (
    select 1 from public.chat_advisors ca
    join public.advisors a on a.id = ca.advisor_id
    where ca.chat_id = p_chat_id and a.id = p_advisor_id and a.slug = 'marcus-aurelius'
  ) then
    return false;
  end if;

  select marcus_opening_turn_id into v_opening_turn_id
  from public.chats where id = p_chat_id for update;
  if not found then return false; end if;
  if v_opening_turn_id is not null then return v_opening_turn_id = p_turn_id; end if;

  if exists (select 1 from public.chat_messages where chat_id = p_chat_id and role = 'assistant' and (advisor_id = p_advisor_id or advisor_id is null)) then
    return false;
  end if;
  select turn_id into v_first_user_turn_id from public.chat_messages
    where chat_id = p_chat_id and role = 'user' order by created_at, id limit 1;
  if v_first_user_turn_id is not null and v_first_user_turn_id <> p_turn_id then
    return false;
  end if;

  update public.chats set marcus_opening_turn_id = p_turn_id where id = p_chat_id;
  return true;
end;
$$;

revoke execute on function public.quorum_claim_marcus_dialogue_opening(uuid,uuid,uuid) from public, anon, authenticated;
grant execute on function public.quorum_claim_marcus_dialogue_opening(uuid,uuid,uuid) to service_role;

commit;
