-- Inbetween v1 schema (PRD §5) + operator action queue, deliveries, RLS and Realtime.
-- Apply with: supabase db push   (or paste into the SQL editor)

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Operators (email allowlist) + helper used by every RLS policy
-- ---------------------------------------------------------------------------
create table public.operators (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  role text not null default 'operator' check (role in ('operator', 'admin')),
  created_at timestamptz not null default now()
);

create or replace function public.is_operator() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.operators o
    where lower(o.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;

create or replace function public.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at = now();
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- Clients
-- ---------------------------------------------------------------------------
create table public.clients (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  youtube_channel_id text not null,
  oauth_refresh_token_enc text,           -- AES-256-GCM, never readable by the dashboard role
  oauth_channel_title text,
  consent_at timestamptz,                 -- written consent record (PRD §6)
  config jsonb not null default '{}'::jsonb,
  delivery jsonb not null default '{"type":"none","target":""}'::jsonb,
  active boolean not null default true,
  baseline jsonb,                         -- channel EWMA baselines, warm-starts the next stream
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index clients_channel_idx on public.clients (youtube_channel_id);
create trigger clients_touch before update on public.clients for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Streams
-- ---------------------------------------------------------------------------
create table public.streams (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients (id) on delete cascade,
  platform text not null default 'youtube' check (platform in ('youtube', 'twitch', 'kick', 'replay')),
  video_id text not null,
  live_chat_id text,
  title text,
  started_at timestamptz not null,
  ended_at timestamptz,
  game text,
  status text not null default 'live' check (status in ('live', 'ended', 'error')),
  worker_host text,
  summary jsonb,
  created_at timestamptz not null default now()
);
create index streams_client_idx on public.streams (client_id, started_at desc);
create index streams_live_idx on public.streams (status) where status = 'live';

-- ---------------------------------------------------------------------------
-- Moments
-- ---------------------------------------------------------------------------
create table public.moments (
  id uuid primary key default gen_random_uuid(),
  stream_id uuid not null references public.streams (id) on delete cascade,
  client_id uuid not null references public.clients (id) on delete cascade,
  event_ts timestamptz not null,
  start_ts timestamptz not null,
  end_ts timestamptz not null,
  score real not null,
  breakdown jsonb not null default '{}'::jsonb,     -- per-signal "why"
  paid_suppressed boolean not null default false,
  vision_label text,
  transcript text,
  status text not null default 'detected'
    check (status in ('detected', 'rendering', 'proposed', 'approved', 'rejected', 'delivered', 'premium', 'failed')),
  reason text,
  label text,
  chat_sample jsonb not null default '[]'::jsonb,
  source jsonb,                                      -- {key, startTs, endTs, host} of the padded source clip
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index moments_stream_idx on public.moments (stream_id, event_ts);
create index moments_client_idx on public.moments (client_id, event_ts desc);
create index moments_status_idx on public.moments (status);
create trigger moments_touch before update on public.moments for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Clips
-- ---------------------------------------------------------------------------
create table public.clips (
  id uuid primary key default gen_random_uuid(),
  moment_id uuid references public.moments (id) on delete cascade,
  client_id uuid not null references public.clients (id) on delete cascade,
  stream_id uuid references public.streams (id) on delete set null,
  kind text not null check (kind in ('fast', 'premium', 'compilation')),
  r2_key text not null,
  thumb_key text,
  source_key text,
  titles jsonb not null default '[]'::jsonb,
  chosen_title text,
  burned_title text,
  language text not null default 'en',
  duration_s real,
  render_ms integer,
  start_ts timestamptz,
  end_ts timestamptz,
  needs_review boolean not null default false,
  created_at timestamptz not null default now()
);
create index clips_moment_idx on public.clips (moment_id, created_at desc);
create index clips_client_idx on public.clips (client_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Chat events (30-day retention; authors hashed, never raw viewer channel IDs)
-- ---------------------------------------------------------------------------
create table public.chat_events (
  id bigint generated always as identity primary key,
  stream_id uuid not null references public.streams (id) on delete cascade,
  ts timestamptz not null,
  author_hash text not null,
  text text not null,
  is_paid boolean not null default false,
  amount numeric not null default 0,
  currency text,
  kind text not null default 'text'
);
create index chat_events_stream_idx on public.chat_events (stream_id, ts);
create index chat_events_ts_idx on public.chat_events (ts);

-- ---------------------------------------------------------------------------
-- Signal samples: 1 row per stream-second, partitioned by day, 30-day retention
-- (training data for the scorer weights)
-- ---------------------------------------------------------------------------
create table public.signal_samples (
  stream_id uuid not null,
  ts timestamptz not null,
  chat_rate real,
  chat_reaction real,
  chat_caps real,
  audio_loud real,
  voice_hype real,
  vision_conf real,
  vision_label text,
  z jsonb,
  score real,
  paid_suppressed boolean not null default false,
  primary key (stream_id, ts)
) partition by range (ts);

create table public.signal_samples_default partition of public.signal_samples default;
-- Partitions are separate tables that PostgREST would expose: lock them down like the parent.
alter table public.signal_samples_default enable row level security;
revoke all on public.signal_samples_default from anon, authenticated;

create or replace function public.ensure_signal_partitions(days_ahead int default 7) returns int
language plpgsql security definer set search_path = public as $$
declare
  d date;
  created int := 0;
  part text;
begin
  for d in select generate_series(current_date - 1, current_date + days_ahead, interval '1 day')::date loop
    part := format('signal_samples_%s', to_char(d, 'YYYYMMDD'));
    if to_regclass('public.' || part) is null then
      begin
        execute format(
          'create table public.%I partition of public.signal_samples for values from (%L) to (%L)',
          part, d::timestamptz, (d + 1)::timestamptz
        );
        -- Never reachable through the REST API; operators read the parent table (RLS).
        execute format('alter table public.%I enable row level security', part);
        execute format('revoke all on public.%I from anon, authenticated', part);
        created := created + 1;
      exception when others then
        raise notice 'could not create partition %: %', part, sqlerrm;
      end;
    end if;
  end loop;
  return created;
end $$;

select public.ensure_signal_partitions(7);

-- ---------------------------------------------------------------------------
-- Cost + quota ledgers
-- ---------------------------------------------------------------------------
create table public.cost_events (
  id bigint generated always as identity primary key,
  client_id uuid references public.clients (id) on delete set null,
  stream_id uuid references public.streams (id) on delete set null,
  provider text not null,
  units numeric not null default 0,
  unit_type text not null default 'requests',
  est_cost_usd numeric(14, 6) not null default 0,
  ts timestamptz not null default now()
);
create index cost_events_stream_idx on public.cost_events (stream_id);
create index cost_events_client_ts_idx on public.cost_events (client_id, ts desc);

create table public.quota_events (
  id bigint generated always as identity primary key,
  ts timestamptz not null default now(),
  method text not null,
  units int not null,
  stream_id uuid
);
create index quota_events_ts_idx on public.quota_events (ts desc);

-- ---------------------------------------------------------------------------
-- Operator actions: the dashboard writes, workers claim (no direct dashboard→worker link)
-- ---------------------------------------------------------------------------
create table public.operator_actions (
  id uuid primary key default gen_random_uuid(),
  moment_id uuid references public.moments (id) on delete cascade,
  clip_id uuid references public.clips (id) on delete cascade,
  action text not null check (action in ('approve', 'reject', 'trim', 'title', 'premium', 'rerender', 'deliver')),
  payload jsonb not null default '{}'::jsonb,
  operator_email text,
  created_at timestamptz not null default now(),
  claimed_by text,
  claimed_at timestamptz,
  processed_at timestamptz,
  error text
);
create index operator_actions_pending_idx on public.operator_actions (created_at) where processed_at is null;

create table public.deliveries (
  id uuid primary key default gen_random_uuid(),
  clip_id uuid not null references public.clips (id) on delete cascade,
  client_id uuid not null references public.clients (id) on delete cascade,
  target_type text not null,
  status text not null check (status in ('pending', 'sent', 'failed')),
  detail text,
  created_at timestamptz not null default now()
);
create index deliveries_clip_idx on public.deliveries (clip_id);

-- ---------------------------------------------------------------------------
-- RPCs used by the worker (service role)
-- ---------------------------------------------------------------------------
create or replace function public.claim_operator_actions(p_worker text, p_limit int default 20)
returns setof public.operator_actions
language sql security definer set search_path = public as $$
  update public.operator_actions a
     set claimed_by = p_worker, claimed_at = now()
   where a.id in (
     select id from public.operator_actions
      where processed_at is null
        and (claimed_by is null or claimed_at < now() - interval '5 minutes')
      order by created_at
      limit p_limit
      for update skip locked
   )
  returning a.*;
$$;

create or replace function public.sum_quota_since(p_since timestamptz) returns bigint
language sql stable security definer set search_path = public as $$
  select coalesce(sum(units), 0)::bigint from public.quota_events where ts >= p_since;
$$;

create or replace function public.sum_cost(p_stream_id uuid default null, p_client_id uuid default null, p_since timestamptz default null)
returns numeric
language sql stable security definer set search_path = public as $$
  select coalesce(sum(est_cost_usd), 0)
    from public.cost_events
   where (p_stream_id is null or stream_id = p_stream_id)
     and (p_client_id is null or client_id = p_client_id)
     and (p_since is null or ts >= p_since);
$$;

-- Start of the current YouTube quota day (midnight America/Los_Angeles).
create or replace function public.quota_day_start() returns timestamptz
language sql stable set search_path = '' as $$
  select date_trunc('day', now() at time zone 'America/Los_Angeles') at time zone 'America/Los_Angeles';
$$;

-- Daily maintenance (called by the worker janitor; can also run from pg_cron):
-- creates upcoming partitions, drops signal_samples partitions older than 30 days,
-- deletes chat_events older than 30 days and quota_events older than 90 days.
create or replace function public.ib_maintenance() returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r record;
  dropped int := 0;
  chat_deleted bigint := 0;
  quota_deleted bigint := 0;
  sig_default_deleted bigint := 0;
begin
  perform public.ensure_signal_partitions(7);
  for r in
    select c.relname from pg_inherits i
      join pg_class c on c.oid = i.inhrelid
      join pg_class p on p.oid = i.inhparent
     where p.relname = 'signal_samples' and c.relname ~ '^signal_samples_[0-9]{8}$'
       and to_date(substring(c.relname from '[0-9]{8}$'), 'YYYYMMDD') < current_date - 30
  loop
    execute format('drop table public.%I', r.relname);
    dropped := dropped + 1;
  end loop;
  delete from public.signal_samples_default where ts < now() - interval '30 days';
  get diagnostics sig_default_deleted = row_count;
  delete from public.chat_events where ts < now() - interval '30 days';
  get diagnostics chat_deleted = row_count;
  delete from public.quota_events where ts < now() - interval '90 days';
  get diagnostics quota_deleted = row_count;
  return jsonb_build_object(
    'signal_partitions_dropped', dropped,
    'signal_default_rows', sig_default_deleted,
    'chat_events', chat_deleted,
    'quota_events', quota_deleted
  );
end $$;

-- ---------------------------------------------------------------------------
-- Dashboard views (security_invoker: RLS of the caller applies)
-- ---------------------------------------------------------------------------
create or replace view public.quota_today with (security_invoker = true) as
  select coalesce(sum(units), 0)::int as units_used,
         public.quota_day_start() as day_start
    from public.quota_events
   where ts >= public.quota_day_start();

create or replace view public.cost_by_stream with (security_invoker = true) as
  select s.id as stream_id,
         s.client_id,
         c.name as client_name,
         s.title,
         s.started_at,
         s.ended_at,
         greatest(extract(epoch from (coalesce(s.ended_at, now()) - s.started_at)) / 3600.0, 0.0167) as hours,
         coalesce(sum(ce.est_cost_usd), 0) as cost_usd
    from public.streams s
    join public.clients c on c.id = s.client_id
    left join public.cost_events ce on ce.stream_id = s.id
   group by s.id, c.name;

create or replace view public.cost_by_provider with (security_invoker = true) as
  select client_id, stream_id, provider, unit_type,
         sum(units) as units, sum(est_cost_usd) as cost_usd, count(*) as calls,
         min(ts) as first_ts, max(ts) as last_ts
    from public.cost_events
   group by client_id, stream_id, provider, unit_type;

create or replace view public.quota_by_method_today with (security_invoker = true) as
  select method, sum(units)::int as units, count(*)::int as calls
    from public.quota_events
   where ts >= public.quota_day_start()
   group by method;

-- ---------------------------------------------------------------------------
-- Row level security: operators only. The worker uses the service role (bypasses RLS).
-- ---------------------------------------------------------------------------
alter table public.operators enable row level security;
alter table public.clients enable row level security;
alter table public.streams enable row level security;
alter table public.moments enable row level security;
alter table public.clips enable row level security;
alter table public.chat_events enable row level security;
alter table public.signal_samples enable row level security;
alter table public.cost_events enable row level security;
alter table public.quota_events enable row level security;
alter table public.operator_actions enable row level security;
alter table public.deliveries enable row level security;

create policy operators_read on public.operators for select to authenticated using (public.is_operator());
create policy clients_rw on public.clients for all to authenticated using (public.is_operator()) with check (public.is_operator());
create policy streams_read on public.streams for select to authenticated using (public.is_operator());
create policy moments_read on public.moments for select to authenticated using (public.is_operator());
create policy clips_read on public.clips for select to authenticated using (public.is_operator());
create policy chat_read on public.chat_events for select to authenticated using (public.is_operator());
create policy signals_read on public.signal_samples for select to authenticated using (public.is_operator());
create policy cost_read on public.cost_events for select to authenticated using (public.is_operator());
create policy quota_read on public.quota_events for select to authenticated using (public.is_operator());
create policy actions_read on public.operator_actions for select to authenticated using (public.is_operator());
create policy actions_insert on public.operator_actions for insert to authenticated
  with check (public.is_operator() and processed_at is null and claimed_by is null);
create policy deliveries_read on public.deliveries for select to authenticated using (public.is_operator());

-- The encrypted OAuth token is never exposed to browser roles (column privileges).
revoke all on public.clients from anon, authenticated;
grant select (id, name, youtube_channel_id, oauth_channel_title, consent_at, config, delivery, active, created_at, updated_at)
  on public.clients to authenticated;
grant insert (name, youtube_channel_id, config, delivery, active) on public.clients to authenticated;
grant update (name, youtube_channel_id, config, delivery, active) on public.clients to authenticated;

revoke all on public.operator_actions from anon;
revoke execute on function public.claim_operator_actions(text, int) from public, anon, authenticated;
revoke execute on function public.ib_maintenance() from public, anon, authenticated;
revoke execute on function public.ensure_signal_partitions(int) from public, anon, authenticated;
revoke execute on function public.sum_quota_since(timestamptz) from public, anon, authenticated;
revoke execute on function public.sum_cost(uuid, uuid, timestamptz) from public, anon, authenticated;
revoke execute on function public.touch_updated_at() from public, anon, authenticated;
revoke execute on function public.is_operator() from public, anon;
grant execute on function public.is_operator() to authenticated;

-- ---------------------------------------------------------------------------
-- Realtime: live board + worker action nudges
-- ---------------------------------------------------------------------------
alter publication supabase_realtime add table public.moments, public.clips, public.streams, public.operator_actions;
