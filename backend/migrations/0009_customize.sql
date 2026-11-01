-- Customize: user instructions, text-only Agent Skills, and per-chat selections.
begin;

create table if not exists public.preferences (
  user_id uuid primary key references auth.users(id) on delete cascade,
  instructions text not null default '' check (char_length(instructions) <= 4000),
  updated_at timestamptz not null default now()
);

create table if not exists public.skills (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (
    char_length(name) <= 64 and name ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
  ),
  description text not null check (char_length(description) <= 1024 and char_length(btrim(description)) > 0),
  instructions text not null default '' check (char_length(instructions) <= 20000),
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, name),
  unique (id, user_id)
);

create table if not exists public.skill_files (
  id uuid primary key default gen_random_uuid(),
  skill_id uuid not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  filename text not null,
  content text not null,
  size_bytes integer not null check (size_bytes between 0 and 65536),
  foreign key (skill_id, user_id) references public.skills(id, user_id) on delete cascade,
  unique (skill_id, filename)
);
create index if not exists skills_user_idx on public.skills (user_id, name);
create index if not exists skill_files_user_skill_idx on public.skill_files (user_id, skill_id);

alter table public.conversations add column if not exists active_skills uuid[] not null default '{}';
-- A small immutable label snapshot keeps historical message chips after edits/deletion.
alter table public.messages add column if not exists skills jsonb not null default '[]'::jsonb;

-- Also protect direct authenticated PostgREST writes, not only gateway calls.
create or replace function public.validate_active_skills() returns trigger
language plpgsql set search_path = public as $$
begin
  if cardinality(new.active_skills) > 3
     or cardinality(new.active_skills) <> (
       select count(distinct s.id) from public.skills s
       where s.id = any(new.active_skills) and s.user_id = new.user_id and s.enabled
     ) then
    raise exception 'active_skills must contain at most 3 distinct enabled skills owned by this user'
      using errcode = '23514';
  end if;
  return new;
end;
$$;
drop trigger if exists conversations_validate_active_skills on public.conversations;
create trigger conversations_validate_active_skills
before insert or update of active_skills, user_id on public.conversations
for each row execute function public.validate_active_skills();

alter table public.preferences enable row level security;
alter table public.skills enable row level security;
alter table public.skill_files enable row level security;

drop policy if exists "preferences owner" on public.preferences;
create policy "preferences owner" on public.preferences for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "skills owner" on public.skills;
create policy "skills owner" on public.skills for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "skill_files owner" on public.skill_files;
create policy "skill_files owner" on public.skill_files for all
  using (auth.uid() = user_id) with check (
    auth.uid() = user_id and exists (
      select 1 from public.skills s where s.id = skill_id and s.user_id = auth.uid()
    )
  );
commit;
