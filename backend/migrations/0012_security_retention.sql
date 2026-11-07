-- Retire keyed WhatsApp identities after all allowance windows have elapsed.
-- Anonymous global spend is retained. Unknown work is charged in full first.
begin;
create or replace function public.bmo_prune_external_usage()
returns jsonb language plpgsql security invoker
set search_path = pg_catalog, public, bmo_private
set lock_timeout = '3s'
as $$
declare settled_count bigint; purged_count bigint;
begin
  update bmo_private.usage_reservations
    set used_units=units, settled_at=clock_timestamp()
    where external_principal is not null and settled_at is null
      and created_at < clock_timestamp()-interval '8 days';
  get diagnostics settled_count = row_count;
  delete from bmo_private.usage_reservations
    where external_principal is not null and settled_at is not null
      and created_at < clock_timestamp()-interval '8 days';
  get diagnostics purged_count = row_count;
  return jsonb_build_object('conservatively_settled',settled_count,'purged',purged_count);
end $$;
revoke all on function public.bmo_prune_external_usage() from public,anon,authenticated;
grant execute on function public.bmo_prune_external_usage() to service_role;
commit;
