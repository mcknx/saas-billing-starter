-- Supabase already provides these. This stub lets the schema run on plain Postgres / PGlite in tests.
create role authenticated;
create schema auth;
create table auth.users (id uuid primary key, email text unique not null);
create function auth.uid() returns uuid language sql stable as
$$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema auth to authenticated;
