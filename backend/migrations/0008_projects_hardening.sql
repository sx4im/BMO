-- Bimo · Projects hardening schema.
--
-- 1. Enforces automatic updated_at maintenance via trigger on projects.
-- 2. Adds CHECK constraints on project name (non-blank, max 100 chars).
-- 3. Enforces that conversation project_id references a project owned by the conversation owner
--    via both a BEFORE INSERT/UPDATE trigger and an RLS write policy check.

-- ---------- 1. Projects updated_at trigger ----------
create or replace function public.set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists projects_set_updated_at on public.projects;
create trigger projects_set_updated_at
  before update on public.projects
  for each row
  execute function public.set_updated_at();

-- ---------- 2. Projects name CHECK constraint ----------
alter table public.projects
  drop constraint if exists projects_name_length_check;

alter table public.projects
  add constraint projects_name_length_check
  check (length(trim(name)) > 0 and length(name) <= 100);

-- ---------- 3. Conversation project ownership verification ----------
create or replace function public.check_conversation_project_ownership()
returns trigger as $$
begin
  if new.project_id is not null then
    if not exists (
      select 1 from public.projects
      where id = new.project_id and user_id = new.user_id
    ) then
      raise exception 'project_id % does not belong to user %', new.project_id, new.user_id
        using errcode = '23503';
    end if;
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists check_conversation_project_ownership_trigger on public.conversations;
create trigger check_conversation_project_ownership_trigger
  before insert or update of project_id, user_id on public.conversations
  for each row
  execute function public.check_conversation_project_ownership();

-- Update conversations write RLS policy to also ensure project_id ownership
drop policy if exists "conversations write" on public.conversations;
create policy "conversations write" on public.conversations for all
  using (auth.uid() = user_id)
  with check (
    auth.uid() = user_id
    and (
      project_id is null
      or exists (
        select 1 from public.projects p
        where p.id = project_id and p.user_id = auth.uid()
      )
    )
  );
