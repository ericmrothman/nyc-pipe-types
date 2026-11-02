-- NYC Pipe Atlas: Supabase schema, row-level security and storage.
-- Run once in the Supabase SQL editor, then fill in docs/config.js.
--
-- Trust model: anyone with the public anon key can read everything, add pipes, add field notes
-- and appreciate pipes. Nobody can edit rows. A contributor can delete only their own pipe, by
-- sending the secret their browser generated at upload time in an `x-pipe-secret` header; the
-- database stores only its SHA-256 hash, and anon cannot even read the hash column.

create extension if not exists pgcrypto with schema extensions;

-- ---------- pipes ----------
create table if not exists public.pipes (
  id uuid primary key default gen_random_uuid(),
  lat double precision not null check (lat between 40.48 and 40.93),
  lng double precision not null check (lng between -74.27 and -73.68),
  photo_url text not null check (photo_url ~ '^https://' and char_length(photo_url) <= 500),
  model_url text check (model_url is null or (model_url ~ '^https://' and char_length(model_url) <= 500)), -- optional 3D scan (.glb)
  primary_type text not null check (primary_type in ('standpipe','oil','air','box','steam','mystery','other')),
  all_types text[] not null check (
    cardinality(all_types) between 1 and 7
    and all_types <@ array['standpipe','oil','air','box','steam','mystery','other']::text[]
  ),
  counts jsonb not null default '{}'::jsonb check (jsonb_typeof(counts) = 'object'),
  custom_tag text check (char_length(custom_tag) <= 40),
  author text not null default '' check (char_length(author) <= 40),
  note text not null default '' check (char_length(note) <= 2000),
  has_exif boolean not null default false,
  -- A pin placed by hand (no GPS in the photo) is always flagged; the client cannot opt out.
  needs_review boolean generated always as (not has_exif) stored,
  owner_secret_hash text not null check (owner_secret_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now()
);

alter table public.pipes enable row level security;

revoke all on public.pipes from anon, authenticated;
grant select (id, lat, lng, photo_url, model_url, primary_type, all_types, counts, custom_tag, author, note, has_exif, needs_review, created_at)
  on public.pipes to anon, authenticated;
grant insert (id, lat, lng, photo_url, model_url, primary_type, all_types, counts, custom_tag, author, note, has_exif, owner_secret_hash)
  on public.pipes to anon, authenticated;
grant delete on public.pipes to anon, authenticated;

drop policy if exists "pipes are public" on public.pipes;
create policy "pipes are public" on public.pipes for select to anon, authenticated using (true);

drop policy if exists "anyone can add a pipe" on public.pipes;
create policy "anyone can add a pipe" on public.pipes for insert to anon, authenticated with check (true);

drop policy if exists "owners delete their own pipe" on public.pipes;
create policy "owners delete their own pipe" on public.pipes for delete to anon, authenticated using (
  owner_secret_hash = encode(
    extensions.digest(coalesce(current_setting('request.headers', true)::json ->> 'x-pipe-secret', ''), 'sha256'),
    'hex')
);

-- ---------- appreciations (one counter per pipe, seed pipes included) ----------
create table if not exists public.appreciations (
  pipe_id text primary key check (char_length(pipe_id) <= 64),
  count bigint not null default 0 check (count >= 0)
);
alter table public.appreciations enable row level security;
revoke all on public.appreciations from anon, authenticated;
grant select on public.appreciations to anon, authenticated;
drop policy if exists "appreciation is public" on public.appreciations;
create policy "appreciation is public" on public.appreciations for select to anon, authenticated using (true);

-- The client batches claps (~600ms) and sends the delta. Atomic, clamped, and only for real pipes.
create or replace function public.appreciate(p_pipe_id text, p_delta integer)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  new_count bigint;
begin
  if p_pipe_id !~ '^pipe_[0-9]{3}$'
     and not exists (select 1 from public.pipes where id::text = p_pipe_id) then
    raise exception 'unknown pipe %', p_pipe_id;
  end if;
  insert into public.appreciations as a (pipe_id, count)
  values (p_pipe_id, greatest(1, least(coalesce(p_delta, 1), 200)))
  on conflict (pipe_id) do update set count = a.count + excluded.count
  returning a.count into new_count;
  return new_count;
end;
$$;
revoke all on function public.appreciate(text, integer) from public;
grant execute on function public.appreciate(text, integer) to anon, authenticated;

-- ---------- field notes & crowd ID ----------
create table if not exists public.field_notes (
  id uuid primary key default gen_random_uuid(),
  pipe_id text not null check (char_length(pipe_id) <= 64),
  author text not null default '' check (char_length(author) <= 40),
  suggested_type text check (suggested_type in ('standpipe','oil','air','box','steam','mystery','other')),
  body text not null default '' check (char_length(body) <= 2000),
  created_at timestamptz not null default now(),
  check (suggested_type is not null or char_length(body) > 0)
);
create index if not exists field_notes_pipe_idx on public.field_notes (pipe_id, created_at);
alter table public.field_notes enable row level security;
revoke all on public.field_notes from anon, authenticated;
grant select on public.field_notes to anon, authenticated;
grant insert (id, pipe_id, author, suggested_type, body) on public.field_notes to anon, authenticated;
drop policy if exists "notes are public" on public.field_notes;
create policy "notes are public" on public.field_notes for select to anon, authenticated using (true);
drop policy if exists "anyone can add a note" on public.field_notes;
create policy "anyone can add a note" on public.field_notes for insert to anon, authenticated with check (true);

-- When a pipe is deleted, its notes and claps go with it.
create or replace function public.cleanup_deleted_pipe() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  delete from public.field_notes where pipe_id = old.id::text;
  delete from public.appreciations where pipe_id = old.id::text;
  return old;
end;
$$;
drop trigger if exists pipes_cleanup on public.pipes;
create trigger pipes_cleanup after delete on public.pipes for each row execute function public.cleanup_deleted_pipe();

-- ---------- photo storage ----------
-- Photos arrive already re-encoded in the browser (<= 1000px JPEG, all EXIF stripped).
-- 3D scans (.glb, up to 25MB) are stored as uploaded, next to their photo: {id}.jpg and {id}.glb.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('pipe-photos', 'pipe-photos', true, 26214400, array['image/jpeg', 'model/gltf-binary'])
on conflict (id) do update set public = true, file_size_limit = 26214400, allowed_mime_types = array['image/jpeg', 'model/gltf-binary'];

drop policy if exists "anyone can upload a pipe photo" on storage.objects;
create policy "anyone can upload a pipe photo" on storage.objects for insert to anon, authenticated
  with check (bucket_id = 'pipe-photos' and name ~ '^[0-9a-f-]{36}\.(jpg|glb)$');
