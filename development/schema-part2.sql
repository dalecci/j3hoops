-- Jaguars Player Development — Part 2
-- Adds: parent access codes, coach messages, parent replies.
-- Safe to run more than once.

create table if not exists public.pd_access(
  id uuid primary key default gen_random_uuid(),
  player_id uuid references public.tryout_players(id) on delete cascade,
  code text unique not null,
  created_at timestamptz default now(),
  revoked_at timestamptz);

create table if not exists public.pd_comments(
  id uuid primary key default gen_random_uuid(),
  scope text not null default 'player',
  scope_value text,
  author_name text,
  body text not null,
  pinned boolean default false,
  created_at timestamptz default now());

create table if not exists public.pd_replies(
  id uuid primary key default gen_random_uuid(),
  comment_id uuid references public.pd_comments(id) on delete cascade,
  player_id uuid references public.tryout_players(id) on delete cascade,
  author_name text,
  body text not null,
  created_at timestamptz default now());

do $$ declare t text;
begin
  foreach t in array array['pd_access','pd_comments','pd_replies']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "anon all" on public.%I', t);
    execute format('create policy "anon all" on public.%I for all using (true) with check (true)', t);
    begin execute format('alter publication supabase_realtime add table public.%I', t);
    exception when duplicate_object then null; end;
  end loop;
end $$;
