begin;
drop trigger if exists conversations_validate_active_skills on public.conversations;
drop function if exists public.validate_active_skills();
alter table public.messages drop column if exists skills;
alter table public.conversations drop column if exists active_skills;
drop table if exists public.skill_files;
drop table if exists public.skills;
drop table if exists public.preferences;
commit;
