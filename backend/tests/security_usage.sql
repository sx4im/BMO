-- Disposable fixture database only. Production must never run this file.
begin;
insert into auth.users(id) values
 ('10000000-0000-0000-0000-000000000001'),
 ('10000000-0000-0000-0000-000000000002');
-- Model pre-migration corrupt rows. This DDL and all fixtures roll back.
alter table public.usage_events drop constraint usage_events_tokens_nonnegative;
insert into public.usage_events(user_id, model, tokens) values
 ('10000000-0000-0000-0000-000000000002', 'thinking', 100000),
 ('10000000-0000-0000-0000-000000000002', 'thinking', -100000);

set local role anon;
do $$ begin
  begin
    perform public.bmo_reserve_usage('10000000-0000-0000-0000-000000000001', null,
      '20000000-0000-0000-0000-000000000001', 'thinking', 90000, 1000000, 1000000);
    raise exception 'Anonymous callers can reserve paid work';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
set local role authenticated;
do $$ begin
  begin
    perform public.bmo_reserve_usage('10000000-0000-0000-0000-000000000001', null,
      '20000000-0000-0000-0000-000000000001', 'thinking', 90000, 1000000, 1000000);
    raise exception 'Authenticated clients can reserve paid work';
  exception when insufficient_privilege then null; end;
  begin
    perform public.bmo_settle_usage('10000000-0000-0000-0000-000000000001', null,
      '20000000-0000-0000-0000-000000000001', 0);
    raise exception 'Authenticated clients can refund paid work';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
set local role service_role;
do $$ declare result jsonb; begin
  result := public.bmo_reserve_usage('10000000-0000-0000-0000-000000000002', null,
    '20000000-0000-0000-0000-000000000099', 'thinking', 1, 1000000, 1000000);
  assert result->>'reason' = 'user_limit', 'Historical negative rows replenish allowance';
  result := public.bmo_reserve_usage('10000000-0000-0000-0000-000000000001', null,
    '20000000-0000-0000-0000-000000000001', 'thinking', 90000, 1000000, 1000000);
  assert (result->>'admitted')::boolean, 'Initial reservation denied';
  assert (result->>'fresh')::boolean, 'New reservation not fresh';
  assert (public.bmo_held_usage('10000000-0000-0000-0000-000000000001')->0->>'tokens')::bigint = 90000;
  result := public.bmo_reserve_usage('10000000-0000-0000-0000-000000000001', null,
    '20000000-0000-0000-0000-000000000002', 'thinking', 10001, 1000000, 1000000);
  assert result->>'reason' = 'user_limit', 'Outstanding work does not consume quota';
  result := public.bmo_reserve_usage('10000000-0000-0000-0000-000000000001', null,
    '20000000-0000-0000-0000-000000000001', 'thinking', 90000, 1000000, 1000000);
  assert (result->>'admitted')::boolean and not (result->>'fresh')::boolean, 'Idempotency broken';
  result := public.bmo_reserve_usage('10000000-0000-0000-0000-000000000002', null,
    '20000000-0000-0000-0000-000000000001', 'thinking', 90000, 1000000, 1000000);
  assert result->>'reason' = 'request_conflict', 'Another identity can reuse an admission';
  perform public.bmo_settle_usage('10000000-0000-0000-0000-000000000001', null,
    '20000000-0000-0000-0000-000000000001', 100);
  perform public.bmo_settle_usage('10000000-0000-0000-0000-000000000001', null,
    '20000000-0000-0000-0000-000000000001', 100);
  assert (select count(*) from public.usage_events where user_id='10000000-0000-0000-0000-000000000001') = 1,
    'Settlement double-counted usage';
  assert (select tokens from public.usage_events where user_id='10000000-0000-0000-0000-000000000001') = 100;
  begin
    perform public.bmo_settle_usage('10000000-0000-0000-0000-000000000001', null,
      '20000000-0000-0000-0000-000000000001', 0);
    raise exception 'Settled usage can be rewritten';
  exception when invalid_parameter_value then null; end;
  result := public.bmo_reserve_usage('10000000-0000-0000-0000-000000000001', null,
    '20000000-0000-0000-0000-000000000003', 'deep', 19981, 1000000, 1000000);
  assert result->>'reason' = 'user_limit', 'Deep weighting not enforced';
  result := public.bmo_reserve_usage('10000000-0000-0000-0000-000000000001', null,
    '20000000-0000-0000-0000-000000000004', 'tts', 4000, 10000, 5000);
  assert (result->>'admitted')::boolean;
  result := public.bmo_reserve_usage('10000000-0000-0000-0000-000000000001', null,
    '20000000-0000-0000-0000-000000000005', 'tts', 1001, 10000, 5000);
  assert result->>'reason' = 'resource_user_limit';
  result := public.bmo_reserve_usage('10000000-0000-0000-0000-000000000002', null,
    '20000000-0000-0000-0000-000000000006', 'tts', 6001, 10000, 10000);
  assert result->>'reason' = 'global_limit';
end $$;
reset role;
-- Account deletion may remove personal metadata but must not replenish the
-- global provider allowance already admitted that day.
delete from auth.users where id='10000000-0000-0000-0000-000000000001';
set local role service_role;
do $$ declare result jsonb; begin
  result := public.bmo_reserve_usage('10000000-0000-0000-0000-000000000002', null,
    '20000000-0000-0000-0000-000000000010', 'tts', 6001, 10000, 10000);
  assert result->>'reason' = 'global_limit', 'Account deletion replenishes the global allowance';
end $$;
reset role;
rollback;
