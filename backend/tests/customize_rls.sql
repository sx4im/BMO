-- Run only in an isolated Postgres test DB, after migrations 0009 and 0010.
-- The harness supplies auth.users, auth.uid(), and the Supabase roles.
begin;
insert into auth.users(id) values ('00000000-0000-0000-0000-000000000001'), ('00000000-0000-0000-0000-000000000002');
grant select, insert, update, delete on public.preferences, public.skills, public.skill_files, public.conversations to authenticated;
do $$ begin
  assert not has_table_privilege('authenticated', 'public.enabled_builtin_skills', 'INSERT'), 'direct opt-in write allowed';
  assert not has_table_privilege('anon', 'public.enabled_builtin_skills', 'SELECT'), 'anonymous opt-in read allowed';
  assert has_table_privilege('service_role', 'public.enabled_builtin_skills', 'INSERT'), 'gateway cannot write opt-ins';
end $$;
-- Exercise the owner policy even if another grant is added in the future.
grant select, insert, update, delete on public.enabled_builtin_skills to authenticated;
set local role authenticated;
set local "request.jwt.claim.sub" = '00000000-0000-0000-0000-000000000001';
insert into public.preferences(user_id,instructions) values (auth.uid(),'Private preference');
insert into public.enabled_builtin_skills (user_id, skill_id) values (auth.uid(),'30000000-0000-0000-0000-000000000001');
insert into public.enabled_builtin_skills (user_id, skill_id) values (auth.uid(),'30000000-0000-0000-0000-000000000001')
  on conflict (user_id, skill_id) do nothing;
insert into public.skills(id,user_id,name,description,instructions) values ('10000000-0000-0000-0000-000000000001',auth.uid(),'review','Review code','Private instructions');
insert into public.skill_files(skill_id,user_id,filename,content,size_bytes) values ('10000000-0000-0000-0000-000000000001',auth.uid(),'reference.txt','Private reference',17);

set local "request.jwt.claim.sub" = '00000000-0000-0000-0000-000000000002';
do $$ declare affected integer; begin
  assert (select count(*) from public.skills) = 0, 'skills tenant read leaked';
  assert (select count(*) from public.skill_files) = 0, 'files tenant read leaked';
  assert (select count(*) from public.preferences) = 0, 'preferences tenant read leaked';
  assert (select count(*) from public.enabled_builtin_skills) = 0, 'built-in opt-in tenant read leaked';
  delete from public.enabled_builtin_skills;
  get diagnostics affected = row_count;
  assert affected = 0, 'cross-tenant built-in opt-out';
  begin
    insert into public.enabled_builtin_skills (user_id, skill_id)
      values ('00000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000002');
    raise exception 'cross-tenant built-in opt-in accepted';
  exception when insufficient_privilege then null; end;
  update public.skills set instructions='stolen' where id='10000000-0000-0000-0000-000000000001';
  get diagnostics affected = row_count;
  assert affected = 0, 'cross-tenant skill update';
  delete from public.skills where id='10000000-0000-0000-0000-000000000001';
  get diagnostics affected = row_count;
  assert affected = 0, 'cross-tenant skill delete';
  update public.preferences set instructions='stolen';
  get diagnostics affected = row_count;
  assert affected = 0, 'cross-tenant preferences update';
  begin
    insert into public.skill_files(skill_id,user_id,filename,content,size_bytes) values ('10000000-0000-0000-0000-000000000001',auth.uid(),'stolen.txt','stolen',6);
    raise exception 'cross-tenant file insert accepted';
  exception when insufficient_privilege or foreign_key_violation then null; end;
  begin
    insert into public.conversations(user_id,active_skills) values (auth.uid(),array['10000000-0000-0000-0000-000000000001']::uuid[]);
    raise exception 'foreign skill invocation accepted';
  exception when check_violation then null; end;
end $$;

-- Same names are allowed for separate users; duplicates for one user are not.
insert into public.skills(id,user_id,name,description) values ('20000000-0000-0000-0000-000000000001',auth.uid(),'review','Review code');
insert into public.conversations(user_id,active_skills) values (auth.uid(),array['20000000-0000-0000-0000-000000000001']::uuid[]);
do $$ begin
  begin
    insert into public.skills(user_id,name,description) values (auth.uid(),'review','duplicate');
    raise exception 'duplicate skill accepted';
  exception when unique_violation then null; end;
  begin
    insert into public.conversations(user_id,active_skills) values (auth.uid(),array_fill('20000000-0000-0000-0000-000000000001'::uuid,array[4]));
    raise exception 'over-limit skill invocation accepted';
  exception when check_violation then null; end;
  begin
    insert into public.conversations(user_id,active_skills) values (auth.uid(),array_fill('20000000-0000-0000-0000-000000000001'::uuid,array[2]));
    raise exception 'duplicate skill invocation accepted';
  exception when check_violation then null; end;
end $$;
update public.skills set enabled=false where user_id=auth.uid();
do $$ begin
  begin
    insert into public.conversations(user_id,active_skills) values (auth.uid(),array['20000000-0000-0000-0000-000000000001']::uuid[]);
    raise exception 'disabled skill invocation accepted';
  exception when check_violation then null; end;
end $$;

-- Both accounts can independently enable the same catalog entry.
insert into public.enabled_builtin_skills (user_id, skill_id) values (auth.uid(),'30000000-0000-0000-0000-000000000001');
delete from public.enabled_builtin_skills where skill_id = '30000000-0000-0000-0000-000000000001';
set local "request.jwt.claim.sub" = '00000000-0000-0000-0000-000000000001';
do $$ begin
  assert (select count(*) from public.enabled_builtin_skills) = 1, 'other account removed opt-in';
end $$;
rollback;
