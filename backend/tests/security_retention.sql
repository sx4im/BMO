-- Disposable fixture database only. Never run this test in production.
begin;
set local role service_role;
insert into bmo_private.usage_reservations
 (request_id,external_principal,principal,resource,units,weight,created_at,used_units,settled_at)
values
 ('40000000-0000-0000-0000-000000000001','wa:'||repeat('a',64),'wa:'||repeat('a',64),'aeon',100,1,clock_timestamp()-interval '9 days',null,null),
 ('40000000-0000-0000-0000-000000000002','wa:'||repeat('a',64),'wa:'||repeat('a',64),'aeon',100,1,clock_timestamp()-interval '9 days',40,clock_timestamp()-interval '9 days'),
 ('40000000-0000-0000-0000-000000000003','wa:'||repeat('a',64),'wa:'||repeat('a',64),'aeon',100,1,clock_timestamp(),null,null);
insert into bmo_private.global_usage_days(resource,budget_date,units)
values ('aeon',(clock_timestamp()-interval '9 days')::date,140)
on conflict(resource,budget_date) do update set units=bmo_private.global_usage_days.units+140;

reset role;
set local role anon;
do $$ begin
  begin
    perform public.bmo_prune_external_usage();
    raise exception 'Anonymous client can delete accounting history';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
set local role authenticated;
do $$ begin
  begin
    perform public.bmo_prune_external_usage();
    raise exception 'Authenticated client can delete accounting history';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
set local role service_role;
do $$ declare result jsonb; previous_units numeric; begin
  select sum(units) into previous_units from bmo_private.global_usage_days;
  result := public.bmo_prune_external_usage();
  assert (result->>'purged')::integer=2, 'Old pseudonymous reservations remain';
  assert (result->>'conservatively_settled')::integer=1, 'Uncertain work was not charged at its full reservation';
  assert (select count(*) from bmo_private.usage_reservations where request_id in
   ('40000000-0000-0000-0000-000000000001','40000000-0000-0000-0000-000000000002'))=0;
  assert exists(select 1 from bmo_private.usage_reservations where request_id='40000000-0000-0000-0000-000000000003'), 'Retention deleted recent active allowance';
  assert (select sum(units) from bmo_private.global_usage_days)=previous_units, 'Retention refunded global spend';
  result := public.bmo_prune_external_usage();
  assert (result->>'purged')::integer=0, 'Retention is not idempotent';
end $$;
rollback;
