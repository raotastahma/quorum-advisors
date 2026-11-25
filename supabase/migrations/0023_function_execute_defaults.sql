begin;

-- PostgreSQL grants PUBLIC execution globally for functions created by this role.
-- Schema-specific defaults can add privileges but cannot remove this grant.
alter default privileges revoke execute on functions from public;

commit;
