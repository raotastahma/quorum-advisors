begin;

create or replace function quorum_publish_advisor_dossier(
  p_advisor_id uuid,
  p_version integer,
  p_schema_version integer,
  p_payload jsonb,
  p_approved_at timestamptz default now()
)
returns uuid
language plpgsql
as $$
declare
  v_dossier_id uuid;
begin
  if p_payload is null then
    raise exception 'dossier payload is required';
  end if;

  if p_approved_at is null then
    raise exception 'approved_at is required for a published dossier';
  end if;

  perform 1
  from advisors
  where id = p_advisor_id
  for update;

  if not found then
    raise exception 'advisor % does not exist', p_advisor_id;
  end if;

  update advisor_dossiers
  set is_current = false
  where advisor_id = p_advisor_id
    and is_current = true;

  insert into advisor_dossiers (
    advisor_id,
    version,
    schema_version,
    artifact_state,
    is_current,
    payload,
    approved_at
  )
  values (
    p_advisor_id,
    p_version,
    p_schema_version,
    'approved',
    true,
    p_payload,
    p_approved_at
  )
  on conflict (advisor_id, version)
  do update
  set schema_version = excluded.schema_version,
      artifact_state = excluded.artifact_state,
      is_current = excluded.is_current,
      payload = excluded.payload,
      approved_at = excluded.approved_at
  returning id into v_dossier_id;

  return v_dossier_id;
end;
$$;

commit;
