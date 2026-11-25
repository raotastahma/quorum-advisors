begin;

-- The bot backend is the sole database API client. Browser roles get no access.
revoke all on all tables in schema public from public, anon, authenticated;
revoke all on all sequences in schema public from public, anon, authenticated;
do $$
declare
  app_function regprocedure;
begin
  for app_function in
    select p.oid::regprocedure
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like 'quorum\_%' escape '\'
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', app_function);
  end loop;
end;
$$;

alter default privileges in schema public
  revoke all on tables from public, anon, authenticated;
alter default privileges in schema public
  revoke all on sequences from public, anon, authenticated;
alter default privileges in schema public
  revoke execute on functions from public, anon, authenticated;

commit;
