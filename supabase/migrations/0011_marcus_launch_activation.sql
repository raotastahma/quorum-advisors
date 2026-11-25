begin;

alter table advisors
  add constraint advisors_launch_enabled_requires_public_ready
  check (
    is_launch_enabled = false
    or (
      persona_status = 'active'
      and readiness_status = 'advisor_ready'
      and benchmark_passed_at is not null
    )
  );

create or replace function quorum_enable_marcus_launch(
  p_h002_launch_decision text
)
returns table (
  advisor_id uuid,
  slug citext,
  persona_status advisor_persona_status,
  readiness_status advisor_readiness_status,
  benchmark_passed_at timestamptz,
  is_launch_enabled boolean
)
language plpgsql
as $$
declare
  v_advisor advisors%rowtype;
begin
  if lower(btrim(coalesce(p_h002_launch_decision, ''))) <> 'go' then
    raise exception 'H-002 launch decision must be go before enabling Marcus launch';
  end if;

  select *
  into v_advisor
  from advisors
  where advisors.slug = 'marcus-aurelius'
  for update;

  if not found then
    raise exception 'Marcus advisor row is missing';
  end if;

  if v_advisor.benchmark_passed_at is null then
    raise exception 'Marcus benchmark_passed_at is required before public launch';
  end if;

  if v_advisor.readiness_status <> 'advisor_ready' then
    raise exception 'Marcus must be advisor_ready before public launch';
  end if;

  return query
  update advisors
  set persona_status = 'active',
      is_launch_enabled = true
  where advisors.id = v_advisor.id
  returning
    advisors.id,
    advisors.slug,
    advisors.persona_status,
    advisors.readiness_status,
    advisors.benchmark_passed_at,
    advisors.is_launch_enabled;
end;
$$;

revoke all on function public.quorum_enable_marcus_launch(text) from public;
revoke all on function public.quorum_enable_marcus_launch(text) from anon;
revoke all on function public.quorum_enable_marcus_launch(text) from authenticated;
revoke all on function public.quorum_enable_marcus_launch(text) from service_role;
revoke update on table public.advisors from public;
revoke update on table public.advisors from anon;
revoke update on table public.advisors from authenticated;
revoke update on table public.advisors from service_role;

commit;
