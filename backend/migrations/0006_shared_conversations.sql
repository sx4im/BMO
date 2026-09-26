-- Bimo · Shared conversations schema.
--
-- Enables users to create a public, read-only snapshot of any saved chat.
-- The snapshot stores a frozen copy of the conversation and messages at share
-- time so subsequent private turns are not inadvertently published.

create table if not exists public.shared_conversations (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  user_id         uuid not null references auth.users(id) on delete cascade,
  title           text not null,
  model           text,
  snapshot        jsonb not null default '[]'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (conversation_id)
);

create index if not exists shared_conversations_id_idx on public.shared_conversations(id);
create index if not exists shared_conversations_user_idx on public.shared_conversations(user_id);

alter table public.shared_conversations enable row level security;

-- Public read access: anyone with the share ID can view the snapshot.
drop policy if exists "shared_conversations read" on public.shared_conversations;
create policy "shared_conversations read"
  on public.shared_conversations for select
  using (true);

-- Owner write access: only the user who created the conversation can share/update/unshare it.
drop policy if exists "shared_conversations write" on public.shared_conversations;
create policy "shared_conversations write"
  on public.shared_conversations for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
