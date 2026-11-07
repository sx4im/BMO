-- Gateway-only share lookup and server-owned usage accounting.
-- Apply after 0009. This is intentionally forward-only and preserves data.
begin;

drop policy if exists "shared_conversations read" on public.shared_conversations;
drop policy if exists "shared_conversations write" on public.shared_conversations;
revoke all privileges on table public.shared_conversations from public, anon, authenticated;
grant all privileges on table public.shared_conversations to service_role;

drop policy if exists "usage write" on public.usage_events;
revoke all privileges on table public.usage_events from public, anon, authenticated;
grant select on table public.usage_events to authenticated;
grant all privileges on table public.usage_events to service_role;

-- NOT VALID protects new writes immediately without allowing old corrupt
-- metering rows to roll back the permission repair. Inspect existing negative
-- counts and validate this constraint as described in the deployment guide.
do $$ begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.usage_events'::regclass
      and conname = 'usage_events_tokens_nonnegative'
  ) then
    alter table public.usage_events add constraint usage_events_tokens_nonnegative
      check (tokens >= 0) not valid;
  end if;
end $$;

commit;
