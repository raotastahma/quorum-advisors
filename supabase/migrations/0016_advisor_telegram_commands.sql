begin;

alter table advisors
  add column telegram_command citext;

create or replace function quorum_set_approved_release_telegram_command()
returns trigger
language plpgsql
as $$
begin
  if new.telegram_command is null then
    if new.slug = 'marcus-aurelius' or new.display_name = 'Marcus Aurelius' then
      new.telegram_command := 'marcus_aurelius';
    elsif new.slug = 'paul-graham' or new.display_name = 'Paul Graham' then
      new.telegram_command := 'paul_graham';
    end if;
  end if;

  return new;
end;
$$;

create trigger quorum_set_approved_release_telegram_command
before insert or update of slug, display_name, telegram_command on advisors
for each row
execute function quorum_set_approved_release_telegram_command();

update advisors
set telegram_command = case
  when slug = 'marcus-aurelius' or display_name = 'Marcus Aurelius' then 'marcus_aurelius'
  when slug = 'paul-graham' or display_name = 'Paul Graham' then 'paul_graham'
  else telegram_command
end
where telegram_command is null;

do $$
begin
  if exists (
    select 1
    from advisors
    where telegram_command is null
  ) then
    raise exception 'advisors.telegram_command is required for every advisor before enforcing not null';
  end if;
end;
$$;

alter table advisors
  alter column telegram_command set not null,
  add constraint advisors_telegram_command_not_empty_check
    check (telegram_command <> ''),
  add constraint advisors_telegram_command_syntax_check
    check (telegram_command::text ~ '^[a-z0-9_]{1,32}$'),
  add constraint advisors_telegram_command_not_reserved_check
    check (telegram_command not in ('start', 'all', 'ask')),
  add constraint advisors_telegram_command_key
    unique (telegram_command);

commit;
