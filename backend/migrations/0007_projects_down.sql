-- Bimo · Projects schema rollback (down migration).
--
-- Reverts tables, columns, indexes, and RLS policies introduced in 0007_projects.sql.

drop policy if exists "project_files write" on public.project_files;
drop policy if exists "project_files read" on public.project_files;
drop policy if exists "projects write" on public.projects;
drop policy if exists "projects read" on public.projects;

drop index if exists public.conversations_user_project_idx;
drop index if exists public.conversations_project_idx;

alter table public.conversations
  drop column if exists project_id;

drop table if exists public.project_files cascade;
drop table if exists public.projects cascade;
