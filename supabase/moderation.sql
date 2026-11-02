-- Moderation for the Pipe Appreciation Portal (already applied to the nyc-pipe-types Supabase project).
-- Run after docs/supabase-pipes-setup.sql. Safe to re-run.
--
-- * Every new pipe and comment pushes a notification to the ntfy topic stored in Vault ('ntfy_topic'),
--   with the photo, an Open button and a Delete button.
-- * Delete calls the "moderate" Edge Function (supabase/functions/moderate), which calls
--   public.moderate_delete with the moderation key from Vault ('moderation_key').
-- * A nightly digest (01:00 UTC = 9pm New York in winter) sums the day's claps, pipes and comments.
-- Both secrets are generated here, inside Vault: they are not in this file or anywhere in the website.
-- To see the topic: select moderation.secret('ntfy_topic');

create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron;

do $$ begin
  if not exists (select 1 from vault.secrets where name = 'ntfy_topic') then
    perform vault.create_secret('nyc-pipes-' || encode(extensions.gen_random_bytes(9), 'hex'), 'ntfy_topic', 'ntfy.sh topic for moderation notifications');
  end if;
  if not exists (select 1 from vault.secrets where name = 'moderation_key') then
    perform vault.create_secret(encode(extensions.gen_random_bytes(24), 'hex'), 'moderation_key', 'Authorizes Delete buttons in moderation notifications');
  end if;
end $$;

create schema if not exists moderation;
revoke all on schema moderation from public, anon, authenticated;

create or replace function moderation.secret(p_name text) returns text
language sql security definer set search_path = '' stable as $$
  select decrypted_secret from vault.decrypted_secrets where name = p_name
$$;

create or replace function moderation.site_url() returns text language sql immutable set search_path = '' as $$
  select 'https://ericmrothman.github.io/nyc-pipe-types/explore.html'
$$;

-- Sends one notification. Never raises: a failed notification must never block a post.
create or replace function moderation.notify(p jsonb) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform net.http_post(
    url := 'https://ntfy.sh',
    body := p || jsonb_build_object('topic', moderation.secret('ntfy_topic')),
    headers := '{"Content-Type": "application/json"}'::jsonb
  );
exception when others then
  raise warning 'moderation notify failed: %', sqlerrm;
end $$;

create or replace function moderation.delete_action(p_kind text, p_id text) returns jsonb
language sql security definer set search_path = '' stable as $$
  select jsonb_build_object(
    'action', 'http', 'label', 'Delete', 'clear', true, 'method', 'POST',
    'url', 'https://vzkoaosxknmfebgorxut.supabase.co/functions/v1/moderate',
    'headers', jsonb_build_object('Content-Type', 'application/json'),
    'body', jsonb_build_object('kind', p_kind, 'id', p_id, 'key', moderation.secret('moderation_key'))::text
  )
$$;

create or replace function moderation.on_new_pipe() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_url text := moderation.site_url() || '?pipe=' || new.id;
begin
  perform moderation.notify(jsonb_build_object(
    'title', 'New pipe: ' || array_to_string(new.all_types, ' + ') || coalesce(' (' || new.custom_tag || ')', ''),
    'message', coalesce(nullif(left(new.note, 300), ''), '(no story)') || E'\n— ' || coalesce(nullif(new.author, ''), 'Anonymous')
               || case when new.has_exif then '' else E'\nPin placed by hand' end
               || case when new.model_url is not null then E'\nIncludes a 3D scan' else '' end,
    'tags', jsonb_build_array('droplet'),
    'click', v_url,
    'attach', regexp_replace(new.photo_url, '#poster$', ''),
    'actions', jsonb_build_array(
      jsonb_build_object('action', 'view', 'label', 'Open', 'url', v_url),
      moderation.delete_action('pipe', new.id::text))
  ));
  return new;
end $$;

create or replace function moderation.on_new_note() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_url text := moderation.site_url() || '?pipe=' || new.pipe_id;
begin
  perform moderation.notify(jsonb_build_object(
    'title', 'New comment on ' || new.pipe_id,
    'message', left(new.body, 300) || E'\n— ' || coalesce(nullif(new.author, ''), 'Anonymous'),
    'tags', jsonb_build_array('speech_balloon'),
    'click', v_url,
    'actions', jsonb_build_array(
      jsonb_build_object('action', 'view', 'label', 'Open', 'url', v_url),
      moderation.delete_action('note', new.id::text))
  ));
  return new;
end $$;

drop trigger if exists notify_new_pipe on public.pipes;
create trigger notify_new_pipe after insert on public.pipes for each row execute function moderation.on_new_pipe();
drop trigger if exists notify_new_note on public.field_notes;
create trigger notify_new_note after insert on public.field_notes for each row execute function moderation.on_new_note();

-- The Delete button's database half: only server-side code (the moderate Edge Function) may call it.
create or replace function public.moderate_delete(p_kind text, p_id text, p_key text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare n int := 0;
begin
  if p_key is null or p_key <> moderation.secret('moderation_key') then
    return jsonb_build_object('ok', false, 'error', 'bad key');
  end if;
  if p_kind = 'pipe' then
    delete from public.pipes where id::text = p_id; get diagnostics n = row_count;
  elsif p_kind = 'note' then
    delete from public.field_notes where id::text = p_id; get diagnostics n = row_count;
  else
    return jsonb_build_object('ok', false, 'error', 'unknown kind');
  end if;
  return jsonb_build_object('ok', true, 'deleted', n);
end $$;
revoke all on function public.moderate_delete(text, text, text) from public, anon, authenticated;
grant execute on function public.moderate_delete(text, text, text) to service_role;

-- The trigger helper from the base setup is never called through the API.
revoke all on function public.cleanup_deleted_pipe() from public, anon, authenticated;

-- Nightly digest: claps since yesterday's snapshot, plus new pipes and comments.
create table if not exists moderation.clap_snapshot (pipe_id text primary key, count bigint not null);
create or replace function moderation.daily_digest() returns void
language plpgsql security definer set search_path = '' as $$
declare v_claps bigint; v_top text; v_top_n bigint; v_pipes int; v_notes int;
begin
  select coalesce(sum(a.count - coalesce(s.count, 0)), 0) into v_claps
    from public.appreciations a left join moderation.clap_snapshot s using (pipe_id);
  select a.pipe_id, a.count - coalesce(s.count, 0) into v_top, v_top_n
    from public.appreciations a left join moderation.clap_snapshot s using (pipe_id)
    order by 2 desc limit 1;
  select count(*) into v_pipes from public.pipes where created_at > now() - interval '24 hours';
  select count(*) into v_notes from public.field_notes where created_at > now() - interval '24 hours';
  if v_claps > 0 or v_pipes > 0 or v_notes > 0 then
    perform moderation.notify(jsonb_build_object(
      'title', 'Pipe Portal today',
      'message', v_claps || ' claps, ' || v_pipes || ' new pipes, ' || v_notes || ' comments'
                 || case when v_top_n > 0 then E'\nMost appreciated: ' || v_top || ' (+' || v_top_n || ')' else '' end,
      'tags', jsonb_build_array('clap'),
      'priority', 2,
      'click', moderation.site_url()
    ));
  end if;
  delete from moderation.clap_snapshot;
  insert into moderation.clap_snapshot select pipe_id, count from public.appreciations;
end $$;

select cron.unschedule('pipe-portal-daily-digest') where exists (select 1 from cron.job where jobname = 'pipe-portal-daily-digest');
select cron.schedule('pipe-portal-daily-digest', '0 1 * * *', 'select moderation.daily_digest()');
