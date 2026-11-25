begin;

create or replace function public.quorum_enable_paul_graham_launch(
  p_h006_launch_decision text,
  p_benchmark_passed_at timestamptz
)
returns table (
  advisor_id uuid,
  slug citext,
  telegram_command citext,
  display_name_key citext,
  persona_status advisor_persona_status,
  readiness_status advisor_readiness_status,
  benchmark_passed_at timestamptz,
  is_launch_enabled boolean
)
language plpgsql
as $$
declare
  v_advisor advisors%rowtype;
  v_dossier_id uuid;
  v_dossier_version integer;
  v_source_count integer;
  v_covered_source_count integer;
  v_approved_document_count integer;
  v_approved_fragment_count integer;
begin
  if lower(btrim(coalesce(p_h006_launch_decision, ''))) <> 'go' then
    raise exception 'H-006 launch decision must be go before enabling Paul Graham launch';
  end if;

  if p_benchmark_passed_at is null then
    raise exception 'Paul Graham benchmark_passed_at is required before public launch';
  end if;

  select *
  into v_advisor
  from public.advisors
  where advisors.slug = 'paul-graham'
  for update;

  if not found then
    raise exception 'Paul Graham advisor row is missing';
  end if;

  if v_advisor.telegram_command <> 'paul_graham' then
    raise exception 'Paul Graham telegram_command must be paul_graham before public launch';
  end if;

  if nullif(v_advisor.display_name_key::text, '') is null then
    raise exception 'Paul Graham display_name_key is required before public launch';
  end if;

  select count(*)
  into v_source_count
  from public.advisor_sources s
  where s.advisor_id = v_advisor.id;

  if v_source_count <> 231 then
    raise exception 'Paul Graham source catalog must contain 231 official essay rows before public launch';
  end if;

  select count(distinct s.id)
  into v_covered_source_count
  from public.advisor_sources s
  join public.corpus_documents d
    on d.advisor_id = s.advisor_id
   and d.source_id = s.id
   and d.document_state = 'approved'
  where s.advisor_id = v_advisor.id
    and s.acquisition_status not in ('blocked', 'rejected');

  if v_covered_source_count <> v_source_count then
    raise exception 'Every Paul Graham source must have an approved corpus document before public launch';
  end if;

  select count(*)
  into v_approved_document_count
  from public.corpus_documents d
  where d.advisor_id = v_advisor.id
    and d.document_state = 'approved';

  if v_approved_document_count <> 231 then
    raise exception 'Paul Graham corpus must contain 231 approved documents before public launch';
  end if;

  select count(*)
  into v_approved_fragment_count
  from public.corpus_fragments f
  join public.corpus_documents d
    on d.id = f.document_id
   and d.advisor_id = f.advisor_id
  where f.advisor_id = v_advisor.id
    and f.fragment_state = 'approved'
    and d.document_state = 'approved';

  if v_approved_fragment_count <> 2140 then
    raise exception 'Paul Graham corpus must contain 2140 approved fragments before public launch';
  end if;

  select id, version
  into v_dossier_id, v_dossier_version
  from public.advisor_dossiers d
  where d.advisor_id = v_advisor.id
  order by d.version desc
  limit 1
  for update;

  if v_dossier_id is null then
    raise exception 'Paul Graham approved dossier is required before public launch';
  end if;

  update public.advisor_dossiers d
  set is_current = false
  where d.advisor_id = v_advisor.id
    and d.id <> v_dossier_id
    and d.is_current = true;

  update public.advisor_dossiers
  set artifact_state = 'approved',
      is_current = true,
      approved_at = p_benchmark_passed_at
  where id = v_dossier_id;

  if not exists (
    select 1
    from public.advisor_review_gates g
    where g.advisor_id = v_advisor.id
      and g.gate_type = 'source_catalog'
      and g.status = 'approved'
  ) then
    perform public.quorum_apply_review_gate_decision(
      v_advisor.id,
      'source_catalog',
      'approved',
      'QRM-030',
      'H-006 go decision recorded; Paul Graham official essay catalog approved for launch.',
      null,
      null,
      p_benchmark_passed_at
    );
  end if;

  if not exists (
    select 1
    from public.advisor_review_gates g
    where g.advisor_id = v_advisor.id
      and g.gate_type = 'advisor_corpus'
      and g.status = 'approved'
  ) then
    perform public.quorum_apply_review_gate_decision(
      v_advisor.id,
      'advisor_corpus',
      'approved',
      'QRM-030',
      'H-006 go decision recorded; Paul Graham corpus, dossier, and benchmark evidence approved for launch.',
      v_dossier_id,
      v_approved_fragment_count,
      p_benchmark_passed_at
    );
  end if;

  if not exists (
    select 1
    from public.advisor_review_gates g
    where g.advisor_id = v_advisor.id
      and g.gate_type = 'source_catalog'
      and g.status = 'approved'
      and g.dossier_id is null
  ) or not exists (
    select 1
    from public.advisor_review_gate_events e
    where e.advisor_id = v_advisor.id
      and e.gate_type = 'source_catalog'
      and e.to_status = 'approved'
      and e.dossier_id is null
  ) then
    raise exception 'Paul Graham source_catalog approval must have both snapshot and event before public launch';
  end if;

  if not exists (
    select 1
    from public.advisor_review_gates g
    where g.advisor_id = v_advisor.id
      and g.gate_type = 'advisor_corpus'
      and g.status = 'approved'
      and g.dossier_id = v_dossier_id
      and g.approved_fragment_count = v_approved_fragment_count
  ) or not exists (
    select 1
    from public.advisor_review_gate_events e
    where e.advisor_id = v_advisor.id
      and e.gate_type = 'advisor_corpus'
      and e.to_status = 'approved'
      and e.dossier_id = v_dossier_id
      and e.approved_fragment_count = v_approved_fragment_count
  ) then
    raise exception 'Paul Graham advisor_corpus approval must have both snapshot and event before public launch';
  end if;

  update public.advisors
  set persona_status = 'active',
      benchmark_passed_at = p_benchmark_passed_at,
      is_launch_enabled = true
  where id = v_advisor.id;

  if not exists (
    select 1
    from public.advisors a
    where a.id = v_advisor.id
      and a.persona_status = 'active'
      and a.readiness_status = 'advisor_ready'
      and a.benchmark_passed_at is not null
      and a.is_launch_enabled = true
  ) then
    raise exception 'Paul Graham launch activation did not reach final eligibility';
  end if;

  return query
  select
    advisors.id,
    advisors.slug,
    advisors.telegram_command,
    advisors.display_name_key,
    advisors.persona_status,
    advisors.readiness_status,
    advisors.benchmark_passed_at,
    advisors.is_launch_enabled
  from public.advisors
  where advisors.id = v_advisor.id;
end;
$$;

revoke all on function public.quorum_enable_paul_graham_launch(text, timestamptz) from public;
revoke all on function public.quorum_enable_paul_graham_launch(text, timestamptz) from anon;
revoke all on function public.quorum_enable_paul_graham_launch(text, timestamptz) from authenticated;
revoke all on function public.quorum_enable_paul_graham_launch(text, timestamptz) from service_role;

commit;
