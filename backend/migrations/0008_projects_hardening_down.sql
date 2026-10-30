-- Bimo · Projects hardening schema rollback (down migration).
--
-- Reverts triggers, check constraints, and conversation project ownership policy
-- introduced in 0008_projects_hardening.sql.

-- 1. Revert conversations write RLS policy to original owner-only check
drop policy if exists "conversations write" on public.conversations;
create policy "conversations write" on public.conversations for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- 2. Drop conversation project ownership trigger and function
drop trigger if exists check_conversation_project_ownership_trigger on public.conversations;
drop function if exists public.check_conversation_project_ownership();

-- 3. Drop projects name length constraint
alter table public.projects
  drop constraint if exists projects_name_length_check;

-- 4. Drop projects updated_at trigger and function
drop trigger if exists projects_set_updated_at on public.projects;
drop function if exists public.set_updated_at();
