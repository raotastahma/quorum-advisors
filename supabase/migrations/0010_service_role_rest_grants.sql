begin;

grant usage on schema public to service_role;

grant select on table public.advisors to service_role;
grant select, insert, update on table public.app_users to service_role;
grant select, insert on table public.app_sessions to service_role;

commit;
