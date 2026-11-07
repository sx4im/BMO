#!/bin/sh
# Disposable networkless bimo_security fixture ONLY. Never run in production.
set -eu
if [ "$(psql -XAtqc 'select current_database()')" != "bimo_security" ]; then
  echo 'Refusing concurrency fixtures outside the isolated bimo_security database.' >&2
  exit 1
fi
work=$(mktemp -d)
user_a=77700000-0000-0000-0000-000000000001
user_b=77700000-0000-0000-0000-000000000002
cleanup() {
  psql -Xq -v ON_ERROR_STOP=1 -c "delete from auth.users where id in ('$user_a','$user_b');" >/dev/null
  rm -rf "$work"
}
trap cleanup EXIT HUP INT TERM

seed() {
  psql -Xq -v ON_ERROR_STOP=1 -c "insert into auth.users(id) values ('$user_a'),('$user_b') on conflict do nothing;" >/dev/null
}
baseline() {
  psql -XAtq -v ON_ERROR_STOP=1 -c "select coalesce(sum(units),0)::bigint from bmo_private.global_usage_days where resource='$1' and budget_date=(clock_timestamp() at time zone 'UTC')::date;"
}
group() {
  count=$1 resource=$2 units=$3 global_cap=$4 expected=$5 both=$6
  rm -f "$work"/*.out
  pids=''
  i=1
  while [ "$i" -le "$count" ]; do
    owner=$user_a
    if [ "$both" = yes ] && [ $((i % 2)) -eq 0 ]; then owner=$user_b; fi
    psql -XAtq -v ON_ERROR_STOP=1 -c "set role service_role; select public.bmo_reserve_usage('$owner',null,gen_random_uuid(),'$resource',$units,$global_cap,1000000)->>'admitted';" >"$work/$i.out" &
    pids="$pids $!"
    i=$((i+1))
  done
  failed=0
  for process in $pids; do wait "$process" || failed=1; done
  [ "$failed" -eq 0 ]
  accepted=$(grep -h '^true$' "$work"/*.out | wc -l | tr -d ' ')
  denied=$(grep -h '^false$' "$work"/*.out | wc -l | tr -d ' ')
  [ "$accepted" -eq "$expected" ] && [ "$denied" -eq $((count-expected)) ]
  echo "Concurrent $resource/$units: admitted=$accepted denied=$denied"
}

seed
previous=$(baseline scrape)
group 10 scrape 1 $((previous+5)) 5 yes
psql -Xq -v ON_ERROR_STOP=1 -c "delete from auth.users where id in ('$user_a','$user_b');" >/dev/null
[ "$(baseline scrape)" -eq $((previous+5)) ]
echo 'Account deletion preserved anonymous global spend.'

seed
previous=$(baseline thinking)
group 12 thinking 10000 $((previous+1000000)) 10 no
psql -Xq -v ON_ERROR_STOP=1 -c "delete from auth.users where id='$user_a';" >/dev/null

seed
psql -Xq -v ON_ERROR_STOP=1 -c "insert into public.usage_events(user_id,model,tokens,created_at) values ('$user_a','thinking',999999,clock_timestamp()-interval '1 day');" >/dev/null
previous=$(baseline thinking)
group 2 thinking 1 $((previous+1000000)) 1 no
