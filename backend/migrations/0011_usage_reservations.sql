-- Apply after 0010. Private, service-role-only, atomic admission for paid work.
begin;
create schema if not exists bmo_private;
revoke all on schema bmo_private from public, anon, authenticated;
grant usage on schema bmo_private to service_role;

create table if not exists bmo_private.usage_reservations (
  request_id uuid primary key,
  user_id uuid references auth.users(id) on delete cascade,
  external_principal text,
  principal text not null,
  resource text not null check (resource in ('thinking','deep','aeon','image','tts','transcribe','search','scrape')),
  units bigint not null check (units > 0),
  weight integer not null check (weight in (0,1,5)),
  used_units bigint check (used_units >= 0 and used_units <= units),
  created_at timestamptz not null default clock_timestamp(),
  settled_at timestamptz,
  check ((user_id is not null and external_principal is null)
    or (user_id is null and external_principal ~ '^wa:[a-f0-9]{64}$')),
  check ((settled_at is null) = (used_units is null))
);
create index if not exists usage_reservations_principal_time
  on bmo_private.usage_reservations(principal, created_at);
create index if not exists usage_reservations_resource_time
  on bmo_private.usage_reservations(resource, created_at);
alter table bmo_private.usage_reservations enable row level security;
revoke all on bmo_private.usage_reservations from public, anon, authenticated;
grant all on bmo_private.usage_reservations to service_role;
alter table bmo_private.usage_reservations drop constraint if exists usage_reservations_identity;
alter table bmo_private.usage_reservations add constraint usage_reservations_identity check (
  (user_id is not null and external_principal is null)
  or (user_id is null and external_principal is not null and external_principal ~ '^wa:[a-f0-9]{64}$')
);

-- Anonymous aggregate spend survives account deletion without retaining a
-- user identifier, phone hash, request identifier or conversation content.
create table if not exists bmo_private.global_usage_days (
  resource text not null,
  budget_date date not null,
  units numeric not null check (units >= 0),
  primary key (resource, budget_date)
);
alter table bmo_private.global_usage_days enable row level security;
revoke all on bmo_private.global_usage_days from public, anon, authenticated;
grant all on bmo_private.global_usage_days to service_role;
insert into bmo_private.global_usage_days(resource, budget_date, units)
  select resource, (created_at at time zone 'UTC')::date, sum(coalesce(used_units, units))
    from bmo_private.usage_reservations group by resource, (created_at at time zone 'UTC')::date
  on conflict (resource, budget_date) do update
    set units = greatest(bmo_private.global_usage_days.units, excluded.units);

create or replace function public.bmo_reserve_usage(
  p_user_id uuid, p_external_principal text, p_request_id uuid,
  p_resource text, p_units bigint, p_global_limit bigint, p_daily_user_limit bigint
) returns jsonb language plpgsql security invoker
set search_path = pg_catalog, public, bmo_private
set lock_timeout = '3s'
as $$
declare
  subject text;
  moment timestamptz := clock_timestamp();
  weight_value integer;
  existing bmo_private.usage_reservations%rowtype;
  session_used numeric;
  week_used numeric;
  resource_used numeric;
  global_used numeric;
  budget_date_value date := (moment at time zone 'UTC')::date;
begin
  if p_request_id is null or p_units is null or p_units <= 0
    or p_units > 1000000000 or p_global_limit is null or p_global_limit <= 0
    or p_daily_user_limit is null or p_daily_user_limit <= 0
    or p_resource is null or p_resource not in ('thinking','deep','aeon','image','tts','transcribe','search','scrape')
    or not ((p_user_id is not null and p_external_principal is null)
      or (p_user_id is null and p_external_principal is not null and p_external_principal ~ '^wa:[a-f0-9]{64}$')) then
    raise invalid_parameter_value using message = 'Invalid admission parameters';
  end if;
  subject := case when p_user_id is not null then 'user:' || p_user_id::text else p_external_principal end;
  weight_value := case when p_resource in ('deep','image') then 5
    when p_resource in ('thinking','aeon') then 1 else 0 end;

  -- All mutators take the same lock order. The request lock also serializes
  -- accidental cross-principal idempotency-key collisions.
  perform pg_advisory_xact_lock(hashtextextended('bmo:request:' || p_request_id::text, 0));
  perform pg_advisory_xact_lock(hashtextextended('bmo:global:' || p_resource, 0));
  perform pg_advisory_xact_lock(hashtextextended('bmo:principal:' || subject, 0));
  select * into existing from bmo_private.usage_reservations where request_id = p_request_id;
  if found then
    if existing.principal <> subject or existing.resource <> p_resource or existing.units <> p_units then
      return jsonb_build_object('admitted', false, 'reason', 'request_conflict');
    end if;
    return jsonb_build_object('admitted', true, 'fresh', false, 'request_id', p_request_id, 'reserved_units', existing.units);
  end if;

  select
    coalesce(sum(greatest(tokens, 0)::numeric * case when model in ('deep','image') then 5 else 1 end)
      filter (where created_at >= moment - interval '5 hours'), 0),
    coalesce(sum(greatest(tokens, 0)::numeric * case when model in ('deep','image') then 5 else 1 end), 0)
    into session_used, week_used
    from public.usage_events where user_id = p_user_id and created_at >= moment - interval '7 days';
  -- An uncertain/crashed operation stays held until an operator reconciles it.
  -- Completed work naturally leaves each trailing window.
  select session_used + coalesce(sum(units::numeric * weight), 0),
         week_used + coalesce(sum(units::numeric * weight), 0)
    into session_used, week_used from bmo_private.usage_reservations
    where principal = subject and settled_at is null;
  -- External principals have no auth.users row or usage_events entry.
  if p_user_id is null then
    select session_used + coalesce(sum(used_units::numeric * weight) filter (where created_at >= moment - interval '5 hours'), 0),
           week_used + coalesce(sum(used_units::numeric * weight), 0)
      into session_used, week_used from bmo_private.usage_reservations
      where principal = subject and settled_at is not null and created_at >= moment - interval '7 days';
  end if;
  if weight_value > 0 and (session_used + p_units::numeric * weight_value > 100000
    or week_used + p_units::numeric * weight_value > 1000000) then
    return jsonb_build_object('admitted', false, 'reason', 'user_limit');
  end if;
  select coalesce(sum(coalesce(used_units, units)), 0) into resource_used
    from bmo_private.usage_reservations where principal = subject and resource = p_resource
      and (created_at >= moment - interval '24 hours' or settled_at is null);
  if resource_used + p_units > p_daily_user_limit then
    return jsonb_build_object('admitted', false, 'reason', 'resource_user_limit');
  end if;
  select coalesce((select units from bmo_private.global_usage_days
    where resource = p_resource and budget_date = budget_date_value), 0) into global_used;
  select global_used + coalesce(sum(units), 0) into global_used
    from bmo_private.usage_reservations where resource = p_resource and settled_at is null
      and created_at < date_trunc('day', moment at time zone 'UTC') at time zone 'UTC';
  if global_used + p_units > p_global_limit then
    return jsonb_build_object('admitted', false, 'reason', 'global_limit');
  end if;
  insert into bmo_private.usage_reservations(request_id, user_id, external_principal, principal, resource, units, weight, created_at)
    values (p_request_id, p_user_id, p_external_principal, subject, p_resource, p_units, weight_value, moment);
  insert into bmo_private.global_usage_days(resource, budget_date, units)
    values (p_resource, budget_date_value, p_units)
    on conflict (resource, budget_date) do update
      set units = bmo_private.global_usage_days.units + excluded.units;
  return jsonb_build_object('admitted', true, 'fresh', true, 'request_id', p_request_id, 'reserved_units', p_units);
end $$;

create or replace function public.bmo_settle_usage(
  p_user_id uuid, p_external_principal text, p_request_id uuid, p_used_units bigint
) returns void language plpgsql security invoker
set search_path = pg_catalog, public, bmo_private
set lock_timeout = '3s'
as $$
declare
  subject text;
  admission bmo_private.usage_reservations%rowtype;
begin
  if p_user_id is not null and p_external_principal is null then
    subject := 'user:' || p_user_id::text;
  elsif p_user_id is null and p_external_principal ~ '^wa:[a-f0-9]{64}$' then
    subject := p_external_principal;
  else raise invalid_parameter_value using message = 'Invalid admission identity'; end if;
  perform pg_advisory_xact_lock(hashtextextended('bmo:request:' || p_request_id::text, 0));
  select * into admission from bmo_private.usage_reservations where request_id = p_request_id;
  if not found or admission.principal <> subject or p_used_units is null
    or p_used_units < 0 or p_used_units > admission.units then
    raise invalid_parameter_value using message = 'Invalid settlement';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('bmo:global:' || admission.resource, 0));
  perform pg_advisory_xact_lock(hashtextextended('bmo:principal:' || subject, 0));
  if admission.settled_at is not null then
    if admission.used_units <> p_used_units then
      raise invalid_parameter_value using message = 'Settlement already finalized';
    end if;
    return;
  end if;
  if admission.user_id is not null and admission.weight > 0 then
    insert into public.usage_events(user_id, model, tokens, created_at)
      values (admission.user_id, admission.resource, p_used_units::integer, admission.created_at);
  end if;
  update bmo_private.usage_reservations set used_units = p_used_units, settled_at = clock_timestamp()
    where request_id = p_request_id;
  update bmo_private.global_usage_days as daily
    set units = daily.units - (admission.units - p_used_units)
    where resource = admission.resource and budget_date = (admission.created_at at time zone 'UTC')::date;
end $$;

create or replace function public.bmo_held_usage(p_user_id uuid)
returns jsonb language sql security invoker
set search_path = pg_catalog, public, bmo_private
as $$
  select coalesce(jsonb_agg(jsonb_build_object('model', resource, 'tokens', tokens,
    'created_at', clock_timestamp(), 'held', true)), '[]'::jsonb)
  from (select resource, sum(units) as tokens from bmo_private.usage_reservations
    where user_id = p_user_id and settled_at is null and weight > 0 group by resource) held;
$$;

revoke all on function public.bmo_reserve_usage(uuid,text,uuid,text,bigint,bigint,bigint) from public, anon, authenticated;
revoke all on function public.bmo_settle_usage(uuid,text,uuid,bigint) from public, anon, authenticated;
revoke all on function public.bmo_held_usage(uuid) from public, anon, authenticated;
grant execute on function public.bmo_reserve_usage(uuid,text,uuid,text,bigint,bigint,bigint) to service_role;
grant execute on function public.bmo_settle_usage(uuid,text,uuid,bigint) to service_role;
grant execute on function public.bmo_held_usage(uuid) to service_role;
commit;
