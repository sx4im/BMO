-- Each row opts one account into a Markdown skill shipped with Bmo.
begin;

create table if not exists public.enabled_builtin_skills (
  user_id uuid not null references auth.users(id) on delete cascade,
  skill_id uuid not null,
  primary key (user_id, skill_id)
);

alter table public.enabled_builtin_skills enable row level security;
revoke all on public.enabled_builtin_skills from anon, authenticated;
grant select, insert, update, delete on public.enabled_builtin_skills to service_role;
drop policy if exists "enabled built-in skill owner" on public.enabled_builtin_skills;
create policy "enabled built-in skill owner" on public.enabled_builtin_skills for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

commit;
