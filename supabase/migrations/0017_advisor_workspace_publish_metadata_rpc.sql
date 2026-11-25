begin;

create or replace function public.quorum_publish_advisor_metadata(
  p_slug citext,
  p_telegram_command citext,
  p_display_name text,
  p_short_bio text,
  p_era_label text,
  p_domain_label text,
  p_disclaimer_text text,
  p_supported_locales text[]
)
returns table (
  id uuid
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return query
  insert into public.advisors (
    slug,
    telegram_command,
    display_name,
    short_bio,
    era_label,
    domain_label,
    disclaimer_text,
    supported_locales
  )
  values (
    p_slug,
    p_telegram_command,
    p_display_name,
    p_short_bio,
    p_era_label,
    p_domain_label,
    p_disclaimer_text,
    p_supported_locales
  )
  on conflict (slug) do update
  set telegram_command = excluded.telegram_command,
      display_name = excluded.display_name,
      short_bio = excluded.short_bio,
      era_label = excluded.era_label,
      domain_label = excluded.domain_label,
      disclaimer_text = excluded.disclaimer_text,
      supported_locales = excluded.supported_locales
  returning advisors.id;
end;
$$;

revoke all on function public.quorum_publish_advisor_metadata(
  citext,
  citext,
  text,
  text,
  text,
  text,
  text,
  text[]
) from public;
revoke all on function public.quorum_publish_advisor_metadata(
  citext,
  citext,
  text,
  text,
  text,
  text,
  text,
  text[]
) from anon;
revoke all on function public.quorum_publish_advisor_metadata(
  citext,
  citext,
  text,
  text,
  text,
  text,
  text,
  text[]
) from authenticated;
grant execute on function public.quorum_publish_advisor_metadata(
  citext,
  citext,
  text,
  text,
  text,
  text,
  text,
  text[]
) to service_role;

commit;
