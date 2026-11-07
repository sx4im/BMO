-- Bootstrap an EMPTY, disposable Postgres instance; never apply to Supabase.
create role anon;
create role authenticated;
create role service_role bypassrls;
create schema auth;
create table auth.users(id uuid primary key);
create function auth.uid() returns uuid language sql stable as
  $$ select nullif(current_setting('request.jwt.claim.sub', true),'')::uuid $$;
create schema storage;
create table storage.buckets(id text primary key, name text, public boolean);
create table storage.objects(id uuid primary key, bucket_id text, name text);
create function storage.foldername(name text) returns text[] language sql immutable as
  $$ select string_to_array(regexp_replace(name,'/[^/]*$',''),'/') $$;
grant usage on schema public, auth, storage to anon, authenticated, service_role;
-- Model existing Supabase public-schema defaults before hardening migrations.
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
