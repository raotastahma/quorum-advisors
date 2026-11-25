begin;

create table advisor_review_gate_events (
  id uuid primary key default gen_random_uuid(),
  advisor_id uuid not null references advisors(id) on delete cascade,
  gate_type review_gate_type not null,
  from_status review_status,
  to_status review_status not null,
  reviewed_by text,
  review_notes text,
  dossier_id uuid,
  approved_fragment_count integer,
  created_at timestamptz not null default now(),
  constraint advisor_review_gate_events_dossier_fk
    foreign key (advisor_id, dossier_id)
    references advisor_dossiers(advisor_id, id)
    on delete restrict,
  check (
    (gate_type = 'source_catalog' and dossier_id is null)
    or (gate_type = 'advisor_corpus' and dossier_id is not null)
  ),
  check (approved_fragment_count is null or approved_fragment_count >= 0),
  check (from_status is null or from_status <> to_status)
);

create index advisor_review_gate_events_lookup_idx
  on advisor_review_gate_events(advisor_id, gate_type, created_at desc);

create or replace function quorum_derive_advisor_readiness(
  p_advisor_id uuid,
  p_benchmark_passed_at timestamptz
)
returns advisor_readiness_status
language sql
stable
as $$
  with gate_state as (
    select
      bool_or(gate_type = 'source_catalog' and status = 'approved') as source_catalog_approved,
      bool_or(gate_type = 'advisor_corpus' and status = 'approved') as advisor_corpus_approved
    from advisor_review_gates
    where advisor_id = p_advisor_id
  )
  select case
    when coalesce(source_catalog_approved, false)
      and coalesce(advisor_corpus_approved, false)
      and p_benchmark_passed_at is not null
      then 'advisor_ready'::advisor_readiness_status
    when coalesce(source_catalog_approved, false)
      and coalesce(advisor_corpus_approved, false)
      then 'corpus_approved_pending_benchmark'::advisor_readiness_status
    when coalesce(source_catalog_approved, false)
      then 'source_catalog_approved'::advisor_readiness_status
    else 'not_ready'::advisor_readiness_status
  end
  from gate_state;
$$;

create or replace function quorum_refresh_advisor_readiness(p_advisor_id uuid)
returns void
language plpgsql
as $$
declare
  v_benchmark_passed_at timestamptz;
  v_readiness advisor_readiness_status;
begin
  select benchmark_passed_at
  into v_benchmark_passed_at
  from advisors
  where id = p_advisor_id
  for update;

  if not found then
    raise exception 'advisor % does not exist', p_advisor_id;
  end if;

  v_readiness := quorum_derive_advisor_readiness(p_advisor_id, v_benchmark_passed_at);

  update advisors
  set readiness_status = v_readiness
  where id = p_advisor_id
    and readiness_status is distinct from v_readiness;
end;
$$;

create or replace function quorum_guard_advisor_readiness()
returns trigger
language plpgsql
as $$
declare
  v_derived advisor_readiness_status;
begin
  v_derived := quorum_derive_advisor_readiness(new.id, new.benchmark_passed_at);

  if tg_op = 'INSERT' then
    if new.readiness_status is distinct from v_derived then
      raise exception
        using
          errcode = '23514',
          message = format(
            'advisors.readiness_status must be %s for advisor %s',
            v_derived,
            new.id
          );
    end if;

    new.readiness_status := v_derived;
    return new;
  end if;

  if new.benchmark_passed_at is distinct from old.benchmark_passed_at
     and new.readiness_status is not distinct from old.readiness_status then
    new.readiness_status := v_derived;
    return new;
  end if;

  if new.readiness_status is distinct from old.readiness_status
     and new.readiness_status is distinct from v_derived then
    raise exception
      using
        errcode = '23514',
        message = format(
          'advisors.readiness_status must be %s for advisor %s',
          v_derived,
          new.id
        );
  end if;

  new.readiness_status := v_derived;
  return new;
end;
$$;

create or replace function quorum_refresh_advisor_readiness_from_gate()
returns trigger
language plpgsql
as $$
begin
  perform quorum_refresh_advisor_readiness(coalesce(new.advisor_id, old.advisor_id));
  return coalesce(new, old);
end;
$$;

create or replace function quorum_prevent_review_gate_event_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'advisor_review_gate_events is append-only';
end;
$$;

create or replace function quorum_apply_review_gate_decision(
  p_advisor_id uuid,
  p_gate_type review_gate_type,
  p_to_status review_status,
  p_reviewed_by text,
  p_review_notes text,
  p_dossier_id uuid,
  p_approved_fragment_count integer,
  p_reviewed_at timestamptz default now()
)
returns void
language plpgsql
as $$
declare
  v_from_status review_status;
begin
  perform 1
  from advisors
  where id = p_advisor_id
  for update;

  if not found then
    raise exception 'advisor % does not exist', p_advisor_id;
  end if;

  select status
  into v_from_status
  from advisor_review_gates
  where advisor_id = p_advisor_id
    and gate_type = p_gate_type
  for update;

  insert into advisor_review_gate_events (
    advisor_id,
    gate_type,
    from_status,
    to_status,
    reviewed_by,
    review_notes,
    dossier_id,
    approved_fragment_count,
    created_at
  )
  values (
    p_advisor_id,
    p_gate_type,
    v_from_status,
    p_to_status,
    p_reviewed_by,
    p_review_notes,
    p_dossier_id,
    p_approved_fragment_count,
    coalesce(p_reviewed_at, now())
  );

  insert into advisor_review_gates (
    advisor_id,
    gate_type,
    status,
    reviewed_by,
    review_notes,
    dossier_id,
    approved_fragment_count,
    reviewed_at
  )
  values (
    p_advisor_id,
    p_gate_type,
    p_to_status,
    p_reviewed_by,
    p_review_notes,
    p_dossier_id,
    p_approved_fragment_count,
    coalesce(p_reviewed_at, now())
  )
  on conflict (advisor_id, gate_type)
  do update
  set status = excluded.status,
      reviewed_by = excluded.reviewed_by,
      review_notes = excluded.review_notes,
      dossier_id = excluded.dossier_id,
      approved_fragment_count = excluded.approved_fragment_count,
      reviewed_at = excluded.reviewed_at;
end;
$$;

create trigger quorum_guard_advisor_readiness_before_write
before insert or update of readiness_status, benchmark_passed_at on advisors
for each row
execute function quorum_guard_advisor_readiness();

create trigger quorum_refresh_advisor_readiness_after_gate_write
after insert or update or delete on advisor_review_gates
for each row
execute function quorum_refresh_advisor_readiness_from_gate();

create trigger quorum_prevent_review_gate_event_updates
before update on advisor_review_gate_events
for each row
execute function quorum_prevent_review_gate_event_mutation();

create trigger quorum_prevent_review_gate_event_deletes
before delete on advisor_review_gate_events
for each row
execute function quorum_prevent_review_gate_event_mutation();

commit;
