-- J3 Film Room — cloud library + marks
-- Run once in the Supabase SQL editor (file: filmroom/schema.sql) (project vlcpgwxeybpzwidjackz). Safe to run more than once.
-- Follows the same convention as the rest of j3hoops: anon-all policies behind the site PIN gate.

create table if not exists public.film_clips(
  id uuid primary key default gen_random_uuid(),
  title text not null,
  game text,
  storage_path text not null,
  public_url text not null,
  thumb_url text,
  duration_s real,
  width int,
  height int,
  fps real,
  notes text,
  court jsonb,   -- {pts:[[nx,ny]x4], mirror}: paint-corner calibration for the top view
  created_at timestamptz default now());

create table if not exists public.film_marks(
  id uuid primary key default gen_random_uuid(),
  clip_id uuid references public.film_clips(id) on delete cascade,
  t_ms int not null,
  label text,
  payload jsonb not null default '{}'::jsonb,   -- {objects:[...], loop:{a,b}}
  created_at timestamptz default now());

alter table public.film_clips add column if not exists court jsonb;

create index if not exists film_marks_clip_idx on public.film_marks(clip_id, t_ms);

do $$ declare t text;
begin
  foreach t in array array['film_clips','film_marks']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "anon all" on public.%I', t);
    execute format('create policy "anon all" on public.%I for all using (true) with check (true)', t);
    begin execute format('alter publication supabase_realtime add table public.%I', t);
    exception when duplicate_object then null; end;
  end loop;
end $$;

-- Storage bucket for the video files (public read so <video> can stream it; CORS is on by default).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('film', 'film', true, 2147483648, array['video/mp4','video/quicktime','video/x-m4v','video/webm','image/jpeg'])
on conflict (id) do update set public = excluded.public, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "film anon read"   on storage.objects;
drop policy if exists "film anon write"  on storage.objects;
drop policy if exists "film anon update" on storage.objects;
drop policy if exists "film anon delete" on storage.objects;
create policy "film anon read"   on storage.objects for select using (bucket_id = 'film');
create policy "film anon write"  on storage.objects for insert with check (bucket_id = 'film');
create policy "film anon update" on storage.objects for update using (bucket_id = 'film');
create policy "film anon delete" on storage.objects for delete using (bucket_id = 'film');
