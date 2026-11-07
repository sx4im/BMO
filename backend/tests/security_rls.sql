-- Run only against the isolated fixture DB after the forward migrations.
begin;
insert into auth.users(id) values
  ('00000000-0000-0000-0000-000000000001'),
  ('00000000-0000-0000-0000-000000000002');
insert into public.conversations(id,user_id,title) values
  ('10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001','Private chat');
insert into public.shared_conversations(conversation_id,user_id,title,snapshot) values
  ('10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001','Published snapshot','[{"content":"Shared only by link"}]');
insert into public.usage_events(user_id,model,tokens) values
  ('00000000-0000-0000-0000-000000000001','thinking',100),
  ('00000000-0000-0000-0000-000000000002','thinking',200);

set local role anon;
do $$ begin
  begin
    perform snapshot from public.shared_conversations;
    raise exception 'Anonymous callers can enumerate share snapshots';
  exception when insufficient_privilege then null; end;
  begin
    truncate public.usage_events;
    raise exception 'Anonymous callers can truncate usage';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

set local role authenticated;
set local "request.jwt.claim.sub" = '00000000-0000-0000-0000-000000000001';
do $$ begin
  assert (select count(*) from public.usage_events) = 1, 'Usage SELECT leaked another user';
  assert (select tokens from public.usage_events) = 100, 'Owner cannot read usage';
  begin
    perform snapshot from public.shared_conversations;
    raise exception 'Authenticated callers can enumerate share snapshots';
  exception when insufficient_privilege then null; end;
  begin
    insert into public.usage_events(user_id,model,tokens) values (auth.uid(),'thinking',-100000);
    raise exception 'Client can insert usage';
  exception when insufficient_privilege then null; end;
  begin
    update public.usage_events set tokens=0 where user_id=auth.uid();
    raise exception 'Client can rewrite usage';
  exception when insufficient_privilege then null; end;
  begin
    delete from public.usage_events where user_id=auth.uid();
    raise exception 'Client can erase usage';
  exception when insufficient_privilege then null; end;
  begin
    truncate public.usage_events;
    raise exception 'Client can truncate usage';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

set local role service_role;
do $$ begin
  assert (select count(*) from public.shared_conversations) = 1, 'Gateway cannot read shares';
  insert into public.usage_events(user_id,model,tokens) values
    ('00000000-0000-0000-0000-000000000001','thinking',50);
  begin
    insert into public.usage_events(user_id,model,tokens) values
      ('00000000-0000-0000-0000-000000000001','thinking',-1);
    raise exception 'Negative usage accepted';
  exception when check_violation then null; end;
end $$;
reset role;
rollback;
