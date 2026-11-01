-- Run only in an isolated Postgres test DB, after 0009_customize.sql.
-- The harness supplies auth.users, auth.uid(), and an authenticated role.
begin;
insert into auth.users(id) values ('00000000-0000-0000-0000-000000000001'), ('00000000-0000-0000-0000-000000000002');
grant select, insert, update, delete on public.preferences, public.skills, public.skill_files, public.conversations to authenticated;
set local role authenticated;
set local "request.jwt.claim.sub" = '00000000-0000-0000-0000-000000000001';
insert into public.preferences(user_id,instructions) values (auth.uid(),'Private preference');
insert into public.skills(id,user_id,name,description,instructions) values ('10000000-0000-0000-0000-000000000001',auth.uid(),'review','Review code','Private instructions');
insert into public.skill_files(skill_id,user_id,filename,content,size_bytes) values ('10000000-0000-0000-0000-000000000001',auth.uid(),'reference.txt','Private reference',17);

set local "request.jwt.claim.sub" = '00000000-0000-0000-0000-000000000002';
do $$ declare affected integer; begin
  assert (select count(*) from public.skills) = 0, 'skills tenant read leaked';
  assert (select count(*) from public.skill_files) = 0, 'files tenant read leaked';
  assert (select count(*) from public.preferences) = 0, 'preferences tenant read leaked';
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
rollback;
