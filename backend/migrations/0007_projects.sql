-- Bimo · Projects and Project Files schema.
--
-- Adds project workspaces with custom instructions and reference knowledge
-- files, modeled on Claude Projects. Existing conversations remain compatible
-- with project_id = NULL.

-- ---------- Projects ----------
create table if not exists public.projects (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  name         text not null,
  description  text not null default '',
  instructions text not null default '',
  archived     boolean not null default false,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists projects_user_idx
  on public.projects (user_id, updated_at desc);

-- ---------- Project Files (Knowledge) ----------
create table if not exists public.project_files (
  id             uuid primary key default gen_random_uuid(),
  project_id     uuid not null references public.projects(id) on delete cascade,
  user_id        uuid not null references auth.users(id) on delete cascade,
  filename       text not null,
  mime_type      text not null,
  size_bytes     bigint not null,
  storage_path   text not null,
  extracted_text text not null default '',
  token_estimate integer not null default 0,
  created_at     timestamptz not null default now()
);

create index if not exists project_files_project_idx
  on public.project_files (project_id, created_at);

create index if not exists project_files_user_idx
  on public.project_files (user_id);

-- ---------- Conversations Reference ----------
alter table public.conversations
  add column if not exists project_id uuid references public.projects(id) on delete set null;

create index if not exists conversations_project_idx
  on public.conversations (project_id);

create index if not exists conversations_user_project_idx
  on public.conversations (user_id, project_id);

-- ---------- Row Level Security ----------
alter table public.projects enable row level security;
alter table public.project_files enable row level security;

-- Projects: owner only
drop policy if exists "projects read" on public.projects;
drop policy if exists "projects write" on public.projects;
create policy "projects read"
  on public.projects for select
  using (auth.uid() = user_id);
create policy "projects write"
  on public.projects for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Project files: owner only
drop policy if exists "project_files read" on public.project_files;
drop policy if exists "project_files write" on public.project_files;
create policy "project_files read"
  on public.project_files for select
  using (auth.uid() = user_id);
create policy "project_files write"
  on public.project_files for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
